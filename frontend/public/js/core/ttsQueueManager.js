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
  // Caller passes explicit voice via segment.voice (currentStory.tts_voice).
  // Fallback ke default Indonesian male kalau tidak ada — supaya legacy tests
  // yang kirim {text, gender} saja tidak crash.
  if (segment && typeof segment.voice === 'string' && segment.voice.trim()) {
    return segment.voice.trim();
  }
  return 'id-ID-ArdiNeural';
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
    this._prefetchedBlob = null;   // Blob untuk segmen berikutnya (pre-fetch)
    this._prefetchedIndex = -1;    // Indeks segmen yang sudah di-pre-fetch
    this._prefetchAbort = null;    // AbortController untuk inflight prefetch
    // Fetch timeout 10s — backend semaphore + retry dengan exponential
    // backoff bisa delay sampai ~6s worst case (3 retry × 2s). Kasih
    // overhead 4s untuk network + semaphore queueing.
    this._fetchTimeoutMs = 10000;
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

    // Pre-fetch hit: segmen berikutnya sudah siap sebelum current selesai.
    if (this._prefetchedBlob && this._prefetchedIndex === this.index) {
      const blob = this._prefetchedBlob;
      this._prefetchedBlob = null;
      this._prefetchedIndex = -1;
      this._prefetchNext(); // pre-fetch segmen N+1 berikutnya
      this._playBlob(blob, segment);
      return;
    }

    // Client-side retry untuk transient failures (HTTP 500/503/timeout).
    // Backend sudah retry 3x di runWithRetry, but defense-in-depth: kalau
    // backend edge TTS gagal semua attempt, client masih bisa retry habis
    // warmup berikutnya.
    const trySynthesize = (attempt) => {
      if (attempt > 2) {
        console.warn('[tts-queue] 2 retries exhausted.');
        window.dispatchEvent(new CustomEvent('tts:playback-failed', {
          detail: { message: 'Audio gagal dimuat setelah retry. Coba lagi.' },
        }));
        this._finish();
        return;
      }
      // Per-attempt fresh abort controller + timeout.
      const controller = new AbortController();
      this._activeAbort = controller;
      this._currentTimeoutId = setTimeout(() => {
        controller.abort();
      }, this._fetchTimeoutMs);

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
            if (!this.playing || this.index >= this.segments.length) return;
            this._prefetchNext(); // pre-fetch segmen N+1 di background
            this._playBlob(blob, segment);
          })
          .catch((err) => {
            clearTimeout(this._currentTimeoutId);
            this._currentTimeoutId = null;
            this._activeAbort = null;
            if (err?.name === 'AbortError') return;
            const isRetryable =
              err.status === 500 || err.status === 503 ||
              err.message?.includes('timeout') ||
              err.message?.includes('EdgeTTS');
            console.warn(`[tts-queue] Fetch gagal (attempt ${attempt + 1}/3):`, err.message);
            if (isRetryable && attempt < 2) {
              // Backoff: ~500ms / ~1.2s.
              const delay = 500 + attempt * 700;
              setTimeout(() => {
                if (this.playing && this.index < this.segments.length) {
                  // Reset abort controller for fresh attempt.
                  trySynthesize(attempt + 1);
                }
              }, delay);
              return;
            }
            // Non-retryable or out of attempts.
            window.dispatchEvent(new CustomEvent('tts:playback-failed', {
              detail: { message: err.message },
            }));
            this._finish();
          });
      }).catch((err) => {
        console.warn('[tts-queue] apiClient import gagal:', err.message);
        this._finish();
      });
    };
    trySynthesize(0);
  }

  /**
   * Pre-fetch segment N+1 di background saat segment N sedang dimainkan.
   * Setelah fetch sukses, blob disimpan di this._prefetchedBlob.
   * Saat audio.onended segment N, langsung pakai prefetched blob tanpa
   * fetch baru → gapless playback.
   */
  _prefetchNext() {
    const nextIdx = this.index + 1;
    if (nextIdx >= this.segments.length) return;
    // Jangan pre-fetch kalau sudah ada blob untuk index yang sama.
    if (this._prefetchedIndex === nextIdx && this._prefetchedBlob) return;

    // Cleanup prefetch sebelumnya yang sudah stale.
    if (this._prefetchAbort) {
      try { this._prefetchAbort.abort(); } catch { /* ignore */ }
      this._prefetchAbort = null;
    }
    this._prefetchedBlob = null;
    this._prefetchedIndex = -1;

    const nextSeg = this.segments[nextIdx];
    if (!nextSeg || !nextSeg.text) return;

    const controller = new AbortController();
    this._prefetchAbort = controller;

    import('../api/apiClient.js').then(({ apiClient }) => {
      apiClient
        .synthesizeTts({
          text: nextSeg.text,
          voice: resolveTtsVoice(nextSeg),
          gender: nextSeg.gender,
          signal: controller.signal,
        })
        .then((blob) => {
          if (this._prefetchAbort !== controller) return; // stale
          this._prefetchAbort = null;
          if (!blob || blob.size < 1024) {
            this._prefetchedBlob = null;
            this._prefetchedIndex = -1;
            return;
          }
          this._prefetchedBlob = blob;
          this._prefetchedIndex = nextIdx;
        })
        .catch((err) => {
          if (err?.name === 'AbortError') return;
          if (this._prefetchAbort !== controller) return;
          this._prefetchAbort = null;
          this._prefetchedBlob = null;
          this._prefetchedIndex = -1;
          // Silent fail — _speakCurrent() akan fetch ulang saat giliran.
        });
    }).catch(() => {}); // dynamic import gagal → silent
  }

  _playBlob(blob, segment) {
    // Empty / corrupt MP3 check. Backend kadang return tiny response (error
    // body atau upstream failure). Jangan retry — itu sama saja dengan
    // looping tak hingga. Stop total supaya user lihat playback selesai
    // daripada stuck di retry spinner.
    if (!blob || blob.size < 1024) {
      console.warn(`[tts-queue] Blob kosong/corrupt (size=${blob?.size ?? 0}b) — stop.`);
      this._disposeCurrent();
      this._finish();
      return;
    }
    const url = URL.createObjectURL(blob);
    this._currentBlobUrl = url;
    const audio = new Audio(url);
    this._currentAudioEl = audio;
    let retried = false;
    let startedDispatched = false;

    const dispatchStarted = () => {
      if (startedDispatched) return;
      startedDispatched = true;
      try {
        window.dispatchEvent(new CustomEvent('tts:playback-started'));
      } catch { /* ignore */ }
    };

    audio.onended = () => {
      const a = this._currentAudioEl;
      if (a) {
        a.onended = a.onerror = a.onloadedmetadata = a.oncanplay = a.onplaying = a.ontimeupdate = null;
      }
      this._disposeCurrent();
      this.clearHighlight();
      this.index += 1;
      if (this.index >= this.segments.length) {
        this._finish();
        return;
      }
      if (this.playing) this._speakCurrent();
    };

    const detachListeners = (a) => {
      if (!a) return;
      a.onended = a.onerror = a.onloadedmetadata = a.oncanplay = a.onplaying = a.ontimeupdate = null;
    };

    const advanceAfterFailure = (reason) => {
      console.warn(`[tts-queue] ${reason} — lanjut segment berikutnya.`);
      detachListeners(this._currentAudioEl);
      this._disposeCurrent();
      this.clearHighlight();
      this.index += 1;
      if (this.index >= this.segments.length) {
        this._finish();
        return;
      }
      if (this.playing) this._speakCurrent();
    };

    const retryOnce = (why) => {
      if (retried) {
        advanceAfterFailure(`${why} setelah retry — stop`);
        return;
      }
      retried = true;
      console.warn(`[tts-queue] ${why}, retrying segment.`);
      detachListeners(this._currentAudioEl);
      this._disposeCurrent();
      if (this.playing) this._speakCurrent();
    };

    // Decode-success detection. `loadedmetadata` fires setelah MP3 berhasil
    // di-decode. Transition state di sini, bukan di play().
    audio.onloadedmetadata = () => {
      console.log(`[tts-queue] audio metadata loaded segment ${this.index} (dur=${audio.duration}s)`);
      dispatchStarted();
    };
    audio.oncanplay = () => {
      // Backup safety kalau loadedmetadata skip
      dispatchStarted();
    };
    audio.onplaying = () => {
      console.log(`[tts-queue] audio playing segment ${this.index}`);
      dispatchStarted();
    };
    audio.ontimeupdate = () => {
      // Backup safety: kalau audio sudah流 beberapa ms, anggap mulai.
      if (!startedDispatched && audio.currentTime > 0.05) {
        dispatchStarted();
      }
    };
    audio.onerror = (e) => {
      // Decode error. Bisa terjadi karena:
      //   a) Corrupt MP3 — early failure, audio belum流 masuk. Trigger retry.
      //   b) End-of-stream edge error (Chrome quirk) — audio SUDAH bermain
      //      sampai currentTime mendekati duration. Harus treat sebagai natural
      //      end, BUKAN failure. Kalau dipaksa retryOnce, single-chunk akan
      //      fall ke advanceAfterFailure → _finish() dan bunyi berhenti di
      //      tengah padahal secara visual audio sudah selesai.
      const nearEnd = audio.duration && audio.currentTime >= audio.duration - 0.5;
      const wasPlaying = startedDispatched;
      console.warn(`[tts-queue] Audio decode error: ${e?.type || 'unknown'} cur=${audio.currentTime.toFixed(2)}/${audio.duration}s nearEnd=${nearEnd} started=${wasPlaying}`);
      dispatchStarted();
      if (nearEnd || wasPlaying) {
        // Treat as natural completion — jangan retry, jangan advance.
        detachListeners(this._currentAudioEl);
        this._disposeCurrent();
        this.clearHighlight();
        this.index += 1;
        if (this.index >= this.segments.length) {
          this._finish();
        } else if (this.playing) {
          this._speakCurrent();
        }
        return;
      }
      retryOnce(`Audio decode error (${e?.type || 'unknown'})`);
    };

    audio.play().then(() => {
      dispatchStarted();
    }).catch((err) => {
      console.warn('[tts-queue] audio.play() rejected:', err.message);
      detachListeners(audio);
      retryOnce(`audio.play() rejected (${err.message})`);
    });
  }

  _speakFallbackBrowser(segment, onEnd) {
    // Tidak ada Web Speech fallback. Kalau tidak ada audio, langsung onEnd
    // supaya queue advance ke segment berikutnya.
    console.warn('[tts-queue] Web Speech fallback dihapus — skip segment dan lanjut.');
    onEnd?.();
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

  /** Cleanup semua resource termasuk prefetch blob/abort. */
  _disposeAll() {
    this._disposeCurrent();
    if (this._prefetchAbort) {
      try { this._prefetchAbort.abort(); } catch { /* ignore */ }
      this._prefetchAbort = null;
    }
    if (this._prefetchedBlob) {
      this._prefetchedBlob = null;
    }
    this._prefetchedIndex = -1;
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
    this._disposeAll();
    try {
      window.speechSynthesis.cancel();
    } catch { /* ignore */ }
    this.clearHighlight();
    this.index = 0;
    this.emit('state', this.snapshot());
  }

  skipToNext() {
    if (!this.playing && !this.paused) return;
    this._disposeAll();
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
    this._disposeAll();
    this.emit('state', this.snapshot());
    dispatchPlaybackFinished();
  }
}

