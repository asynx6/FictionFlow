/**
 * Edge TTS synthesizer service.
 *
 * Menggunakan @lixen/edge-tts yang berbicara ke Microsoft Edge TTS endpoint
 * (gratis, tidak butuh API key). Voice output fixed MP3 48kbitrate mono.
 *
 * Voice mapping default:
 *   - male / narration → id-ID-ArdiNeural
 *   - female           → id-ID-GadisNeural
 */

import pkg from '@lixen/edge-tts';
const { EdgeTTS } = pkg;

export const DEFAULT_VOICE_MALE = 'id-ID-ArdiNeural';
export const DEFAULT_VOICE_FEMALE = 'id-ID-GadisNeural';

function pickVoiceForSegment(segment) {
  if (!segment) return DEFAULT_VOICE_MALE;
  if (segment.gender === 'female') return DEFAULT_VOICE_FEMALE;
  if (segment.gender === 'male') return DEFAULT_VOICE_MALE;
  // narration → male, dialogue → sesuai gender karakter
  return DEFAULT_VOICE_MALE;
}

async function runSynthesize(text, voice, options) {
  const tts = new EdgeTTS();
  await tts.synthesize(text, voice, options);
  // toRaw() return base64 string → decode ke Buffer
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
  const hint = segment?.voice_config?.voice_name;
  const voice = hint && typeof hint === 'string' && hint.trim()
    ? hint.trim()
    : pickVoiceForSegment(segment);

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
