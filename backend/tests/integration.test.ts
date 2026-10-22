import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = await readFile(resolve(here, '../src/db/schema.sql'), 'utf8');
const seed = await readFile(resolve(here, '../src/db/seed.sql'), 'utf8');
const app = createApp(pool);
const IDS = {
  trailMix: '00000000-0000-4000-8000-000000000001',
  potatoChips: '00000000-0000-4000-8000-000000000002',
  chocolate: '00000000-0000-4000-8000-000000000003',
  granola: '00000000-0000-4000-8000-000000000004',
  water: '00000000-0000-4000-8000-000000000005',
};

async function resetDatabase() {
  await pool.query(schema);
  await pool.query('TRUNCATE TABLE processed_webhook_events, order_items, orders, products CASCADE');
  await pool.query(seed);
}

async function makeOrder(productId: string, quantity = 1) {
  const response = await request(app).post('/orders').send([{ productId, quantity }]);
  expect(response.status).toBe(201);
  return response.body as { id: string; totalPaise: number; status: string; expiresInSeconds: number };
}

async function sendCapture(order: { id: string; totalPaise: number }, overrides: Partial<{ eventId: string; amountPaise: number }> = {}) {
  const payload = {
    eventId: overrides.eventId ?? `evt_${crypto.randomUUID()}`,
    orderId: order.id,
    amountPaise: overrides.amountPaise ?? order.totalPaise,
    status: 'captured',
  };
  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
  return request(app).post('/payments/webhook').set('content-type', 'application/json').set('X-Signature', signature).send(raw);
}

beforeAll(async () => {
  await pool.query('SELECT 1');
  await resetDatabase();
});
beforeEach(async () => resetDatabase());
afterAll(async () => { await pool.end(); });

describe('Pickup Counter PostgreSQL integration and concurrency guarantees', () => {
  it('allows exactly two of ten simultaneous customers to reserve the final two units', async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () =>
      request(app).post('/orders').send([{ productId: IDS.trailMix, quantity: 1 }]),
    ));

    const successes = responses.filter((response) => response.status === 201);
    const failures = responses.filter((response) => response.status === 400);
    expect(successes).toHaveLength(2);
    expect(failures).toHaveLength(8);
    expect(failures.every((response) => response.body.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(responses.every((response) => [201, 400].includes(response.status))).toBe(true);

    const catalog = await request(app).get('/products');
    expect(catalog.status).toBe(200);
    expect(catalog.body.find((product: { id: string }) => product.id === IDS.trailMix).availableUnits).toBe(0);
    const held = await pool.query("SELECT COALESCE(SUM(oi.quantity), 0)::int AS quantity FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = $1 AND o.status = 'pending_payment' AND o.expires_at > clock_timestamp()", [IDS.trailMix]);
    expect(held.rows[0].quantity).toBe(2);
  });

  it('processes the same signed webhook event once even when duplicate copies arrive together', async () => {
    const order = await makeOrder(IDS.chocolate);
    const eventId = 'evt_duplicate_test_001';
    const responses = await Promise.all(Array.from({ length: 5 }, () => sendCapture(order, { eventId })));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.filter((response) => response.body.duplicate === false)).toHaveLength(1);
    expect(responses.filter((response) => response.body.duplicate === true)).toHaveLength(4);
    const orderState = await request(app).get(`/orders/${order.id}`);
    expect(orderState.body.status).toBe('paid');
    const eventCount = await pool.query('SELECT COUNT(*)::int AS count FROM processed_webhook_events WHERE event_id = $1', [eventId]);
    expect(eventCount.rows[0].count).toBe(1);
  });

  it('allows exactly one of two simultaneous paid-order pickup claims and decrements stock once', async () => {
    const order = await makeOrder(IDS.granola);
    const payment = await sendCapture(order);
    expect(payment.status).toBe(200);
    expect(payment.body.status).toBe('paid');

    const responses = await Promise.all([
      request(app).post(`/orders/${order.id}/pickup-claim`),
      request(app).post(`/orders/${order.id}/pickup-claim`),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    const product = await pool.query('SELECT stock FROM products WHERE id = $1', [IDS.granola]);
    expect(product.rows[0].stock).toBe(19);
    const finalOrder = await request(app).get(`/orders/${order.id}`);
    expect(finalOrder.body.status).toBe('claimed');
  });

  it('rejects invalid HMAC signatures without recording an event', async () => {
    const order = await makeOrder(IDS.water);
    const raw = JSON.stringify({ eventId: 'evt_bad_sig', orderId: order.id, amountPaise: order.totalPaise, status: 'captured' });
    const response = await request(app).post('/payments/webhook').set('content-type', 'application/json').set('X-Signature', '0'.repeat(64)).send(raw);
    expect(response.status).toBe(401);
    const events = await pool.query("SELECT COUNT(*)::int AS count FROM processed_webhook_events WHERE event_id = 'evt_bad_sig'");
    expect(events.rows[0].count).toBe(0);
    expect((await request(app).get(`/orders/${order.id}`)).body.status).toBe('pending_payment');
  });

  it('marks a capture with the wrong integer-paise amount as needs_review', async () => {
    const order = await makeOrder(IDS.water);
    const payment = await sendCapture(order, { amountPaise: order.totalPaise + 1 });
    expect(payment.status).toBe(200);
    expect(payment.body.status).toBe('needs_review');
    expect((await request(app).get(`/orders/${order.id}`)).body.status).toBe('needs_review');
  });

  it('does not oversell when a correct payment arrives after the expired stock was reserved by others', async () => {
    const lateOrder = await makeOrder(IDS.trailMix);
    await pool.query("UPDATE orders SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [lateOrder.id]);
    expect((await request(app).get(`/orders/${lateOrder.id}`)).body.status).toBe('expired');

    // The full two-unit stock is now available to later customers and both units are reserved.
    await makeOrder(IDS.trailMix);
    await makeOrder(IDS.trailMix);
    const payment = await sendCapture(lateOrder);
    expect(payment.status).toBe(200);
    expect(payment.body.status).toBe('needs_review');
    expect((await request(app).get(`/orders/${lateOrder.id}`)).body.status).toBe('needs_review');

    const catalog = await request(app).get('/products');
    expect(catalog.body.find((product: { id: string }) => product.id === IDS.trailMix).availableUnits).toBe(0);
  });
});
