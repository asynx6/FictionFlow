import { errorHandler, notFoundHandler, HttpError } from './middlewares/errorHandler.js';
import { requestLogger } from './middlewares/requestLogger.js';
import { env } from './config/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import storiesRouter from './routes/stories.routes.js';
import modelsRouter from './routes/models.routes.js';
import generatorRouter from './routes/generator.routes.js';
import ttsRouter from './routes/tts.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_PUBLIC = path.resolve(__dirname, '..', '..', 'frontend', 'public');

export function buildApp(expressLib = express) {
  const app = expressLib();

  app.use(expressLib.json({ limit: '1mb' }));
  app.use(requestLogger);

  app.get('/api/health', (_req, res) => {
    res.json({
      success: true,
      data: { status: 'ok', env: env.NODE_ENV },
      message: 'OK',
      meta: { timestamp: new Date().toISOString() },
    });
  });

  app.use('/api/stories', storiesRouter);
  app.use('/api', modelsRouter);
  app.use('/api/generate', generatorRouter);
  app.use('/api/tts', ttsRouter);

  app.use(expressLib.static(FRONTEND_PUBLIC, {
    extensions: ['html'],
    cacheControl: false,
    maxAge: 0,
    etag: false,
    lastModified: false,
  }));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(FRONTEND_PUBLIC, 'index.html'));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export { HttpError };
