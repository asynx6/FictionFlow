import { parseTaggedSegments, pickVoiceForPreset, loadBrowserVoices } from './ttsEngine.js';

/**
 * Voice pack → EdgeTTS voice_name mapping. Sumber kebenaran tunggal.
 * Pack 'en-US' = US English (GuyNeural male / JennyNeural female).
 * Pack 'id-ID' = Indonesian (ArdiNeural male / GadisNeural female).
 * Hint dari LLM diabaikan — LLM kadang output nama yang tidak valid; pack user menang.
 */
function edgeVoiceForPack(pack, gender) {
  const g = (gender ?? '').toString();
  if (pack === 'en-US') {
    return g === 'female' ? 'en-US-JennyNeural' : 'en-US-GuyNeural';
  }
  return g === 'female' ? 'id-ID-GadisNeural' : 'id-ID-ArdiNeural';
}

function getActivePack() {
  try {
    return (localStorage.getItem('fictionflow_voice_pack') || 'id-ID').toString();
  } catch {
    return 'id-ID';
  }
}

function resolveTtsVoice(segment) {
  return edgeVoiceForPack(getActivePack(), segment?.gender);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, Number(v) || 0));
}

/**
 * Dispatch DOM CustomEvent 'tts:playback-finished' setiap kali playback selesai
 * secara natural (semua segment selesai atau segment terakhir onended).
 * story.page.js listen event ini untuk reset currentUtterance.
 * Hanya fire kalau TTS memang sudah selesai, bukan saat user stop manual.
 */
