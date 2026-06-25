/**
 * TTS engine — parsing tag dan voice mapping (Bab 7).
 * Beroperasi 100% di client, tanpa dependency backend.
 */

const TAG_PATTERN = /\[([A-Z0-9_]+)\]/g;
const NARRATION_FALLBACK_TAG = 'NARASI';

/**
 * Memecah teks mentah ber-tag jadi daftar segmen { tag, text }.
 * - Tag kosong / tidak ada tag di awal teks -> default NARASI.
 * - Whitespace dipotong di tiap segmen.
 */
export function parseTaggedSegments(rawText) {
  if (!rawText) return [];
  const text = String(rawText);
  const matches = [];
  let m;
  while ((m = TAG_PATTERN.exec(text)) !== null) {
    matches.push({ name: m[1], index: m.index, end: m.index + m[0].length });
  }
  TAG_PATTERN.lastIndex = 0;

  if (matches.length === 0) {
    const trimmed = text.trim();
    if (!trimmed) return [];
    return [{ tag: NARRATION_FALLBACK_TAG, text: trimmed }];
  }

  const segments = [];
  for (let i = 0; i < matches.length; i++) {
    const curr = matches[i];
    const next = matches[i + 1];
    const startPos = curr.end;
    const endPos = next ? next.index : text.length;
    const chunk = text.slice(startPos, endPos).trim();
    if (chunk) {
      segments.push({ tag: curr.name, text: chunk });
    }
  }
  return segments;
}

/**
 * Memilih voice browser yang paling cocok dengan preferensi preset.
 * - voice_uri_hint: lookup exact nama (case-insensitive substring match).
 * - genderHint: filter berdasarkan nama voice mengandung 'female'/'male'.
 * - Fallback: voice pertama yang tersedia, atau null.
 */
export function pickVoiceForPreset(preset, availableVoices) {
  if (!availableVoices || availableVoices.length === 0) return null;

  const hint = (preset.voice_uri_hint ?? '').toString().trim();
  if (hint) {
    const needle = hint.toLowerCase();
    const exact = availableVoices.find((v) => v.name.toLowerCase() === needle);
    if (exact) return exact;
    const partial = availableVoices.find((v) => v.name.toLowerCase().includes(needle));
    if (partial) return partial;
  }

  if (preset.gender_hint) {
    const g = preset.gender_hint;
    const match = availableVoices.find((v) => {
      const n = v.name.toLowerCase();
      if (g === 'female') return /female|woman|zira|samantha|veena|tika/.test(n);
      if (g === 'male') return /male|man|david|mark|daniel/.test(n);
      return true;
    });
    if (match) return match;
  }

  return availableVoices[0] ?? null;
}

/**
 * Mengambil daftar voice dari Web Speech API dengan menunggu onvoiceschanged.
 */
export function loadBrowserVoices(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      resolve([]);
      return;
    }
    const synth = window.speechSynthesis;
    const ready = () => {
      const voices = synth.getVoices();
      if (voices && voices.length > 0) {
        resolve(voices);
        return true;
      }
      return false;
    };

    if (ready()) return;

    let resolved = false;
    const onChange = () => {
      if (resolved) return;
      if (ready()) {
        resolved = true;
        synth.removeEventListener('voiceschanged', onChange);
        resolve(window.speechSynthesis.getVoices());
      }
    };
    synth.addEventListener?.('voiceschanged', onChange);

    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      synth.removeEventListener?.('voiceschanged', onChange);
      resolve(window.speechSynthesis.getVoices() ?? []);
    }, timeoutMs);
  });
}

// Minimal TTS Engine Wrapper to satisfy story.page.js interface
export const ttsEngine = {
  voices: [],
  selectedVoice: null,
  async init() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
    this.voices = await loadBrowserVoices();
    return true;
  },
  getVoices() { return this.voices; },
  setVoice(index) { this.selectedVoice = this.voices[index]; },
  parseTtsText(text) { return text.replace(/<notts>[\s\S]*?<\/notts>/g, '').trim(); },
  speak(text) {
    if (!text || !this.selectedVoice) return;
    try {
      const utter = new SpeechSynthesisUtterance(text);
      utter.voice = this.selectedVoice;
      utter.lang = this.selectedVoice.lang || 'id-ID';
      window.speechSynthesis.speak(utter);
    } catch (err) {
      console.warn('TTS Speak Error:', err);
    }
  }
};
