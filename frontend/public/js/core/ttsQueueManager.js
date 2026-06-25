import { parseTaggedSegments, pickVoiceForPreset, loadBrowserVoices } from './ttsEngine.js';

/**
 * Antrian pemutaran TTS. Kontrol transport sesuai Bab 7.4.
 * Event yang di-emit: 'state', 'segment'.
 */
export class TtsQueueManager {
  constructor() {
    this.segments = [];
    this.index = 0;
    this.playing = false;
    this.paused = false;
    this.presets = [];
    this.voices = [];
    this.subscribers = new Set();
    this.currentUtterance = null;
    this.currentSegmentEl = null;
    this.langFilter = null;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.subscribers) {
      try { fn(event, payload); } catch { /* ignore */ }
    }
  }

  setPresets(presets) {
    this.presets = Array.isArray(presets) ? presets : [];
  }

  async ensureVoices() {
    if (this.voices.length > 0) return this.voices;
    this.voices = await loadBrowserVoices();
    return this.voices;
  }

  setLangFilter(lang) {
    this.langFilter = lang;
  }

  getFilteredVoices() {
    if (!this.langFilter) return this.voices;
    return this.voices.filter((v) => v.lang?.toLowerCase().startsWith(langFilter(lang)));
  }

  enqueueFromText(rawText) {
    const parsed = parseTaggedSegments(rawText);
    this.segments = parsed;
    this.index = 0;
    this.emit('state', this.snapshot());
  }

  enqueueSegments(segments) {
    this.segments = segments ?? [];
    this.index = 0;
    this.emit('state', this.snapshot());
  }

  snapshot() {
    return {
      total: this.segments.length,
      index: this.index,
      playing: this.playing,
      paused: this.paused,
      current: this.segments[this.index] ?? null,
    };
  }

  resolvePresetForTag(tag) {
    if (!this.presets.length) return null;
    return (
      this.presets.find((p) => p.tag_name === tag) ??
      this.presets.find((p) => p.tag_name === 'NARASI') ??
      null
    );
  }

  attachCurrentSegmentElement(el) {
    this.currentSegmentEl = el;
  }

  highlightCurrentSegment() {
    if (this.currentSegmentEl && this.currentSegmentEl.dataset) {
      this.currentSegmentEl.dataset.ttsActive = '1';
      this.currentSegmentEl.classList?.add('highlight-segment');
    }
  }

  clearHighlight() {
    if (this.currentSegmentEl) {
      this.currentSegmentEl.classList?.remove('highlight-segment');
    }
  }

  async play() {
    if (!('speechSynthesis' in window)) return;
    if (this.segments.length === 0) return;
    if (this.playing && !this.paused) return;

    await this.ensureVoices();

    if (this.paused) {
      this.paused = false;
      try { window.speechSynthesis.resume(); } catch { /* ignore */ }
      this.playing = true;
      this.emit('state', this.snapshot());
      return;
    }

    this.playing = true;
    this.paused = false;
    this._speakCurrent();
  }

  _speakCurrent() {
    if (!this.playing) return;
    if (this.index >= this.segments.length) {
      this._finish();
      return;
    }
    const segment = this.segments[this.index];
    const preset = this.resolvePresetForTag(segment.tag);
    const voice = preset ? pickVoiceForPreset(preset, this.voices) : this.voices[0];

    const utter = new SpeechSynthesisUtterance(segment.text);
    if (voice) utter.voice = voice;
    if (preset) {
      utter.pitch = clamp(preset.pitch ?? 1.0, 0, 2);
      utter.rate = clamp(preset.rate ?? 1.0, 0.1, 10);
    }
    utter.lang = voice?.lang ?? 'id-ID';

    this.currentUtterance = utter;
    this.highlightCurrentSegment();
    this.emit('segment', { index: this.index, segment });

    utter.onend = () => {
      this.clearHighlight();
      this.index += 1;
      if (this.index >= this.segments.length) {
        this._finish();
        return;
      }
      if (this.playing) this._speakCurrent();
    };
    utter.onerror = () => {
      this.clearHighlight();
      this.index += 1;
      if (this.playing) this._speakCurrent();
    };

    try {
      window.speechSynthesis.speak(utter);
    } catch {
      this._finish();
    }
  }

  pause() {
    if (!this.playing) return;
    this.paused = true;
    this.playing = false;
    try { window.speechSynthesis.pause(); } catch { /* fallback handled in resume */ }
    this.emit('state', this.snapshot());
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.playing = true;
    try { window.speechSynthesis.resume(); } catch { /* ignore */ }
    this.emit('state', this.snapshot());
  }

  stop() {
    this.playing = false;
    this.paused = false;
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    this.clearHighlight();
    this.index = 0;
    this.emit('state', this.snapshot());
  }

  skipToNext() {
    if (!this.playing && !this.paused) return;
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }

  _finish() {
    this.playing = false;
    this.paused = false;
    this.index = 0;
    this.clearHighlight();
    this.emit('state', this.snapshot());
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, Number(v) || 0));
}

function langFilter(lang) {
  if (!lang) return '';
  return lang.toLowerCase().split('-')[0];
}
