import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../src/db/pool.js';

const here = dirname(fileURLToPath(import.meta.url));
try {
  const schema = await readFile(resolve(here, '../src/db/schema.sql'), 'utf8');
  const seed = await readFile(resolve(here, '../src/db/seed.sql'), 'utf8');
  await pool.query(schema);
  await pool.query('TRUNCATE TABLE processed_webhook_events, order_items, orders, products CASCADE');
  await pool.query(seed);
  console.log('k6 database reset complete. WARNING: this deletes all orders and webhook records.');
} catch (error) {
  console.error('Could not reset k6 database:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
