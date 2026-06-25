import { env } from '../config/env.js';
import fallbackModels from '../config/fallbackModels.json' with { type: 'json' };

// Guard untuk mencegah request body yang tidak terkontrol dikirim ke
// provider. Dipakai di streamChatCompletion + chatCompletionOnce sebagai
// safety net terhadap prompt/context membengkak (bisa picu 413/500 di
// upstream). 200KB cukup untuk typical chat dengan system prompt panjang
// + beberapa ribu token history; kalau melewati → throw lebih awal
// daripada membiarkan upstream mengembalikan error generik.
const MAX_REQUEST_BYTES = 200_000;

function assertBodyFits(body) {
  const serialized = JSON.stringify(body);
  const bytes = Buffer.byteLength(serialized, 'utf-8');
  if (bytes > MAX_REQUEST_BYTES) {
    throw new Error(
      `Request body terlalu besar (${bytes} bytes > ${MAX_REQUEST_BYTES}). ` +
        'Kurangi konteks atau pecah pesan.'
    );
  }
}

const MAX_RETRIES = 1;

async function listProviderModels() {
  const url = `${env.MODEL_PROVIDER_BASE_URL}/models`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${env.MODEL_PROVIDER_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Provider /models responded ${res.status}`);
  }
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return list
    .map((m) => ({
      id: m.id ?? m.name ?? '',
      label: m.name ?? m.id ?? m.label ?? '',
      provider: 'provider',
    }))
    .filter((m) => m.id);
}

export async function getAvailableModels() {
  if (!env.MODEL_PROVIDER_API_KEY) {
    return fallbackModels;
  }
  try {
    const remote = await listProviderModels();
    if (remote.length > 0) return remote;
  } catch (err) {
    console.warn(
      `[modelProvider] Gagal ambil daftar model dari provider (${err.message}). ` +
        'Pakai fallback statis.'
    );
  }
  return fallbackModels;
}

export function resolveModelId(modelId) {
  const aliases = {
    'minimax-m3': 'bi/minimax-m3',
    'MiniMax-M3': 'bi/minimax-m3',
    'MiniMax': 'bi/minimax-m3',
    'openrouter/auto': env.DEFAULT_MODEL_ID,
    'nvidia/minimaxai/minimax-m3': 'bi/minimax-m3',
  };
  const normalized = (modelId ?? '').toString().trim();
  return aliases[normalized] || normalized || env.DEFAULT_MODEL_ID;
}

/**
 * Melakukan streaming chat completion ke provider.
 * Yield: { type: 'token', text } per delta, atau { type: 'done' } di akhir.
 * Throw: Error dengan pesan informatif jika provider gagal.
 */
export async function* streamChatCompletion({ model, messages, signal }) {
  const body = {
    model,
    messages,
    stream: true,
  };
  assertBodyFits(body);

  let attempt = 0;
  let lastError;

  while (attempt <= MAX_RETRIES) {
    const res = await fetch(`${env.MODEL_PROVIDER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MODEL_PROVIDER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      lastError = new Error(
        `Provider error ${res.status} ${res.statusText}: ${errText.slice(0, 300)}`
      );
      attempt += 1;
      if (attempt > MAX_RETRIES) throw lastError;
      continue;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let lineEnd;
        while ((lineEnd = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          if (!line || !line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            return;
          }

          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) {
            yield { type: 'token', text: delta };
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }

    yield { type: 'done' };
    return;
  }

  throw lastError ?? new Error('Model provider request failed');
}

/**
 * Non-streaming chat completion. Mengembalikan string teks lengkap.
 * Dipakai oleh background job (mis. memory extractor) yang tidak butuh
 * streaming token tapi butuh hasil utuh.
 *
 * Tidak ada retry internal karena caller sudah di-trigger async
 * (fire-and-forget) di luar critical path user.
 */
export async function chatCompletionOnce({ model, messages, signal, temperature }) {
  const body = {
    model,
    messages,
    stream: false,
  };
  if (typeof temperature === 'number') body.temperature = temperature;

  assertBodyFits(body);

  const res = await fetch(`${env.MODEL_PROVIDER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MODEL_PROVIDER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Provider error ${res.status} ${res.statusText}: ${errText.slice(0, 300)}`
    );
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Provider response missing message content.');
  }
  return content;
}