// Bug-B6 root cause fix: SPA navigate Dashboard → kembali Story → replay
// silent failure. Window unload flush audio element + Blob URL + abort
// in-flight fetch + Web Speech cancellation. Fresh module-load tidak
// auto-reset singleton, jadi listener ini panggil _disposeCurrent() dan
// reset semua state untuk memastikan next mount tidak start dengan
// stale reference.
//
// Singleton export — story.page.js juga import ini untuk klik handler.
export const ttsQueue = new TtsQueueManager();

function hardResetOnHide() {
  if (ttsQueue && typeof ttsQueue._disposeAll === 'function') {
    ttsQueue._disposeAll();
    ttsQueue.playing = false;
    ttsQueue.paused = false;
    ttsQueue.index = 0;
    ttsQueue.currentUtterance = null;
    ttsQueue.currentSegmentEl = null;
  }
  try {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.pause?.();
    }
  } catch { /* ignore */ }
}

if (typeof window !== 'undefined') {
  // pagehide fires lebih reliable dari beforeunload (e.g. when in bfcache).
  window.addEventListener('pagehide', hardResetOnHide);
  window.addEventListener('beforeunload', hardResetOnHide);
  // visibilitychange ke 'hidden' = user switch tab / start navigate — pre-flush.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hardResetOnHide();
  });
}

function langFilter(lang) {
  if (!lang) return '';
  return lang.toLowerCase().split('-')[0];
}
