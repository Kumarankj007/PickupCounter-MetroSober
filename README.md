# Pickup Counter

A local-first self-service snack counter demo built with **TypeScript, Express, PostgreSQL, React + Vite, Vitest/Supertest, and k6**. It intentionally runs natively on your machine; Docker is not required.

## What is implemented

- Five seeded products. Prices and order totals are integer paise; rupees are only formatting in the browser.
- `GET /products` returns dynamically available stock.
- `POST /orders` reserves all requested products or none, with a 120-second hold.
- PostgreSQL row locks serialize stock decisions and ensure ten competing requests cannot reserve the last two units more than twice.
- `POST /payments/webhook` verifies HMAC-SHA256 over the raw bytes, detects event-ID replay, checks the exact paise total, and handles late captures.
- `GET /orders/:id` changes an expired pending order to `expired` when the order is next queried.
- `POST /orders/:id/pickup-claim` claims a paid order exactly once and decrements physical stock in the same transaction.
- React product catalog/cart/checkout, order status polling, simulated-payment instructions, and a countdown based on the browser's monotonic `performance.now()` clock.
- Real-PostgreSQL integration tests for oversell prevention, duplicate webhook handling, two simultaneous pickup claims, signature rejection, and amount mismatch.
- k6 script with three concurrent scenarios and exact count thresholds.

## Architecture and decisions

### Stock model

`products.stock` represents the physical units still in the counter/lockers, including units allocated to a paid order that has not yet been picked up. **Available units** are:

`stock - active pending-payment reservations - paid-but-not-yet-claimed allocations`

A pending reservation counts only when `expires_at > clock_timestamp()`. A paid order continues reserving units until its locker claim succeeds. When a claim succeeds, the transaction decreases `products.stock` and changes the order from `paid` to `claimed`; the allocation then stops counting. This keeps availability stable across pickup and avoids selling one unit twice while it waits in a locker.

All stock-affecting decisions first lock requested product rows in UUID order with `SELECT ... FOR UPDATE`. The webhook's late-payment path and pickup path lock the same product rows before making stock decisions. Transactions use PostgreSQL's normal `READ COMMITTED` isolation; the row locks serialize the critical inventory paths.

### Reservation expiry

A reservation expires according to PostgreSQL time, not the kiosk's wall clock. Catalog availability stops counting it after 120 seconds. The order's visible status is changed to `expired` lazily when `GET /orders/:id` is called after expiration or when a webhook arrives. There is no cron worker, so a never-queried expired order can remain stored as `pending_payment`, but it does **not** continue to reserve stock because every reservation query checks `expires_at`.

The create-order response asks PostgreSQL for `expiresInSeconds` just before sending the response. The browser initializes its timer from that duration and measures elapsed time using `performance.now()`; it does not compare the kiosk's `Date.now()` to a server timestamp.

### Payment webhook

The webhook handler must run before `express.json()` so it can verify the exact raw request bytes. `X-Signature` is the hex HMAC-SHA256 with `WEBHOOK_SECRET`; comparisons use `timingSafeEqual`. The unique `processed_webhook_events.event_id` and order state transition are committed in the same transaction. Replays with the same ID and same semantic payload return HTTP 200 without reapplying the event. Reusing an event ID for a different payload returns 409.

A total mismatch marks the order `needs_review` and does not mark it paid. This releases the reservation, because the payment must be reconciled/refunded manually rather than allowing an uncertain order to keep stock indefinitely.

### Late payment decision

If a correctly signed capture arrives after expiration, the server locks all product rows involved and checks the available quantity again. If all of the units can still be allocated, the order moves to `paid` and its stock allocation remains reserved until pickup. If any product no longer has enough units, the order moves to `needs_review`; the assumed operational action is a manual refund or staff resolution. The app never creates negative stock to fulfill a late capture.

This is a deliberately small demo, not a complete payment ledger. In production, I would persist payment attempts/captures independently, reconcile provider events, record refund state, and alert staff instead of using the single order status to represent every financial exception.

### Pickup

A locker claim opens a transaction, locks the order row, checks that the status is exactly `paid`, locks its product rows, decrements physical stock with a `stock >= quantity` guard, and marks the order `claimed` before commit. The second simultaneous claim sees `claimed` and receives 409. Unpaid, expired, and `needs_review` orders cannot be claimed.

## Prerequisites

- Node.js 20 or newer (Node 20+ provides native `fetch` for the webhook CLI)
- npm 10 or newer
- PostgreSQL 14 or newer, running locally on port 5432 by default
- k6 only if you want to run the additional load/concurrency test (`k6` is not needed for the app or Vitest tests)

## Local setup on Ubuntu

### 1. Create a PostgreSQL database

If PostgreSQL is already installed, create a user and database. Open the PostgreSQL shell:

```bash
sudo -u postgres psql
```

Then run (replace the password with your own):

```sql
CREATE USER pickup_user WITH PASSWORD 'replace-this-password';
CREATE DATABASE pickup_counter OWNER pickup_user;
\q
```

If you already have a local database/user, use those details instead. Ensure the user can connect over `localhost` using the password in your connection URL.

### 2. Configure the environment

From the project root:

```bash
cp .env.example .env
```

