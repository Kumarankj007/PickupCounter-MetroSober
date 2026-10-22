import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the root environment file regardless of the shell's current directory.
const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? resolve(here, '../../.env') });

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/pickup_counter',
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'local-dev-webhook-secret-change-me-32',
};
