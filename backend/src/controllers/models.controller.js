import { env } from '../config/env.js';
import { getAvailableModels, resolveModelId } from '../services/modelProvider.service.js';

export async function listModels(_req, res) {
  const models = await getAvailableModels();
  res.json({
    success: true,
    data: {
      models,
      default_model_id: env.DEFAULT_MODEL_ID,
    },
    message: 'OK',
    meta: { count: models.length, timestamp: new Date().toISOString() },
  });
}

export { resolveModelId };
