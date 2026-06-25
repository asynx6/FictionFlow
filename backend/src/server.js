import './config/env.js';
import express from 'express';
import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = buildApp(express);
const server = app.listen(env.PORT, () => {
  console.log(
    `[server] FictionFlow backend listening on http://localhost:${env.PORT} ` +
      `(env: ${env.NODE_ENV}, db: ${env.DB_PATH})`
  );
});

function shutdown(signal) {
  console.log(`[server] Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
  process.exit(1);
});
