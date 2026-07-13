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

function isTtsTransportFailure(err) {
  // Prefer the typed property set at the throw site (TEMUAN-015); fall back to
  // substring for the edge-tts library's own synchronous WebSocket 'error'
  // emissions, which bypass our wrapper.
  if (err && err.isTtsTransport === true) return true;
  const msg = (err && (err.message ?? err.toString?.())) || '';
  return msg.includes('EdgeTTS') || msg.includes('Unexpected server response');
}

process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err);
  // EdgeTTS/sandbox-blocked 403: paket library melempar 'error' synchronously dari
  // internal WebSocket constructor. Service sudah punya one-shot listener yang
  // mengubah throw jadi Promise rejection untuk /api/tts handler. Jangan bunuh
  // server hanya karena satu route gagal.
  if (isTtsTransportFailure(err)) {
    console.warn('[server] Non-fatal TTS transport error, process tetap hidup.');
    return;
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
  if (isTtsTransportFailure(reason)) {
    console.warn('[server] Non-fatal TTS rejection, process tetap hidup.');
    return;
  }
  process.exit(1);
});