function dispatchPlaybackFinished() {
  try {
    window.dispatchEvent(new CustomEvent('tts:playback-finished'));
  } catch { /* ignore */ }
}


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
    // Hybrid playback internal state.
    this._currentAudioEl = null;
    this._currentBlobUrl = null;
    this._activeAbort = null;
    this._currentTimeoutId = null;
    this._fetchTimeoutMs = 8000;
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

    this.highlightCurrentSegment();
    this.emit('segment', { index: this.index, segment });

    // Cleanup state sebelumnya (jangan leak Blob URL antar segment).
    this._disposeCurrent();

    const controller = new AbortController();
    this._activeAbort = controller;

    // Timeout fetch 8s; abort kalau masih loading setelah itu.
    this._currentTimeoutId = setTimeout(() => {
      controller.abort();
    }, this._fetchTimeoutMs);

    const segmentForFallback = segment;
    const fallbackAndAdvance = () => {
      this._speakFallbackBrowser(segmentForFallback, () => {
        this.clearHighlight();
        this.index += 1;
        if (this.playing) this._speakCurrent();
      });
    };

    import('../api/apiClient.js').then(({ apiClient }) => {
      apiClient
        .synthesizeTts({
          text: segment.text,
          voice: resolveTtsVoice(segment),
          gender: segment.gender,
          signal: controller.signal,
        })
        .then((blob) => {
          clearTimeout(this._currentTimeoutId);
          this._currentTimeoutId = null;
          this._activeAbort = null;
          if (!this.playing || this.index >= this.segments.length) {
            // Mungkin di-stop saat loading.
            return;
          }
          this._playBlob(blob, segmentForFallback, fallbackAndAdvance);
        })
        .catch((err) => {
          clearTimeout(this._currentTimeoutId);
          this._currentTimeoutId = null;
          this._activeAbort = null;
          if (err?.name === 'AbortError') {
            // User stop: diam saja, no fallback.
            return;
          }
          console.warn('[tts-queue] Fetch gagal:', err.message);
          fallbackAndAdvance();
        });
    }).catch((err) => {
      // Module import gagal (offline / 404) → fallback Web Speech langsung.
      clearTimeout(this._currentTimeoutId);
      this._currentTimeoutId = null;
      this._activeAbort = null;
      console.warn('[tts-queue] apiClient import gagal:', err.message);
      fallbackAndAdvance();
    });
  }

  _playBlob(blob, segmentForFallback, fallbackAndAdvance) {
    const url = URL.createObjectURL(blob);
    this._currentBlobUrl = url;
    const audio = new Audio(url);
    this._currentAudioEl = audio;

    audio.onended = () => {
      this._disposeCurrent();
      this.clearHighlight();
      this.index += 1;
      if (this.index >= this.segments.length) {
        this._finish();
        return;
      }
      if (this.playing) this._speakCurrent();
    };
    audio.onerror = () => {
      console.warn('[tts-queue] Audio decode error, fallback Web Speech.');
      this._disposeCurrent();
      fallbackAndAdvance();
    };

    audio.play().catch((err) => {
      console.warn('[tts-queue] audio.play() rejected:', err.message);
      // Detach handlers biar onended/onerror tidak double-trigger fallbackAndAdvance.
      audio.onended = null;
      audio.onerror = null;
      this._disposeCurrent();
      fallbackAndAdvance();
    });
  }

  _speakFallbackBrowser(segment, onEnd) {
    if (!('speechSynthesis' in window)) {
      // Tidak ada fallback apapun.
      onEnd?.();
      return;
    }
    const pack = getActivePack();
    const utter = new SpeechSynthesisUtterance(segment.text);
    const voice = (this.voices ?? []).find(
      (v) => (v.lang || '').toLowerCase() === pack.toLowerCase()
    ) ?? (this.voices ?? []).find(
      (v) => (v.lang || '').toLowerCase().startsWith(pack.split('-')[0])
    );
    if (voice) utter.voice = voice;
    utter.lang = pack;
    utter.onend = () => onEnd?.();
    utter.onerror = () => onEnd?.();
    try {
      window.speechSynthesis.speak(utter);
    } catch {
      onEnd?.();
    }
  }

  _disposeCurrent() {
    if (this._currentAudioEl) {
      try {
        this._currentAudioEl.pause();
        this._currentAudioEl.src = '';
      } catch { /* ignore */ }
      this._currentAudioEl = null;
    }
    if (this._currentBlobUrl) {
      try {
        URL.revokeObjectURL(this._currentBlobUrl);
      } catch { /* ignore */ }
      this._currentBlobUrl = null;
    }
    if (this._currentTimeoutId) {
      clearTimeout(this._currentTimeoutId);
      this._currentTimeoutId = null;
    }
    if (this._activeAbort) {
      try {
        this._activeAbort.abort();
      } catch { /* ignore */ }
      this._activeAbort = null;
    }
  }

  pause() {
    if (!this.playing) return;
    this.paused = true;
    // Pause audio element kalau sudah播放 segment.
    if (this._currentAudioEl) {
      try {
        this._currentAudioEl.pause();
      } catch { /* ignore */ }
    }
    // Clear timeout agar tidak auto-abort saat paused.
    if (this._currentTimeoutId) {
      clearTimeout(this._currentTimeoutId);
      this._currentTimeoutId = null;
    }
    // Pause fallback Web Speech kalau ada.
    try {
      window.speechSynthesis.pause();
    } catch { /* ignore */ }
    this.emit('state', this.snapshot());
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this._currentAudioEl) {
      this._currentAudioEl.play().catch(() => {
        // Resume gagal → fallback web speech untuk segmen yang sedang berjalan.
        const seg = this.segments[this.index];
        if (seg) this._speakFallbackBrowser(seg, () => {
          this.index += 1;
          if (this.playing) this._speakCurrent();
        });
      });
      this.emit('state', this.snapshot());
      return;
    }
    // Belum ada audio (mungkin masih loading atau sedang di Web Speech fallback).
    try {
      window.speechSynthesis.resume();
    } catch { /* ignore */ }
    this.emit('state', this.snapshot());
  }

  stop() {
    this.playing = false;
    this.paused = false;
    this._disposeCurrent();
    try {
      window.speechSynthesis.cancel();
    } catch { /* ignore */ }
    this.clearHighlight();
    this.index = 0;
    this.emit('state', this.snapshot());
  }

  skipToNext() {
    if (!this.playing && !this.paused) return;
    this._disposeCurrent();
    try {
      window.speechSynthesis.cancel();
    } catch { /* ignore */ }
    this.clearHighlight();
    this.index += 1;
    if (this.index >= this.segments.length) {
      this._finish();
      return;
    }
    if (this.playing) this._speakCurrent();
    else this.emit('state', this.snapshot());
  }

  _finish() {
    this.playing = false;
    this.paused = false;
    this.index = 0;
    this.clearHighlight();
    this.emit('state', this.snapshot());
    dispatchPlaybackFinished();
  }
}

function langFilter(lang) {
  if (!lang) return '';
  return lang.toLowerCase().split('-')[0];
}
