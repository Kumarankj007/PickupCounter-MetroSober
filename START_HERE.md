# Start Here — Pickup Counter

Follow this once from a clean checkout. Commands are for Ubuntu/Linux and assume PostgreSQL is installed locally.

## 1. Extract and enter the project

```bash
unzip pickup-counter.zip
cd pickup-counter
node --version   # Node 20+ recommended
npm --version
```

## 2. Prepare PostgreSQL

Start/check PostgreSQL:

```bash
sudo systemctl status postgresql
```

Create a local application role and database if you do not already have one:

```bash
sudo -u postgres psql
```

```sql
CREATE USER pickup_user WITH PASSWORD 'change-this-password';
CREATE DATABASE pickup_counter OWNER pickup_user;
\q
```

Copy the environment template and edit it:

```bash
cp .env.example .env
nano .env
```

Use the same local DB credentials you created:

```dotenv
DATABASE_URL=postgres://pickup_user:change-this-password@localhost:5432/pickup_counter
PORT=3000
WEBHOOK_SECRET=replace-with-a-long-random-local-secret
```

Confirm that your database accepts connections (this command will prompt for the DB password):

```bash
psql -h localhost -U pickup_user -d pickup_counter -c 'SELECT 1;'
```

## 3. Install, create tables, and seed products

Run once after extracting, and again after changing package dependencies:

```bash
npm install
npm run db:setup
```

Expected setup output: `Database schema is ready and seed products are present.`

## 4. Start the app

```bash
npm run dev
```

Keep this terminal running. Open **http://localhost:5173** in your browser. The API health endpoint is **http://localhost:3000/health**.

## 5. Try the complete order flow

1. Add one or more products and click **Reserve & continue**.
2. Note the order reference and total amount in paise.
3. Click **Get signed payment simulation command**. Run the copied command in a second terminal at the project root.
4. The UI polls the order status. After payment is confirmed, click **Claim from locker**.
5. For the duplicate-claim behavior, issue the same pickup API call again; the second call should return HTTP 409.

There is no actual UPI provider and the CLI script does not transfer money. It creates a correctly signed fake capture event for local testing.

## 6. Run the PostgreSQL-backed tests

**Warning:** these tests truncate the tables before each test. Use only a disposable assignment database.

```bash
npm run test:integration
```

## 7. Run k6 concurrency scenarios (optional but recommended)

Install k6 separately. Then use two terminals.

Terminal 1 (reset is destructive; keep it local):

```bash
npm run db:reset:k6
npm run dev
```

Terminal 2:

```bash
npm run k6:test
```

## 8. Final checks before sharing the repository

```bash
npm run build
npm run test:integration
```

If k6 is installed, also run `npm run k6:test` after resetting the disposable DB. Do not claim a check passed unless it completed successfully on your machine. Review `README.md` and `AI_NOTES.md`, and replace any local secret/password before sharing. Do not include your `.env` file in the public repository.

## Common issues

- **`ECONNREFUSED localhost:5432`**: PostgreSQL is not running, or the port/host in `DATABASE_URL` is wrong. Check `sudo systemctl status postgresql`.
- **`password authentication failed`**: the role/password in `.env` do not match PostgreSQL. Update `.env`; URL-encode special characters in a password if required.
- **`relation products does not exist`**: run `npm run db:setup`.
- **`Invalid webhook signature`**: start the API using the same `.env` secret used by the CLI. Prefer the provided `npm run send-webhook` command to avoid signing different JSON bytes.
- **`k6: command not found`**: k6 is a separate optional tool, not an npm dependency. Install it before running `npm run k6:test`.
- **Port 3000 or 5173 is occupied**: stop the other process or change the relevant backend `PORT` / Vite server port. If changing the API port, also set `VITE_API_BASE_URL` in `frontend/.env.local`.