Edit `.env` to match your PostgreSQL username/password, database and port:

```dotenv
DATABASE_URL=postgres://pickup_user:replace-this-password@localhost:5432/pickup_counter
PORT=3000
WEBHOOK_SECRET=replace-with-a-long-random-local-secret
```

The secret must be the same for the API, CLI script and k6 environment. Keep `.env` private; it is in `.gitignore`.

### 3. Install dependencies and initialize PostgreSQL

```bash
npm install
npm run db:setup
```

The setup command creates the schema/indexes and seeds the five starter products. Seed insertion is idempotent by product ID; it will not reset existing stock. If you need a clean assignment/demo state, use a test database and reset it deliberately.

### 4. Start backend and frontend

In one terminal at the project root:

```bash
npm run dev
```

Open:

- Customer app: <http://localhost:5173>
- API health: <http://localhost:3000/health>
- Product API: <http://localhost:3000/products>

The app runs both processes from the single `npm run dev` command. Stop with Ctrl+C.

## Try a simulated payment

1. Use the customer screen to place an order. The order card shows the order reference and total.
2. Click **Get signed payment simulation command**. Copy the command and run it in another terminal at the project root. Example:

   ```bash
   npm run send-webhook -- --orderId 00000000-0000-4000-8000-000000000000 --amount 4500 --eventId evt_demo_001
   ```

   Replace the example UUID and amount with the actual order ID and displayed total in **paise**. For example, ₹45.00 is `4500` paise. The command signs the exact JSON body and calls the local webhook.
3. The order screen polls the order endpoint. Once paid, click **Claim from locker**. The API returns a 200 and changes the order to `claimed`. A second claim returns 409.

No real UPI payment is performed or money moved; the signed CLI call represents the simulated provider webhook.

Useful API shapes:

```http
GET /products
POST /orders
Content-Type: application/json

[{"productId":"00000000-0000-4000-8000-000000000001","quantity":1}]
```

```http
POST /payments/webhook
Content-Type: application/json
X-Signature: <hex HMAC-SHA256>

{"eventId":"evt_123","orderId":"<order-uuid>","amountPaise":4500,"status":"captured"}
```

```http
GET /orders/:id
POST /orders/:id/pickup-claim
```

## Automated tests against a real PostgreSQL database

These are integration tests, not database mocks. Point `DATABASE_URL` at a disposable local test database. The test suite truncates the tables and reseeds products before each test; **do not point it at a database with data you need to keep**.

```bash
npm run test:integration
```

The tests prove:

1. Ten simultaneous HTTP requests competing for two Trail Mix Packs produce exactly two 201 responses and eight clear `INSUFFICIENT_STOCK` responses.
2. Five simultaneous copies of the same correctly signed event return 200, insert one event record, and transition the order only once.
3. Two simultaneous pickup claims produce one 200 and one 409, with stock decremented exactly once.
4. Invalid webhook signatures do not change state, and amount mismatches become `needs_review`.

## k6 concurrency/load verification

Install k6 from the official Grafana k6 installation instructions for your OS. Start the app first, then reset a **disposable local database** to known fixture stock. The reset command is destructive: it deletes all orders and webhook-event rows and re-seeds the products.

Terminal 1:

```bash
npm run db:reset:k6
npm run dev
```

Terminal 2:

```bash
npm run k6:test
```

Or supply a custom API URL and secret:

```bash
BASE_URL=http://localhost:3000 WEBHOOK_SECRET='replace-with-a-long-random-local-secret' npm run k6:test
```

The k6 script runs three concurrent scenarios: 10 requests for the last 2 units (expects exactly 2 wins and 8 clean failures), 5 copies of one webhook event (all HTTP 200 and exactly one response says it processed the event), and 2 claims for a paid order (one 200 and one 409). Thresholds cause the k6 run to fail if the counts are not exact. The seed/reset step ensures the first product starts with two units; do not run against a database that is serving real orders.

## Build check

```bash
npm run build
```

## Assumptions and limitations

- No user login/authentication is required for this exercise; anyone with an order UUID can retrieve its state. Do not deploy this demo publicly as-is.
- The locker is represented by the pickup endpoint; there is no physical locker integration.
- A single order can contain each product only once after duplicate cart lines are combined.
- `needs_review` means payment/staff reconciliation is required. This sample records the webhook and order status but does not implement refunds.
- The payment webhook only accepts the `captured` event shape from the assignment.
- Expired status is updated lazily on order retrieval/webhook, while stock availability itself uses expiry timestamps and does not require a background worker.
- CORS is permissive for local development; production should restrict origins, authenticate locker calls, rate-limit endpoints and redact logs.

## What I would do next with more time

1. Add a payment-attempt/capture/refund ledger and reconciliation worker/outbox for reliable provider event handling.
2. Add authentication/authorization for staff and locker devices, API rate limits, structured logging and metrics.
3. Add a scheduled expiry worker for operational visibility (availability correctness does not depend on it).
4. Add property-based and higher-duration soak tests, plus `EXPLAIN (ANALYZE, BUFFERS)` for catalog queries under larger product/order volumes.
5. Add accessibility/e2e tests for the kiosk screen and design a production deployment with secrets management and restricted network access.
