/**
 * Edge TTS synthesizer service.
 *
 * Menggunakan `edge-tts-universal` v1.4.0 yang berbicara ke Microsoft Edge TTS
 * endpoint (gratis, tidak butuh API key). Library ini meng-emulasi Chrome/Edge
 * 143 + MUID cookie auth — kompatibel dengan token rotation Microsoft terbaru
 * (Feb 2026).
 *
 * Migrasi dari `@lixen/edge-tts` (Feb 2025, Chrome 130 emulation): library lama
 * gagal dapat token Sec-MS-GEC valid dari Microsoft → HTTP 403 → semua segment
 * fall-back ke Web Speech (suara male default) → "Luna masih male".
 *
 * Pack names (single source of truth):
 *   - id-ID : ArdiNeural (male / narration) + GadisNeural (female)
 *   - en-US : GuyNeural (male / narration)  + JennyNeural (female)
 */

import { Communicate, NoAudioReceived, WebSocketError, UnexpectedResponse } from 'edge-tts-universal';
import { createHash } from 'node:crypto';

export const DEFAULT_VOICE_MALE = 'id-ID-ArdiNeural';
export const DEFAULT_VOICE_FEMALE = 'id-ID-GadisNeural';
export const DEFAULT_VOICE_MALE_EN = 'en-US-GuyNeural';
export const DEFAULT_VOICE_FEMALE_EN = 'en-US-JennyNeural';

export const VALID_PACKS = new Set(['id-ID', 'en-US']);

/**
 * In-process LRU cache untuk synthesized MP3. Edge TTS Mengirim ke Microsoft
 * endpoint via WebSocket (~1-4s first call cold-start). Cache key =
 * sha1(text+voice+rate+volume+pitch). FIFO eviction saat > MAX_CACHE_SIZE —
 * small but covers 1 cerita (1 voice pack, banyak replay = no recompute).
 */
const MAX_CACHE_SIZE = 128;
const synthCache = new Map();

function cacheKey(text, voice, opts) {
  const h = createHash('sha1');
  h.update(text);
  h.update('|');
  h.update(voice);
  h.update('|');
  h.update(opts?.rate ?? '+0%');
  h.update('|');
  h.update(opts?.volume ?? '+0%');
  h.update('|');
  h.update(opts?.pitch ?? '+0Hz');
  return h.digest('hex');
}

function cacheGet(key) {
  if (!synthCache.has(key)) return null;
  // Touch (refresh for LRU semantics via re-insert at end)
  const v = synthCache.get(key);
  synthCache.delete(key);
  synthCache.set(key, v);
  return v;
}

function cachePut(key, buffer) {
  if (synthCache.size >= MAX_CACHE_SIZE) {
    // FIFO eviction — drop oldest insertion.
    const oldest = synthCache.keys().next().value;
    if (oldest !== undefined) synthCache.delete(oldest);
  }
  synthCache.set(key, buffer);
}

function cacheEvict(key) {
  if (synthCache.has(key)) {
    synthCache.delete(key);
    return true;
  }
  return false;
}

/**
 * Minimum legitimate MP3 size. Edge TTS kadang return empty/garbage
 * response WebSocket chunks (10-200 bytes bukan audio). Validate sebelum
 * cache supaya corrupt response tidak persistently serve ke front-end.
 */
const MIN_VALID_MP3_SIZE = 2048;

/**
 * Per-(type, gender) prosody bias untuk simulasi ekspresi natural.
 * Narasi male lebih lambat+pitch netral (gravitas).
 * Narasi female sedikit lebih cepat+pitch naik (orang/halo).
 * Dialog male lebih cepat dan pitch sedikit naik seperti Azan biasa.
 * Dialog female paling ekspresif (ramai/brightness).
 * Semua nilai signed (+/-) sesuai regex edge-tts-universal.
 */
export function prosodyFor(type, gender) {
  const t = type === 'dialogue' ? 'dialogue' : 'narration';
  const g = gender === 'female' ? 'female' : 'male';
  // 4-tuple matrix.
  if (t === 'dialogue' && g === 'female') return { rate: '+8%', volume: '+0%', pitch: '+3Hz' };
  if (t === 'dialogue' && g === 'male') return { rate: '+5%', volume: '+0%', pitch: '+2Hz' };
  if (t === 'narration' && g === 'female') return { rate: '-2%', volume: '+0%', pitch: '+1Hz' };
  return { rate: '-3%', volume: '+0%', pitch: '+0Hz' }; // narration male
}

/**
 * Strip suffix non-Neural (-Male / -Female / -M / -F) yang kadang muncul di
 * hint LLM lama agar tidak error di EdgeTTS endpoint. Mis.
 *   id-ID-Ardi-Male   → id-ID-ArdiNeural
 *   id-ID-Gadis-Female → id-ID-GadisNeural
 *
 * Catatan: edge-tts-universal menerima `+5%` / `-10Hz` (Python edge_tts
 * convention, GitHub release notes Python parity). Beda dari @lixen yang
 * regex-nya strict `-?` only.
 */
