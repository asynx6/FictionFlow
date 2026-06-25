/**
 * Edge TTS synthesizer service.
 *
 * Menggunakan @lixen/edge-tts yang berbicara ke Microsoft Edge TTS endpoint
 * (gratis, tidak butuh API key). Voice output fixed MP3 48kbitrate mono.
 *
 * Pack names (single source of truth):
 *   - id-ID : ArdiNeural (male / narration) + GadisNeural (female)
 *   - en-US : GuyNeural (male / narration)  + JennyNeural (female)
 */

import pkg from '@lixen/edge-tts';
const { EdgeTTS } = pkg;

export const DEFAULT_VOICE_MALE = 'id-ID-ArdiNeural';
export const DEFAULT_VOICE_FEMALE = 'id-ID-GadisNeural';
export const DEFAULT_VOICE_MALE_EN = 'en-US-GuyNeural';
export const DEFAULT_VOICE_FEMALE_EN = 'en-US-JennyNeural';

export const VALID_PACKS = new Set(['id-ID', 'en-US']);

/**
 * Strip suffix non-Neural (-Male / -Female / -M / -F) yang kadang muncul di
 * hint LLM lama agar tidak error di EdgeTTS endpoint. Mis.
 *   id-ID-Ardi-Male   → id-ID-ArdiNeural
 *   id-ID-Gadis-Female → id-ID-GadisNeural
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

async function runSynthesize(text, voice, options) {
  // @lixen/edge-tts hanya listen `ws.on('close', resolve)`. Saat endpoint Microsoft
  // menutup socket dengan HTTP 403 (network/IP diblok), event 'error' naik tanpa
  // listener → uncaughtException → server.js process.exit(1) → backend restart.
  //
  // Mitigasi: pasang one-shot listener spesifik yang mengubah throw jadi
  // Promise rejection → route handler bisa mengembalikan HTTP 502 alih-alih
  // crash. Listener selalu dihapus (named-reference removal) di finally agar
  // handler global server.js tetap utuh untuk error non-TTS.
  let onError;
  const ttsError = new Promise((_, reject) => {
    onError = (err) => {
      reject(new Error(`EdgeTTS WebSocket error: ${err && err.message ? err.message : err}`));
    };
    process.once('uncaughtException', onError);
  });

  const tts = new EdgeTTS();
  try {
    await Promise.race([tts.synthesize(text, voice, options), ttsError]);
  } finally {
    if (onError) process.removeListener('uncaughtException', onError);
  }

  if (tts.audio_stream.length === 0) {
    throw new Error('EdgeTTS: stream audio kosong (kemungkinan endpoint menolak request).');
  }
  const b64 = tts.toRaw();
  return Buffer.from(b64, 'base64');
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

  return runSynthesize(text, voice, {
    pitch: '0Hz',
    rate: '0%',
    volume: '0%',
  });
}

/**
 * Synthesize teks mentah dengan voice eksplisit.
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
    pitch: '0Hz',
    rate: '0%',
    volume: '0%',
  });
}
