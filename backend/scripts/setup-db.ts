import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../src/db/pool.js';

const here = dirname(fileURLToPath(import.meta.url));
try {
  const schema = await readFile(resolve(here, '../src/db/schema.sql'), 'utf8');
  const seed = await readFile(resolve(here, '../src/db/seed.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(seed);
  console.log('Database schema is ready and seed products are present.');
} catch (error) {
  console.error('Database setup failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
