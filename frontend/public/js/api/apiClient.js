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
  listStories: () => request('/stories'),
  createStory: (payload) =>
    request('/stories', { method: 'POST', body: JSON.stringify(payload) }),
  getStory: (id) => request(`/stories/${id}`),
  updateStory: (id, patch) =>
    request(`/stories/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteStory: (id) => request(`/stories/${id}`, { method: 'DELETE' }),

  listMessages: (id, { limit = 50, offset = 0 } = {}) =>
    request(`/stories/${id}/messages?limit=${limit}&offset=${offset}`),
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
