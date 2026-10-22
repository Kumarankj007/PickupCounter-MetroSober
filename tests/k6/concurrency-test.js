import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import crypto from 'k6/crypto';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || 'local-dev-webhook-secret-change-me-32';

const oversellSuccess = new Counter('oversell_success');
const oversellCleanFailure = new Counter('oversell_clean_failure');
const oversellUnexpected = new Counter('oversell_unexpected');
const webhookHttp200 = new Counter('webhook_http_200');
const webhookProcessedOnce = new Counter('webhook_processed_once');
const webhookUnexpected = new Counter('webhook_unexpected');
const pickupHttp200 = new Counter('pickup_http_200');
const pickupHttp409 = new Counter('pickup_http_409');
const pickupUnexpected = new Counter('pickup_unexpected');

export const options = {
  scenarios: {
    oversell_prevention: {
      executor: 'per-vu-iterations', vus: 10, iterations: 1, maxDuration: '30s', exec: 'oversell',
    },
    duplicate_webhook: {
      executor: 'per-vu-iterations', vus: 5, iterations: 1, startTime: '1s', maxDuration: '30s', exec: 'duplicateWebhook',
    },
    simultaneous_pickup: {
      executor: 'per-vu-iterations', vus: 2, iterations: 1, startTime: '1s', maxDuration: '30s', exec: 'pickupClaim',
    },
  },
  thresholds: {
    oversell_success: ['count==2'],
    oversell_clean_failure: ['count==8'],
    oversell_unexpected: ['count==0'],
    webhook_http_200: ['count==5'],
    webhook_processed_once: ['count==1'],
    webhook_unexpected: ['count==0'],
    pickup_http_200: ['count==1'],
    pickup_http_409: ['count==1'],
    pickup_unexpected: ['count==0'],
    checks: ['rate==1'],
  },
};

function sign(rawBody) {
  return crypto.hmac('sha256', WEBHOOK_SECRET, rawBody, 'hex');
}

function createOrder(productId) {
  const response = http.post(`${BASE_URL}/orders`, JSON.stringify([{ productId, quantity: 1 }]), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (response.status !== 201) throw new Error(`Fixture order creation failed: ${response.status} ${response.body}`);
  return response.json();
}

function capture(order, eventId) {
  const payload = { eventId, orderId: order.id, amountPaise: order.totalPaise, status: 'captured' };
  const raw = JSON.stringify(payload);
  const response = http.post(`${BASE_URL}/payments/webhook`, raw, {
    headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw) },
  });
  if (response.status !== 200) throw new Error(`Fixture payment failed: ${response.status} ${response.body}`);
  return response.json();
}

export function setup() {
  const productsResponse = http.get(`${BASE_URL}/products`);
  if (productsResponse.status !== 200) throw new Error(`GET /products failed: ${productsResponse.status}`);
  const products = productsResponse.json();
  const product = (name) => products.find((item) => item.name === name);
  const testSnack = product('Trail Mix Pack');
  const webhookSnack = product('Bottled Water');
  const pickupSnack = product('Granola Bar');
  if (!testSnack || !webhookSnack || !pickupSnack) throw new Error('Seed products were not found. Run npm run db:reset:k6 first.');
  if (testSnack.availableUnits !== 2) throw new Error(`Trail Mix Pack must have exactly 2 available units for Scenario A; found ${testSnack.availableUnits}. Reset the k6 DB.`);

  const webhookOrder = createOrder(webhookSnack.id);
  const pickupOrder = createOrder(pickupSnack.id);
  capture(pickupOrder, `evt_k6_pickup_setup_${pickupOrder.id}`);
  return { testProductId: testSnack.id, webhookOrder, pickupOrder };
}

export function oversell(data) {
  const response = http.post(`${BASE_URL}/orders`, JSON.stringify([{ productId: data.testProductId, quantity: 1 }]), {
    headers: { 'Content-Type': 'application/json' },
  });
  const expected = response.status === 201 || response.status === 400;
  check(response, {
    'oversell: response is 201 or clear 400': (r) => expected,
    'oversell: rejected request gives stock error': (r) => r.status !== 400 || r.json('code') === 'INSUFFICIENT_STOCK',
  });
  if (response.status === 201) oversellSuccess.add(1);
  else if (response.status === 400 && response.json('code') === 'INSUFFICIENT_STOCK') oversellCleanFailure.add(1);
  else oversellUnexpected.add(1);
}

export function duplicateWebhook(data) {
  const order = data.webhookOrder;
  const payload = { eventId: 'evt_k6_duplicate_same_event', orderId: order.id, amountPaise: order.totalPaise, status: 'captured' };
  const raw = JSON.stringify(payload);
  const response = http.post(`${BASE_URL}/payments/webhook`, raw, {
    headers: { 'Content-Type': 'application/json', 'X-Signature': sign(raw) },
  });
  const body = response.status === 200 ? response.json() : {};
  check(response, {
    'webhook: every duplicate returns HTTP 200': (r) => r.status === 200,
    'webhook: order remains paid': (r) => r.status === 200 && body.status === 'paid',
  });
  if (response.status === 200) {
    webhookHttp200.add(1);
    if (body.duplicate === false) webhookProcessedOnce.add(1);
  } else webhookUnexpected.add(1);
}

export function pickupClaim(data) {
  const response = http.post(`${BASE_URL}/orders/${data.pickupOrder.id}/pickup-claim`, null);
  check(response, {
    'pickup: status is 200 or 409': (r) => r.status === 200 || r.status === 409,
  });
  if (response.status === 200) pickupHttp200.add(1);
  else if (response.status === 409) pickupHttp409.add(1);
  else pickupUnexpected.add(1);
}