function normalizeHint(hint) {
  if (!hint || typeof hint !== 'string') return null;
  const trimmed = hint.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/-Male$/i, 'Neural')
    .replace(/-Female$/i, 'Neural')
    .replace(/-M$/, 'Neural')
    .replace(/-F$/i, 'Neural');
}

function pickVoiceForSegment(segment) {
  if (!segment) return DEFAULT_VOICE_MALE;
  if (segment.gender === 'female') return DEFAULT_VOICE_FEMALE;
  if (segment.gender === 'male') return DEFAULT_VOICE_MALE;
  // narration → male, dialogue → sesuai gender karakter
  return DEFAULT_VOICE_MALE;
}

/**
 * Sound-level: detect whether Edge TTS response is MP3 audio. Re-attempt
 * retries kalau buffer corrupt — bypass cache untuk request ini supaya
 * Edge TTS upstream dipanggil fresh.
 */
const RETRY_BACKOFF_MS = [300, 800, 2000];

async function runWithRetry(text, voice, options) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length + 1; attempt++) {
    try {
      const buf = await runSynthesize(text, voice, options);
      // Validate MP3 sebelum return. Kalau corrupt (tapi passed size check),
      // treat as lastErr dan retry.
      if (buf && buf.length > 0 && isLikelyValidMp3(buf)) {
        return buf;
      }
      lastErr = new Error(
        `EdgeTTS: response corrupt (size=${buf?.length ?? 0}b, attempt ${attempt + 1})`
      );
      console.warn(`[tts] ${lastErr.message} — retrying.`);
    } catch (err) {
      lastErr = err;
      console.warn(
        `[tts] ${err.message} (attempt ${attempt + 1}/${RETRY_BACKOFF_MS.length + 1})`
      );
    }
    // Backoff sebelum next attempt (skip setelah final).
    if (attempt < RETRY_BACKOFF_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
    }
  }
  throw lastErr || new Error('EdgeTTS: all retries exhausted');
}

export { runWithRetry };

/**
 * Map error class dari library ke human-readable string. Beda kelas → beda
 * strategi (timeout, retry-able, hard fail).
 */
function classifyError(err) {
  if (err instanceof NoAudioReceived) {
    return 'EdgeTTS: tidak ada audio diterima (kemungkinan endpoint menolak request / 403).';
  }
  if (err instanceof UnexpectedResponse) {
    return `EdgeTTS: respons tidak terduga dari Microsoft: ${err.message}`;
  }
  if (err instanceof WebSocketError) {
    return `EdgeTTS: WebSocket error: ${err.message}`;
  }
  return err?.message ?? String(err);
}

async function runSynthesize(text, voice, options) {
  // Crash mitigation: @lixen/edge-tts dulu listener 'error' naik tanpa handler
  // → uncaughtException → server.js process.exit(1). edge-tts-universal jauh
  // lebih bersih (async iterator + typed exceptions), TAPI kita tetap pasang
  // safety net: kalau ada unexpected throw yang lolos (mis. fetch global
  // crash / DNS failure deep stack), tangkap sebagai Promise rejection alih-
  // alih membunuh process.
  let onError;
  const ttsError = new Promise((_, reject) => {
    onError = (err) => {
      reject(new Error(`EdgeTTS uncaught: ${err && err.message ? err.message : err}`));
    };
    process.once('uncaughtException', onError);
  });

  const comm = new Communicate(text, {
    voice,
    rate: options.rate ?? '+0%',
    volume: options.volume ?? '+0%',
    pitch: options.pitch ?? '+0Hz',
    connectionTimeout: options.connectionTimeout ?? 10000,
  });

  try {
    const streamPromise = (async () => {
      const chunks = [];
      for await (const chunk of comm.stream()) {
        if (chunk.type === 'audio' && chunk.data) {
          chunks.push(chunk.data);
        }
      }
      if (chunks.length === 0) {
        throw new Error('EdgeTTS: stream audio kosong (kemungkinan endpoint menolak request).');
      }
      return Buffer.concat(chunks);
    })();

    // Outer 8s timeout. Edge TTS WebSocket kadang hang tanpa error di
    // first-hit (DNS/auth cold path). 8s = fail-fast supaya frontend bisa
    // retry atau surface error ke user tanpa nunggu.
    const hardTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('EdgeTTS: timeout 8s (endpoint lambat / tidak merespons).')), 8000);
    });

    return await Promise.race([streamPromise, ttsError, hardTimeout]);
  } catch (err) {
    throw new Error(classifyError(err));
  } finally {
    if (onError) process.removeListener('uncaughtException', onError);
  }
}

/**
 * Synthesize satu segmen menjadi MP3 Buffer.
 * @param {{ text: string, gender?: 'male'|'female', voice_config?: { voice_name?: string } }} segment
 * @returns {Promise<Buffer>}
 */
