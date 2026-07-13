import { env } from '../config/env.js';

/**
 * Single source of truth for the AI provider the backend talks to:
 * everything is read from `env` (which is populated from backend/.env).
 *
 * Fallback chain behaviour:
 *   - env.MODEL_CHAIN = [{slot, key, value}, ...]  populated from
 *     `DEFAULT_MODEL_ID` and optional `DEFAULT_MODEL_ID_1..10` in .env.
 *   - Empty slots are skipped silently (missing = not configured).
 *   - `streamChatCompletion` tries the chain in order — primary first, then
 *     _1, _2, …, until one succeeds or every slot fails. Aborts are
 *     propagated (user clicked Stop).
 *   - `chatCompletionOnce` does the same.
 *   - `resolveModelId(bodyId)` rejects drift: used only as a guard, never
 *     to substitute.
 */

// ---------------------------------------------------------------------------
// Hard cap on outgoing request body (defence-in-depth against runaway prompt
// growth that upstream rejects generically with 413/500).
// ---------------------------------------------------------------------------
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

/**
 * Return the configured provider model id (`env.DEFAULT_MODEL_ID`).
 * This is the primary slot — used for banners / logs that should
 * describe the configured model, not the chain as a whole.
 */
export function getConfiguredModelId() {
  return env.DEFAULT_MODEL_ID;
}

/**
 * Return the model chain in priority order. Empty slots are absent.
 * @returns {{slot:number, key:string, value:string}[]}
 */
export function getModelChain() {
  return env.MODEL_CHAIN.map((m) => ({ ...m }));
}

/**
 * Legacy helper retained for callers that previously accepted a
 * caller-supplied model id. Throws if a non-empty id is supplied that
 * differs from the configured primary — a guard against silent drift.
 */
export function resolveModelId(modelId) {
  const supplied = (modelId ?? '').toString().trim();
  if (supplied && supplied !== env.DEFAULT_MODEL_ID) {
    throw new Error(
      `Caller supplied modelId="${supplied}" but backend is configured to use ` +
        `DEFAULT_MODEL_ID="${env.DEFAULT_MODEL_ID}" from .env. Body model_id is ` +
        'no longer accepted — change DEFAULT_MODEL_ID in backend/.env and restart.'
    );
  }
  return env.DEFAULT_MODEL_ID;
}

// ---------------------------------------------------------------------------
// Internal helpers: classify a thrown error so we know whether it's safe to
// try the next model in the chain. We treat these as NOT retryable on the
// next model (because trying again would surface the same user-facing error):
//   - AbortError                      (user clicked Stop)
//   - MAX_REQUEST_BYTES exceeded       (our defence — bug, not server)
//   - "body too large" guard error
// We treat all other errors as retryable on the next model in the chain.
// ---------------------------------------------------------------------------
function shouldTryNextModel(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('request body terlalu besar')) return false;
  if (msg.includes('provider response missing message content')) return false;
  return true;
}

/**
 * Streaming chat completion across the model chain. Yields tokens from the
 * first model that streams successfully; otherwise falls through to the
 * next non-empty slot in the chain.
 *
 * @param {{ messages: object[], signal?: AbortSignal }} opts
 */
export async function* streamChatCompletion({ messages, signal }) {
  const errors = [];
  for (const entry of env.MODEL_CHAIN) {
    const body = { model: entry.value, messages, stream: true };
    assertBodyFits(body);

    try {
      // Hand off the iterator to the caller. We materialise the inner
      // generator up-front so we can catch body-size errors before
      // yielding anything.
      yield* streamSingleModel({ modelValue: entry.value, body, signal });
      // If we got here without throwing, the model succeeded.
      return;
    } catch (err) {
      errors.push({ key: entry.key, value: entry.value, err });
      if (!shouldTryNextModel(err)) throw err;
      console.warn(
        `[modelProvider] ${entry.key}=${entry.value} gagal: ${err.message}. ` +
          'Lanjut ke model berikutnya dalam chain.'
      );
    }
  }
  // All slots exhausted.
  const last = errors[errors.length - 1];
  const summary = errors
    .map((e) => `${e.key}=${e.value} → ${e.err.message}`)
    .join(' | ');
  throw new Error(
    `Semua model di fallback chain gagal (${errors.length} slot). ` +
      `Last error: ${last.err.message}. Chain: ${summary}`
  );
}

