export function errorHandler(err, _req, res, _next) {
  const status = err.statusCode ?? err.status ?? 500;
  const message = err.exposeMessage
    ? err.message
    : status >= 500
      ? 'Internal server error'
      : err.message || 'Request failed';

  if (status >= 500) {
    console.error('[error]', err.message, err.code ?? '');
    if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  } else {
    console.warn('[warn]', status, err.message);
  }

  res.status(status).json({
    success: false,
    data: null,
    message,
    meta: { timestamp: new Date().toISOString() },
  });
}

export function notFoundHandler(_req, res) {
  res.status(404).json({
    success: false,
    data: null,
    message: 'Endpoint tidak ditemukan',
    meta: { timestamp: new Date().toISOString() },
  });
}

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.exposeMessage = true;
  }
}
