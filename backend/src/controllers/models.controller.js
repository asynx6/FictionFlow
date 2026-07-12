import { env } from '../config/env.js';

/**
 * Provider config endpoint — there is no model picker UI; the only model
 * in use is whatever DEFAULT_MODEL_ID says in backend/.env. Return that
 * verbatim so a UI / debug tool can read what the server actually uses.
 */
export async function listModels(_req, res) {
  res.json({
    success: true,
    data: {
      models: [],
      default_model_id: env.DEFAULT_MODEL_ID,
    },
    message: 'OK',
    meta: {
      provider_base_url: env.MODEL_PROVIDER_BASE_URL,
      timestamp: new Date().toISOString(),
    },
  });
}
