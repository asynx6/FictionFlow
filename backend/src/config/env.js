import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

function resolveDbPath(input) {
  if (!input) return path.join(PROJECT_ROOT, 'data', 'fictionflow.sqlite');
  if (path.isAbsolute(input)) return input;
  return path.resolve(PROJECT_ROOT, input);
}

// ---------------------------------------------------------------------------
// Required env: provider config comes ONLY from .env.
//   MODEL_PROVIDER_BASE_URL  (no fallback; fail-fast at boot if empty)
//   MODEL_PROVIDER_API_KEY   (no fallback)
//   DEFAULT_MODEL_ID         primary model.  Must be non-empty.
//
// Optional fallback chain (skip empty slots silently):
//   DEFAULT_MODEL_ID_1 . . . DEFAULT_MODEL_ID_10
//
// At most MAX_MODEL_SLOTS total entries (slot 0 + _1.._10 → 11). Add a new
// slot only by editing this constant, the .env.example, the README, and the
// self-check in tests/test-model-chain.mjs.
// ---------------------------------------------------------------------------
const MAX_MODEL_SLOTS = 11;

const MISSING = [];

const MODEL_PROVIDER_BASE_URL = (process.env.MODEL_PROVIDER_BASE_URL ?? '')
  .toString()
  .trim()
  .replace(/\/+$/, '');
if (!MODEL_PROVIDER_BASE_URL) MISSING.push('MODEL_PROVIDER_BASE_URL');

const MODEL_PROVIDER_API_KEY = (process.env.MODEL_PROVIDER_API_KEY ?? '').toString().trim();
if (!MODEL_PROVIDER_API_KEY) MISSING.push('MODEL_PROVIDER_API_KEY');

// Collect every DEFAULT_MODEL_ID[_N] that is non-empty after trim. Order:
// slot 0 (DEFAULT_MODEL_ID) first; then _1, _2, ..., up to (MAX_MODEL_SLOTS-1).
const MODEL_CHAIN = [];
for (let i = 0; i < MAX_MODEL_SLOTS; i++) {
  const key = i === 0 ? 'DEFAULT_MODEL_ID' : `DEFAULT_MODEL_ID_${i}`;
  const v = (process.env[key] ?? '').toString().trim();
  if (v) MODEL_CHAIN.push({ slot: i, key, value: v });
}

if (MODEL_CHAIN.length === 0) {
  MISSING.push('DEFAULT_MODEL_ID');
}

// The primary/active id used by callers that don't go through the fallback
// loop (e.g. the SSE meta banner, listings, logs).
const DEFAULT_MODEL_ID = MODEL_CHAIN[0]?.value ?? '';

export const env = {
  PORT: Number.parseInt(process.env.PORT ?? '3000', 10),
  NODE_ENV: process.env.NODE_ENV ?? 'development',

  DB_PATH: resolveDbPath(process.env.DB_PATH),

  MODEL_PROVIDER_BASE_URL,
  MODEL_PROVIDER_API_KEY,
  DEFAULT_MODEL_ID,
  MODEL_CHAIN,
  MAX_MODEL_SLOTS,

  DEFAULT_SHORT_TERM_WINDOW: clampInt(
    process.env.DEFAULT_SHORT_TERM_WINDOW,
    3,
    5,
    4
  ),
};

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

if (MISSING.length > 0) {
  console.error('');
  console.error('[env] .env tidak lengkap. Field yang WAJIB ada:');
  for (const key of MISSING) console.error(`  - ${key}`);
  if (MODEL_CHAIN.length > 1) {
    console.error(`[env] (chain saat ini: ${MODEL_CHAIN.length} slot terisi: ${MODEL_CHAIN.map((m) => m.key).join(', ')})`);
  }
  console.error('[env] Isi di backend/.env lalu restart.');
  console.error('');
  process.exit(1);
}
