import crypto from 'node:crypto';
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type { Pool, PoolClient } from 'pg';
import { config } from './config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOLD_SECONDS = 120;

type OrderItemInput = { productId: string; quantity: number };
type OrderStatus = 'pending_payment' | 'paid' | 'expired' | 'needs_review' | 'claimed';

class ApiError extends Error {
  constructor(public statusCode: number, message: string, public code = 'REQUEST_FAILED') {
    super(message);
    this.name = 'ApiError';
  }
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function parseItems(body: unknown): OrderItemInput[] {
  const rawItems: unknown = Array.isArray(body) ? body : (body && typeof body === 'object' ? (body as { items?: unknown }).items : undefined);
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 50) {
    throw new ApiError(400, 'Send a non-empty list of items (maximum 50 distinct products).', 'INVALID_ITEMS');
  }

  const quantities = new Map<string, number>();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') throw new ApiError(400, 'Each item must contain productId and quantity.', 'INVALID_ITEM');
    const item = raw as { productId?: unknown; quantity?: unknown };
    if (!isUuid(item.productId)) throw new ApiError(400, 'Each productId must be a valid UUID.', 'INVALID_PRODUCT_ID');
    if (!Number.isSafeInteger(item.quantity) || Number(item.quantity) <= 0 || Number(item.quantity) > 1000) {
      throw new ApiError(400, 'Each quantity must be an integer between 1 and 1000.', 'INVALID_QUANTITY');
    }
    const next = (quantities.get(item.productId) ?? 0) + Number(item.quantity);
    if (next > 1000) throw new ApiError(400, 'Combined quantity for one product cannot exceed 1000.', 'INVALID_QUANTITY');
    quantities.set(item.productId, next);
  }
  return [...quantities.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

function signWebhookBody(rawBody: Buffer, secret = config.webhookSecret): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function validSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !/^[a-f0-9]{64}$/i.test(header)) return false;
  const expected = Buffer.from(signWebhookBody(rawBody), 'hex');
  const received = Buffer.from(header, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function payloadHash(payload: { eventId: string; orderId: string; amountPaise: number; status: string }): string {
  // Canonical property order makes semantically identical JSON retries idempotent despite whitespace.
  const canonical = JSON.stringify({
    eventId: payload.eventId,
    orderId: payload.orderId,
    amountPaise: payload.amountPaise,
    status: payload.status,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function getAvailableRows(client: PoolClient, productIds: string[]) {
  return client.query<{
    id: string; name: string; price_paise: number; stock: number; reserved_units: number;
  }>(
    `SELECT p.id, p.name, p.price_paise, p.stock,
       COALESCE(SUM(oi.quantity) FILTER (
         WHERE o.status = 'paid'
            OR (o.status = 'pending_payment' AND o.expires_at > clock_timestamp())
       ), 0)::int AS reserved_units
     FROM products p
     LEFT JOIN order_items oi ON oi.product_id = p.id
     LEFT JOIN orders o ON o.id = oi.order_id
     WHERE p.id = ANY($1::uuid[])
     GROUP BY p.id, p.name, p.price_paise, p.stock
     ORDER BY p.id`,
    [productIds],
  );
}

export function createApp(db: Pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, database: 'connected' });
    } catch {
      res.status(503).json({ ok: false, database: 'unavailable' });
    }
  });

  app.get('/products', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await db.query(
        `SELECT p.id, p.name, p.price_paise AS "pricePaise", p.stock,
          GREATEST(p.stock - COALESCE(r.reserved_units, 0), 0)::int AS "availableUnits"
         FROM products p
         LEFT JOIN (
           SELECT oi.product_id, SUM(oi.quantity)::int AS reserved_units
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE o.status = 'paid'
              OR (o.status = 'pending_payment' AND o.expires_at > statement_timestamp())
           GROUP BY oi.product_id
         ) r ON r.product_id = p.id
         ORDER BY p.name ASC`,
      );
      res.json(result.rows);
    } catch (error) { next(error); }
  });

  app.post('/orders', express.json({ limit: '256kb' }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = parseItems(req.body);
      const order = await inTransaction(db, async (client) => {
        const productIds = items.map((item) => item.productId).sort();
        // Every reservation path locks product rows in UUID order to serialize stock decisions.
        const locked = await client.query<{ id: string }>(
          'SELECT id FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [productIds],
        );
        if (locked.rowCount !== productIds.length) {
          throw new ApiError(400, 'One or more products do not exist.', 'PRODUCT_NOT_FOUND');
        }

        const productsResult = await getAvailableRows(client, productIds);
        const products = new Map(productsResult.rows.map((row) => [row.id, row] as const));
        for (const item of items) {
          const product = products.get(item.productId);
          if (!product) throw new ApiError(400, `Product ${item.productId} was not found.`, 'PRODUCT_NOT_FOUND');
          const availableUnits = Math.max(0, product.stock - product.reserved_units);
          if (availableUnits < item.quantity) {
            throw new ApiError(400, `Not enough stock for ${product.name}. Available: ${availableUnits}, requested: ${item.quantity}.`, 'INSUFFICIENT_STOCK');
          }
        }

        let totalPaise = 0n;
        for (const item of items) {
          const product = products.get(item.productId)!;
          totalPaise += BigInt(product.price_paise) * BigInt(item.quantity);
        }
        if (totalPaise > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ApiError(400, 'Order total is too large.', 'TOTAL_TOO_LARGE');
        }
        const inserted = await client.query<{ id: string; status: OrderStatus; total_paise: string; expires_at: Date }>(
          `INSERT INTO orders (status, total_paise, expires_at)
           VALUES ('pending_payment', $1, clock_timestamp() + ($2 * INTERVAL '1 second'))
           RETURNING id, status, total_paise, expires_at`,
          [totalPaise.toString(), HOLD_SECONDS],
        );
        const row = inserted.rows[0]!;
        for (const item of items) {
          const product = products.get(item.productId)!;
          await client.query(
            'INSERT INTO order_items (order_id, product_id, quantity, unit_price_paise) VALUES ($1, $2, $3, $4)',
            [row.id, item.productId, item.quantity, product.price_paise],
          );
        }
        const expiry = await client.query<{ seconds_left: string }>(
          'SELECT GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())))::text AS seconds_left',
          [row.expires_at],
        );
        return {
          id: row.id,
          status: row.status,
          totalPaise: Number(row.total_paise),
          expiresAt: row.expires_at,
          expiresInSeconds: Math.max(0, Number(expiry.rows[0]?.seconds_left ?? HOLD_SECONDS)),
          items: items.map((item) => {
            const p = products.get(item.productId)!;
            return { productId: p.id, name: p.name, quantity: item.quantity, unitPricePaise: p.price_paise };
          }),
        };
      });
      // Re-read remaining TTL after COMMIT, immediately before response dispatch.
      const ttl = await db.query<{ seconds_left: string }>(
        'SELECT GREATEST(0, EXTRACT(EPOCH FROM (expires_at - clock_timestamp())))::text AS seconds_left FROM orders WHERE id = $1',
        [order.id],
      );
      order.expiresInSeconds = Math.max(0, Number(ttl.rows[0]?.seconds_left ?? 0));
      res.status(201).json(order);
    } catch (error) { next(error); }
  });

  app.get('/orders/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isUuid(req.params.id)) throw new ApiError(400, 'Order ID must be a valid UUID.', 'INVALID_ORDER_ID');
      await db.query(
        `UPDATE orders SET status = 'expired', updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'pending_payment' AND expires_at <= clock_timestamp()`,
        [req.params.id],
      );
      const orderResult = await db.query<{
        id: string; status: OrderStatus; total_paise: string; expires_at: Date; expires_in_seconds: string;
      }>(
        `SELECT id, status, total_paise, expires_at,
          GREATEST(0, EXTRACT(EPOCH FROM (expires_at - clock_timestamp())))::text AS expires_in_seconds
         FROM orders WHERE id = $1`, [req.params.id],
      );
      const order = orderResult.rows[0];
      if (!order) throw new ApiError(404, 'Order not found.', 'ORDER_NOT_FOUND');
      const itemRows = await db.query(
        `SELECT oi.product_id AS "productId", p.name, oi.quantity,
          oi.unit_price_paise AS "unitPricePaise"
         FROM order_items oi JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1 ORDER BY p.name`, [order.id],
      );
      res.json({
        id: order.id,
        status: order.status,
        totalPaise: Number(order.total_paise),
        expiresAt: order.expires_at,
        expiresInSeconds: Math.max(0, Number(order.expires_in_seconds)),
        items: itemRows.rows,
      });
    } catch (error) { next(error); }
  });

  // This route must precede express.json(): the signature covers the exact raw byte sequence.
  app.post('/payments/webhook', express.raw({ type: 'application/json', limit: '64kb' }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new ApiError(400, 'Expected an application/json raw request body.', 'INVALID_BODY');
      const rawBody = req.body as Buffer;
      const signature = req.header('X-Signature');
      if (!validSignature(rawBody, signature)) throw new ApiError(401, 'Invalid webhook signature.', 'INVALID_SIGNATURE');

      let payload: unknown;
      try { payload = JSON.parse(rawBody.toString('utf8')); } catch {
        throw new ApiError(400, 'Webhook body must be valid JSON.', 'INVALID_JSON');
      }
      if (!payload || typeof payload !== 'object') throw new ApiError(400, 'Invalid webhook payload.', 'INVALID_PAYLOAD');
      const event = payload as { eventId?: unknown; orderId?: unknown; amountPaise?: unknown; status?: unknown };
      if (typeof event.eventId !== 'string' || event.eventId.length < 1 || event.eventId.length > 200) {
        throw new ApiError(400, 'eventId must be a string of 1 to 200 characters.', 'INVALID_EVENT_ID');
      }
      if (!isUuid(event.orderId)) throw new ApiError(400, 'orderId must be a valid UUID.', 'INVALID_ORDER_ID');
      if (!Number.isSafeInteger(event.amountPaise) || Number(event.amountPaise) < 0) {
        throw new ApiError(400, 'amountPaise must be a non-negative safe integer.', 'INVALID_AMOUNT');
      }
      if (event.status !== 'captured') throw new ApiError(400, 'Only captured webhook events are supported.', 'INVALID_PAYMENT_STATUS');
      const normalized = { eventId: event.eventId, orderId: event.orderId, amountPaise: Number(event.amountPaise), status: 'captured' };
      const hash = payloadHash(normalized);

      const outcome = await inTransaction(db, async (client) => {
        const orderResult = await client.query<{
          id: string; status: OrderStatus; total_paise: string; expires_at: Date;
        }>('SELECT id, status, total_paise, expires_at FROM orders WHERE id = $1 FOR UPDATE', [normalized.orderId]);
        const order = orderResult.rows[0];
        if (!order) throw new ApiError(404, 'Order not found.', 'ORDER_NOT_FOUND');

        const eventInsert = await client.query(
          `INSERT INTO processed_webhook_events (event_id, order_id, payload_hash)
           VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
          [normalized.eventId, normalized.orderId, hash],
        );
        if (eventInsert.rowCount === 0) {
          const previous = await client.query<{ payload_hash: string }>(
            'SELECT payload_hash FROM processed_webhook_events WHERE event_id = $1', [normalized.eventId],
          );
          if (previous.rows[0]?.payload_hash !== hash) {
            throw new ApiError(409, 'eventId has already been used with a different payload.', 'EVENT_ID_REUSED');
          }
          return { duplicate: true, status: order.status };
        }

        // A different event cannot replay a state transition already completed for this order.
        if (order.status === 'paid' || order.status === 'claimed' || order.status === 'needs_review') {
          return { duplicate: false, status: order.status };
        }

        if (Number(order.total_paise) !== normalized.amountPaise) {
          await client.query("UPDATE orders SET status = 'needs_review', updated_at = clock_timestamp() WHERE id = $1", [order.id]);
          return { duplicate: false, status: 'needs_review' as OrderStatus };
        }

        const holdCheck = await client.query<{ is_in_hold: boolean }>(
          'SELECT expires_at > clock_timestamp() AS is_in_hold FROM orders WHERE id = $1', [order.id],
        );
        const isInHold = order.status === 'pending_payment' && holdCheck.rows[0]?.is_in_hold === true;
        if (isInHold) {
          await client.query("UPDATE orders SET status = 'paid', updated_at = clock_timestamp() WHERE id = $1", [order.id]);
          return { duplicate: false, status: 'paid' as OrderStatus };
        }

        // Late capture: lock products before checking availability. The expired order is not
        // counted as a reservation. A paid order remains reserved until its locker claim commits.
        const itemRows = await client.query<{ product_id: string; quantity: number }>(
          'SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id', [order.id],
        );
        const productIds = itemRows.rows.map((row) => row.product_id).sort();
        await client.query('SELECT id FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [productIds]);
        const availability = await getAvailableRows(client, productIds);
        const byId = new Map(availability.rows.map((row) => [row.id, row] as const));
        const canReacquire = itemRows.rows.every((item) => {
          const product = byId.get(item.product_id);
          return Boolean(product && product.stock - product.reserved_units >= item.quantity);
        });
        const nextStatus: OrderStatus = canReacquire ? 'paid' : 'needs_review';
        await client.query(
          `UPDATE orders SET status = $2,
             expires_at = CASE WHEN $2 = 'paid' THEN GREATEST(expires_at, clock_timestamp() + ($3 * INTERVAL '1 second')) ELSE expires_at END,
             updated_at = clock_timestamp()
           WHERE id = $1`,
          [order.id, nextStatus, HOLD_SECONDS],
        );
        return { duplicate: false, status: nextStatus };
      });

      res.status(200).json({ received: true, duplicate: outcome.duplicate, status: outcome.status });
    } catch (error) { next(error); }
  });

  app.post('/orders/:id/pickup-claim', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = req.params.id;
      if (!isUuid(orderId)) throw new ApiError(400, 'Order ID must be a valid UUID.', 'INVALID_ORDER_ID');
      const claimed = await inTransaction(db, async (client) => {
        const orderResult = await client.query<{ id: string; status: OrderStatus }>(
          'SELECT id, status FROM orders WHERE id = $1 FOR UPDATE', [orderId],
        );
        const order = orderResult.rows[0];
        if (!order) throw new ApiError(404, 'Order not found.', 'ORDER_NOT_FOUND');
        if (order.status !== 'paid') throw new ApiError(409, `Order cannot be claimed from status '${order.status}'.`, 'ORDER_NOT_CLAIMABLE');

        const itemRows = await client.query<{ product_id: string; quantity: number }>(
          'SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id', [orderId],
        );
        const productIds = itemRows.rows.map((row) => row.product_id).sort();
        await client.query('SELECT id FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [productIds]);

        // Decrement physical stock and change the order out of the reserved state atomically.
        for (const item of itemRows.rows) {
          const update = await client.query(
            'UPDATE products SET stock = stock - $2, updated_at = clock_timestamp() WHERE id = $1 AND stock >= $2 RETURNING id',
            [item.product_id, item.quantity],
          );
          if (update.rowCount !== 1) throw new Error(`Inventory invariant violated for product ${item.product_id}`);
        }
        const result = await client.query<{ id: string; status: OrderStatus; updated_at: Date }>(
          "UPDATE orders SET status = 'claimed', updated_at = clock_timestamp() WHERE id = $1 AND status = 'paid' RETURNING id, status, updated_at",
          [orderId],
        );
        if (result.rowCount !== 1) throw new ApiError(409, 'Order was claimed by another locker.', 'ALREADY_CLAIMED');
        return result.rows[0]!;
      });
      res.status(200).json({ id: claimed.id, status: claimed.status, claimedAt: claimed.updated_at, message: 'Pickup claim successful.' });
    } catch (error) { next(error); }
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    const pgError = error as { code?: string; message?: string };
    if (pgError?.code === '22P02') {
      res.status(400).json({ error: 'Invalid identifier or value.', code: 'INVALID_VALUE' });
      return;
    }
    if (pgError?.code === '23503') {
      res.status(400).json({ error: 'Referenced product or order does not exist.', code: 'REFERENCE_NOT_FOUND' });
      return;
    }
    console.error('Unhandled request error:', error);
    res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
  };
  app.use(errorHandler);
  return app;
}

export { signWebhookBody };
