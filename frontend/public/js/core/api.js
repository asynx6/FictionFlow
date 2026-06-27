const BASE = '/api';

async function parseJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await parseJsonSafe(res);
  if (!res.ok || body?.success === false) {
    const message = body?.message ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  get: (path) => request(path),
  post: (path, payload) => request(path, { method: 'POST', body: JSON.stringify(payload) }),
  put: (path, payload) => request(path, { method: 'PUT', body: JSON.stringify(payload) }),
  delete: (path, payload) =>
    request(path, { method: 'DELETE', body: payload ? JSON.stringify(payload) : undefined }),

  postSSE: (path, payload, onEvent, signal) => new Promise((resolve, reject) => {
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          const errBody = await parseJsonSafe(res);
          const err = new Error(errBody?.message ?? `HTTP ${res.status}`);
          err.status = res.status;
          reject(err);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        const pump = () => {
          reader.read().then(({ value, done }) => {
            if (done) {
              resolve();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const lines = block.split('\n');
              let eventName = 'message';
              const dataLines = [];
              for (const ln of lines) {
                if (ln.startsWith('event:')) {
                  eventName = ln.slice(6).trim();
                } else if (ln.startsWith('data:')) {
                  dataLines.push(ln.slice(5).trim());
                }
              }
              const dataStr = dataLines.join('\n');
              if (!dataStr) continue;
              let data = null;
              try { data = JSON.parse(dataStr); } catch { /* ignore */ }
              
              if (onEvent) {
                // Map API SSE events to UI expected events
                if (eventName === 'token' && data?.text) {
                  onEvent('token', { delta: data.text });
                } else if (eventName === 'done') {
                  onEvent('done', data);
                } else if (eventName === 'error') {
                  reject(new Error(data?.message ?? 'Stream error'));
                  reader.cancel();
                  return;
                }
              }
            }
            pump();
          }).catch((err) => {
            if (err.name === 'AbortError') resolve();
            else reject(err);
          });
        };
        pump();
      })
      .catch((err) => {
        if (err.name === 'AbortError') resolve();
        else reject(err);
      });
  })
};
