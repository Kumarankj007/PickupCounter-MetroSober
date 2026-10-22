import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const app = createApp(pool);
const server = app.listen(config.port, () => {
  console.log(`Pickup Counter API listening on http://localhost:${config.port}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down gracefully...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
