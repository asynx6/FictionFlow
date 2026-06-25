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

export const DEFAULT_VOICE_MALE = 'id-ID-ArdiNeural';
export const DEFAULT_VOICE_FEMALE = 'id-ID-GadisNeural';
export const DEFAULT_VOICE_MALE_EN = 'en-US-GuyNeural';
export const DEFAULT_VOICE_FEMALE_EN = 'en-US-JennyNeural';

export const VALID_PACKS = new Set(['id-ID', 'en-US']);

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
    connectionTimeout: options.connectionTimeout ?? 15000,
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

    return await Promise.race([streamPromise, ttsError]);
  } catch (err) {
    // Re-throw dengan pesan yang lebih diagnosable.
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
  return runSynthesize(cleaned, voice, {
    rate: '+0%',
    volume: '+0%',
    pitch: '+0Hz',
  });
}
