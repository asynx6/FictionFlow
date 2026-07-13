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

export const apiClient = {
  // Generic HTTP helpers (replaces api.js)
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
                if (eventName === 'meta') {
                  onEvent('meta', data);
                } else if (eventName === 'token' && data?.text) {
                  onEvent('token', { delta: data.text });
                } else if (eventName === 'done') {
                  onEvent('done', data);
                } else if (eventName === 'error') {
                  // Deliver to page handler (opens Cancel/Continue dialog).
                  // Resolve (jangan reject) supaya try-path cek providerError
                  // dan finally tidak race-clear handler lewat catch path.
                  onEvent('error', data);
                  reader.cancel().catch(() => {});
                  resolve();
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
  }),

  // Named convenience methods
  listStories: () => request('/stories'),
  createStory: (payload) =>
    request('/stories', { method: 'POST', body: JSON.stringify(payload) }),
  getStory: (id) => request(`/stories/${id}`),
  updateStory: (id, patch) =>
    request(`/stories/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteStory: (id) => request(`/stories/${id}`, { method: 'DELETE' }),

  listMessages: (id, { limit = 50, offset = 0 } = {}) =>
    request(`/stories/${id}/messages?limit=${limit}&offset=${offset}`),

  /**
   * Incremental chat-load paginator used by the story page. Returns an async
   * iterable that yields message batches newest-first.
   *
   *   Phase 1 (window): GET `/messages?limit=initialWindow`. The server
   *      returns up to `initialWindow` newest messages; we drain them in one
   *      request. Once the server reports a short window
   *      (batch.length < initialWindow), we pivot.
   *   Phase 2 (history): GET `/messages?limit=pageSize&offset=initialWindow`.
   *      Iteration: offset advances by batch.length each page. Pagination
   *      terminates as soon as the server returns a short remainder
   *      (batch.length < pageSize).
   *
   * `signal` propagates to fetch for abort.
   * `listMessages` keeps its old `(limit, offset)` signature so any older
   * caller still gets a single-page tail-style fetch.
   *
   * ponytail: routing/timing logic; upgrade when tasks B/D bring
   * back-pressure (e.g. scroll-position-driven prefetch).
   *
   * @param {string} id
   * @param {{initialWindow?: number, pageSize?: number, signal?: AbortSignal}} [opts]
   * @returns {AsyncGenerator<Message[]>}
   */
  loadAllMessages: async function* (id, {
    initialWindow = 12,
    pageSize = 24,
    signal,
  } = {}) {
    let offset = 0;
    let phase = 'window'; // 'window' -> 'history'
    while (true) {
      const limit = phase === 'window' ? initialWindow : pageSize;
      const path = offset === 0
        ? `/stories/${id}/messages?limit=${limit}`
        : `/stories/${id}/messages?limit=${limit}&offset=${offset}`;
      const body = await request(path, { signal });
      const batch = Array.isArray(body?.data?.messages) ? body.data.messages : [];
      yield batch;
      if (phase === 'window') {
        // Single-shot window fetch: regardless of fill, pivot to history
        // paging immediately. offset jumps to initialWindow so server's
        // deterministic newest-first ordering is preserved.
        if (batch.length === 0) return; // empty story — nothing to paginate
        phase = 'history';
        offset = initialWindow;
      } else {
        // History phase: empty page or short remainder terminates cleanly.
        if (batch.length === 0 || batch.length < pageSize) return;
        offset += batch.length;
      }
    }
  },
  sendMessage: (id, payload, { onEvent, signal } = {}) =>
    new Promise((resolve, reject) => {
      fetch(`${BASE}/stories/${id}/messages`, {
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
          let result = { message_id: null, full_content: '' };

          const processLine = (line) => {
            if (!line.startsWith('data:')) return null;
            const payload = line.slice(5).trim();
            if (!payload) return null;
            try {
              return JSON.parse(payload);
            } catch {
              return null;
            }
          };

          const pump = () => {
            reader.read().then(({ value, done }) => {
              if (done) {
                resolve(result);
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
                if (onEvent) onEvent(eventName, data);
                if (eventName === 'token' && data?.text) {
                  result.full_content += data.text;
                } else if (eventName === 'done' && data) {
                  result.message_id = data.message_id ?? result.message_id;
                  result.full_content = data.full_content ?? result.full_content;
                } else if (eventName === 'error') {
                  reject(new Error(data?.message ?? 'Stream error'));
                  reader.cancel();
                  return;
                }
              }
              pump();
            }).catch((err) => {
              if (err.name !== 'AbortError') reject(err);
            });
          };
          pump();
        })
        .catch((err) => {
          if (err.name !== 'AbortError') reject(err);
        });
    }),

  listVoicePresets: (id) => request(`/stories/${id}/voice-presets`),
  updateVoicePreset: (id, tag, patch) =>
    request(`/stories/${id}/voice-presets/${encodeURIComponent(tag)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  listModels: () => request('/models'),

  /**
   * POST /api/tts → audio/mpeg MP3 Blob.
   * Backend pakai @lixen/edge-tts (Microsoft Edge TTS endpoint, tanpa API key).
   * Body: { text, voice?, gender? }
   * @param {{ text: string, voice?: string, gender?: 'male'|'female', signal?: AbortSignal }} opts
   * @returns {Promise<Blob>}
   */
  synthesizeTts: async ({ text, voice, gender, signal }) => {
    const res = await fetch(`${BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, gender }),
      signal,
    });
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.message) errMsg = body.message;
      } catch { /* ignore */ }
      const err = new Error(errMsg);
      err.status = res.status;
      throw err;
    }
    return res.blob();
  },

  /**
   * POST /api/tts/warmup — fire-and-forget (default) atau blocking (wait=true).
   * Backend returns 202 instantly or 200 saat warm selesai (max 25s).
   * Default behavior = fire-and-forget (`wait: false`) supaya page load
   * tidak tertahan kalau Edge TTS latency tinggi.
   * @param {{ voice?: string, wait?: boolean }} opts
   * @returns {Promise<{success:boolean, data:{voice?:string, ready?:boolean}}|null>}
   */
  warmupTts: ({ voice, wait = false } = {}) => {
    const qs = wait ? '?wait=true' : '';
    return fetch(`${BASE}/tts/warmup${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice, wait }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  },
};
