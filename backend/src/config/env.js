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

export const env = {
  PORT: Number.parseInt(process.env.PORT ?? '3000', 10),
  NODE_ENV: process.env.NODE_ENV ?? 'development',

  DB_PATH: resolveDbPath(process.env.DB_PATH),

  MODEL_PROVIDER_BASE_URL: (process.env.MODEL_PROVIDER_BASE_URL ?? 'https://openrouter.ai/api/v1')
    .replace(/\/+$/, ''),
  MODEL_PROVIDER_API_KEY: process.env.MODEL_PROVIDER_API_KEY ?? '',
  DEFAULT_MODEL_ID: process.env.DEFAULT_MODEL_ID ?? 'openrouter/auto',

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

if (!env.MODEL_PROVIDER_API_KEY) {
  console.warn(
    '[env] MODEL_PROVIDER_API_KEY belum diisi. Set di backend/.env sebelum menjalankan cerita.'
  );
}
