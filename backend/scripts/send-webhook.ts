import crypto from 'node:crypto';
import { config } from '../src/config.js';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const orderId = arg('orderId');
const amountRaw = arg('amount');
const eventId = arg('eventId', `evt_${crypto.randomUUID()}`)!;
const baseUrl = (arg('url', process.env.API_BASE_URL ?? `http://localhost:${config.port}`)!).replace(/\/$/, '');

if (!orderId || !amountRaw || !Number.isSafeInteger(Number(amountRaw)) || Number(amountRaw) < 0) {
  console.error('Usage: npm run send-webhook -- --orderId <uuid> --amount <totalPaise> [--eventId evt_123] [--url http://localhost:3000]');
  process.exit(1);
}

const payload = { eventId, orderId, amountPaise: Number(amountRaw), status: 'captured' };
const rawBody = JSON.stringify(payload);
const signature = crypto.createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex');

const response = await fetch(`${baseUrl}/payments/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-signature': signature },
  body: rawBody,
});
const body = await response.text();
console.log(`HTTP ${response.status}`);
console.log(body);
if (!response.ok) process.exitCode = 1;