export async function synthesizeSegment(segment) {
  const text = (segment?.text ?? '').toString().trim();
  if (!text) {
    throw new Error('Segment text kosong.');
  }
  const voice = normalizeHint(segment?.voice_config?.voice_name)
    ?? pickVoiceForSegment(segment);
  const pro = prosodyFor(segment?.type, segment?.gender);

  // Per-segment prosody: vary rate/pitch per (type, gender) supaya narasi tidak
  // terdengar robotik / monotone. Indonesian Neural voices hanya punya 2 varian
  // (Ardi male / Gadis female, tidak ada V2 cheerful/serious), jadi variasi
  // ekspresi harus datang dari prosody. Semua nilai signed (+/-) — regex
  // edge-tts-universal `^[+-]\d+(%|Hz)$` reject bare '0%' / '0Hz'.
  return runSynthesize(text, voice, {
    rate: pro.rate,
    volume: pro.volume,
    pitch: pro.pitch,
  });
}

/**
 * Synthesize teks mentah dengan voice eksplisit.
 * Legacy "raw text → MP3" helper untuk caller yang tidak punya segment
 * type/gender (mis. router `/api/tts` request ad-hoc). Tetap pakai prosody
 * neutral karena tidak ada konteks segment untuk menentukan bias ekspresi.
 * @param {string} text
 * @param {string} voice
 * @returns {Promise<Buffer>}
 */
export async function synthesizeText(text, voice = DEFAULT_VOICE_MALE) {
  const cleaned = (text ?? '').toString().trim();
  if (!cleaned) {
    throw new Error('Text kosong.');
  }
  const opts = {
    rate: '+0%',
    volume: '+0%',
    pitch: '+0Hz',
  };
  const key = cacheKey(cleaned, voice, opts);
  const cached = cacheGet(key);
  if (cached) {
    // Sanity check: kalau cached entry corrupt (< MIN_VALID_MP3_SIZE atau
    // bukan MP3 magic bytes), evict dan re-synthesize. Cache bisa berisi
    // corrupt buffer dari cold-start failure sebelumnya.
    if (!isLikelyValidMp3(cached)) {
      console.warn(`[tts] Cached buffer corrupt (size=${cached.length}b), re-synthesize.`);
      cacheEvict(key);
    } else {
      return cached;
    }
  }
  const buffer = await runWithRetry(cleaned, voice, opts);
  if (buffer && isLikelyValidMp3(buffer)) {
    cachePut(key, buffer);
  } else if (buffer) {
    console.warn(`[tts] Synthesized buffer too small/corrupt (size=${buffer.length}b), not cached.`);
  }
  return buffer;
}

/**
 * Validate MP3 file has minimum sane ukuran ATAU ID3/MP3 magic bytes
 * present. Edge TTS kadang return garbage yang size-nya kecil tapi bukan
 * audio playable.
 */
function isLikelyValidMp3(buf) {
  if (!buf || buf.length < MIN_VALID_MP3_SIZE) return false;
  // Check ID3v2 magic ("ID3") di awal ATAU MPEG sync byte (0xFFEx) di awal.
  if (buf.length >= 3) {
    const id3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33; // "ID3"
    if (id3) return true;
  }
  if (buf.length >= 2) {
    const sync = (buf[0] === 0xff) && ((buf[1] & 0xe0) === 0xe0); // MPEG sync
    if (sync) return true;
  }
  // Tidak ada magic bytes terdeteksi — anggap corrupt.
  return false;
}

/**
 * Warm-up: pre-populate cache untuk voice default supaya first user click
 * mendapat instant response. Idempotent (kalau sudah warm, return).
 * Frontend fire-and-forget upon page load.
 *
 * Mengambil 3 short dummy text untuk ARDI (default male). Tidak perlu semua
 * 4 voices di-warm — kartu paling dominan (voice user-set) ambil dari
 * loadStoryAndMessages yang bisa call warmupText(voice) langsung.
 */
let warmupPromise = null;

function warmupText(text, voice) {
  return synthesizeText(text, voice).catch((err) => {
    console.warn(`[tts] warmup(${voice}) gagal: ${err.message}`);
    return null;
  });
}

export async function warmup() {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    const start = Date.now();
    // Parallel preload 4 voices with same short text. Future user clicks
    // untuk voice manapun akan hit cache (< 50ms).
    await Promise.all([
      warmupText('Halo, saya siap membantu Anda.', DEFAULT_VOICE_MALE),
      warmupText('Halo, saya siap membantu Anda.', DEFAULT_VOICE_FEMALE),
      warmupText('Halo, saya siap membantu Anda.', DEFAULT_VOICE_MALE_EN),
      warmupText('Halo, saya siap membantu Anda.', DEFAULT_VOICE_FEMALE_EN),
    ]);
    console.log(`[tts] warmed 4 voices in ${Date.now() - start}ms`);
  })();
  return warmupPromise;
}

/** Warm single voice (called from frontend after reading story.tts_voice). */
export async function warmupVoice(voice) {
  await warmupText('Halo, saya siap membantu Anda.', voice);
}