// Timeout for the FIRST byte of a streaming response. If a model is
// rate-limited or stuck in reasoning, it can hold the connection open
// for tens of seconds with no `data: {...}` payload. After this many ms
// with no token, abort the request so the chain continues to the next
// slot. Tuned conservatively; user-visible typing latency is the
// dominant UX cost here, not savings from one or two retries.
//
// Configure via env if a slow provider needs more breathing room.
const FIRST_BYTE_TIMEOUT_MS = (() => {
  const v = Number.parseInt((process.env.MODEL_FIRST_BYTE_TIMEOUT_MS ?? '').toString(), 10);
  return Number.isFinite(v) && v >= 1000 ? v : 25_000;
})();

async function _fetchWithFirstByteTimeout(url, init, timeoutMs) {
  // AbortController scoped to this request — separate from caller `signal`
  // so we can time-out without cancelling the caller's outer abort.
  const ctl = new AbortController();
  const callerSignal = init.signal;
  if (callerSignal) {
    if (callerSignal.aborted) ctl.abort();
    callerSignal.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok || !res.body) return res;
    // Race the first read against the timeout. If first chunk arrives
    // within budget, cancel the timeout and return res; if not, throw
    // a timeout error and let the chain fall through.
    const reader = res.body.getReader();
    const firstRead = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`first-byte timeout after ${timeoutMs}ms`)), timeoutMs + 100)
      ),
    ]);
    clearTimeout(timer);
    if (firstRead.done) {
      try { reader.releaseLock(); } catch {}
      throw new Error('Provider returned empty stream');
    }
    // Reconstruct a ReadableStream that yields our buffered first chunk
    // then forwards subsequent reads.
    const wrapped = new ReadableStream({
      async pull(controller) {
        if (firstRead.value !== undefined) {
          controller.enqueue(firstRead.value);
        }
        while (true) {
          const r = await reader.read();
          if (r.done) { controller.close(); return; }
          controller.enqueue(r.value);
        }
      },
      cancel(reason) {
        try { reader.cancel(reason); } catch {}
      },
    });
    return new Response(wrapped, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function* streamSingleModel({ modelValue, body, signal }) {
  void modelValue;
  const MAX_RETRIES = 1;
  let attempt = 0;
  let lastError;

  while (attempt <= MAX_RETRIES) {
    let res;
    try {
      res = await _fetchWithFirstByteTimeout(
        `${env.MODEL_PROVIDER_BASE_URL}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.MODEL_PROVIDER_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        },
        FIRST_BYTE_TIMEOUT_MS
      );
    } catch (err) {
      // Caller abort (user Stop / client disconnect): the caller's signal is
      // aborted. Re-throw an AbortError so shouldTryNextModel sees name ===
      // 'AbortError' and STOPS the chain instead of retrying the next slot
      // (TEMUAN-008). This is distinct from an internal first-byte timeout,
      // which aborts via a separate controller and leaves signal.aborted false
      // — that stays retryable.
      if (signal?.aborted) {
        const abortErr = new Error('aborted by caller');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const isTimeout = /timeout|abort/i.test(err.message);
      lastError = new Error(
        `Provider error (${body.model}): ${isTimeout ? `hang/timeout > ${FIRST_BYTE_TIMEOUT_MS}ms` : err.message}`
      );
      attempt += 1;
      if (attempt > MAX_RETRIES) throw lastError;
      continue;
    }

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
          if (payload === '[DONE]') return;

          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) yield { type: 'token', text: delta };
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }

    yield { type: 'done' };
    return;
  }

  throw lastError ?? new Error('Model provider request failed');
}

/**
 * Non-streaming chat completion across the model chain (memory extractor).
 * Tries each slot in order until one returns a usable response.
 *
 * @param {{ messages: object[], signal?: AbortSignal, temperature?: number }} opts
 * @returns {Promise<string>}
 */
export async function chatCompletionOnce({ messages, signal, temperature }) {
  const errors = [];
  for (const entry of env.MODEL_CHAIN) {
    const body = { model: entry.value, messages, stream: false };
    if (typeof temperature === 'number') body.temperature = temperature;
    assertBodyFits(body);

    try {
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
    } catch (err) {
      errors.push({ key: entry.key, value: entry.value, err });
      if (!shouldTryNextModel(err)) throw err;
      console.warn(
        `[modelProvider] ${entry.key}=${entry.value} gagal: ${err.message}. ` +
          'Lanjut ke model berikutnya dalam chain.'
      );
    }
  }
  const last = errors[errors.length - 1];
  const summary = errors
    .map((e) => `${e.key}=${e.value} → ${e.err.message}`)
    .join(' | ');
  throw new Error(
    `Semua model di fallback chain gagal (${errors.length} slot). ` +
      `Last error: ${last.err.message}. Chain: ${summary}`
  );
}
