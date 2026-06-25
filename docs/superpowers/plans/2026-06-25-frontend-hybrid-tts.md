# Frontend Hybrid TTS Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ttsQueueManager` jadi single source of truth untuk audio playback di frontend. Primary: fetch `POST /api/tts` → MP3 Blob → `new Audio(blob:url).play()`. Fallback: Web Speech API. No Blob URL leak. No in-flight fetch menggantung saat user stop.

**Architecture:** Rewrite `ttsQueueManager._speakCurrent()` jadi hybrid fetch+blob+audio dengan Web Speech fallback dalam queue manager. `story.page.js` delegate mixed-mode playback ke queue manager dan shrink `currentUtterance` jadi UI-only state. `apiClient.synthesizeTts` diperluas untuk support `AbortSignal`.

**Tech Stack:** Vanilla JS (ES modules), `@lixen/edge-tts` (backend), HTML5 Audio + SpeechSynthesis, AbortController.

**Spec:** `docs/superpowers/specs/2026-06-25-frontend-hybrid-tts-design.md`

**Testing strategy:** Manual smoke via browser DevTools (lihat test plan section di spec). Tidak ada test runner per file — verification dilakukan dengan Playwright manual di akhir.

---

### Task 1: Perluas `apiClient.synthesizeTts` untuk support `signal`

**Files:**
- Modify: `frontend/public/js/api/apiClient.js:136-153`

- [ ] **Step 1: Update `synthesizeTts` signature**

Replace existing `synthesizeTts` (lines 136-153) dengan versi baru yang menerima `signal`:

```js
  /**
   * POST /api/tts → audio/mpeg MP3 Blob.
   * Backend pakai @lixen/edge-tts (Microsoft Edge TTS endpoint, tanpa API key).
   * Body: { text, voice?, gender? }
   * @param {{ text: string, voice?: string, gender?: 'male'|'female', signal?: AbortSignal }} opts
   * @returns {Promise<Blob>}
   */
  synthesizeTts: async ({ text, voice, gender, signal }) => {
    const res = await fetch(`${BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, gender }),
      signal,
    });
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.message) errMsg = body.message;
      } catch { /* ignore */ }
      const err = new Error(errMsg);
      err.status = res.status;
      throw err;
    }
    return res.blob();
  },
```

- [ ] **Step 2: Verify no syntax error**

Run: `node --check frontend/public/js/api/apiClient.js 2>&1 || true`
Expected: jika ada syntax error, fix. (File ESM tapi `node --check` masih bisa validasi sintaks.)

- [ ] **Step 3: Commit**

```bash
git add frontend/public/js/api/apiClient.js
git commit -m "feat(api-client): support AbortSignal in synthesizeTts"
```

---

### Task 2: Tulis helper `resolveTtsVoice` di `ttsQueueManager`

**Files:**
- Modify: `frontend/public/js/core/ttsQueueManager.js:1-19`

- [ ] **Step 1: Tambah `resolveTtsVoice` di top-level (di bawah imports)**

Sisipkan setelah line 1 (sebelum class declaration):

```js
function resolveTtsVoice(segment) {
  const hint = segment?.voice_config?.voice_name;
  if (hint && typeof hint === 'string' && hint.trim()) return hint.trim();
  if (segment?.gender === 'female') return 'id-ID-GadisNeural';
  return 'id-ID-ArdiNeural';
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, Number(v) || 0));
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/public/js/core/ttsQueueManager.js
git commit -m "feat(tts-queue): add resolveTtsVoice + clamp helpers"
```

---

### Task 3: Tambah state internal untuk hybrid (audio element, blob URL, abort, timeout)

**Files:**
- Modify: `frontend/public/js/core/ttsQueueManager.js:7-19`

- [ ] **Step 1: Tambah fields di constructor (replace bagian constructor block 7-19)**

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add frontend/public/js/core/ttsQueueManager.js
git commit -m "feat(tts-queue): hybrid playback internal state"
```

---

### Task 4: Hapus legacy Web Speech path dari queue manager (prep untuk rewrite)

**Files:**
- Modify: `frontend/public/js/core/ttsQueueManager.js`

- [ ] **Step 1: Replace method `_speakCurrent()` (lines 120-162) dengan stub kosong**

Replace block `_speakCurrent` keseluruhan dengan stub. Logika akan diisi di Task 5.

```js
  _speakCurrent() {
    // Implementation dipindah ke hybrid playback di Task 5.
  }
```

- [ ] **Step 2: Pause/resume/stop logic tetap (sudah Web Speech-only; akan direfactor ulang di Task 6)**

Tidak diubah di task ini. Teknis: pass-through untuk Web Speech path.

**Catatan**: Task 5 akan rewrite `_speakCurrent` jadi hybrid. Task 6 akan rewrite `pause/resume/stop` agar support audio element.

- [ ] **Step 3: Commit**

```bash
git add frontend/public/js/core/ttsQueueManager.js
git commit -m "refactor(tts-queue): stub _speakCurrent untuk hybrid rewrite"
```

---

### Task 5: Implement hybrid `_speakCurrent()` — fetch → blob → audio → fallback

**Files:**
- Modify: `frontend/public/js/core/ttsQueueManager.js`

- [ ] **Step 1: Replace stub `_speakCurrent()` (Task 4) dengan implementasi hybrid penuh**

```js
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
      if (this.playing) this._speakCurrent();
    };
    audio.onerror = () => {
      console.warn('[tts-queue] Audio decode error, fallback Web Speech.');
      this._disposeCurrent();
      fallbackAndAdvance();
    };

    audio.play().catch((err) => {
      console.warn('[tts-queue] audio.play() rejected:', err.message);
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
    const utter = new SpeechSynthesisUtterance(segment.text);
    const voice = (this.voices ?? []).find(
      (v) => v.lang?.toLowerCase().startsWith((segment?.voice_config?.locale ?? 'id-id').split('-')[0])
    );
    if (voice) utter.voice = voice;
    utter.lang = segment?.voice_config?.locale ?? 'id-ID';
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
```

- [ ] **Step 2: Verify tidak ada syntax error**

Run: `node --check frontend/public/js/core/ttsQueueManager.js 2>&1 || true`
Expected: tidak ada error.

- [ ] **Step 3: Commit**

```bash
git add frontend/public/js/core/ttsQueueManager.js
git commit -m "feat(tts-queue): hybrid playback - fetch blob + Audio + Web Speech fallback"
```

---

### Task 6: Refactor `pause()`/`resume()`/`stop()` di queue manager untuk audio element

**Files:**
- Modify: `frontend/public/js/core/ttsQueueManager.js`

- [ ] **Step 1: Replace `pause()` method**

Find current `pause()` yang isinya `window.speechSynthesis.pause()`. Replace dengan:

```js
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
```

- [ ] **Step 2: Replace `resume()` method**

```js
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
```

- [ ] **Step 3: Replace `stop()` method**

```js
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
```

- [ ] **Step 4: Replace `skipToNext()` method (jika ada)**

```js
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
```

- [ ] **Step 5: Commit**

```bash
git add frontend/public/js/core/ttsQueueManager.js
git commit -m "feat(tts-queue): pause/resume/stop/skip untuk hybrid audio element"
```

---

### Task 7: Refactor `story.page.js` — delegate mixed-mode ke queue manager

**Files:**
- Modify: `frontend/public/js/pages/story.page.js`
  - Tambahkan import `TtsQueueManager`
  - Refactor `playSegment`, `playNextSegment`, `playSegmentBrowser`
  - Refactor `speakMessage` mixed-mode branch
  - Refactor `pauseSpeaking`, `resumeSpeaking`, `stopSpeaking`
  - Shrink `currentUtterance`

- [ ] **Step 1: Add import**

Tambah setelah line 5 (setelah import `markdownRenderer`):

```js
import { TtsQueueManager } from '../core/ttsQueueManager.js';
```

- [ ] **Step 2: Instantiate queue manager**

Tambah setelah line 35 (setelah deklarasi `currentUtterance`):

```js
const ttsQueue = new TtsQueueManager();
```

- [ ] **Step 3: Shrink `currentUtterance` shape**

Find baris 23-35 (`const currentUtterance = { ... }`) dan replace dengan:

```js
const currentUtterance = {
  id: null,
  isPlaying: false,
  isPaused: false,
  // Mode aktif: 'mixed' = audio_segments[], 'legacy' = Web Speech single text.
  mode: null,
};
```

- [ ] **Step 4: Replace `stopSpeaking()` (lines 37-50)**

```js
function stopSpeaking() {
  ttsQueue.stop();
  currentUtterance.id = null;
  currentUtterance.isPlaying = false;
  currentUtterance.isPaused = false;
  currentUtterance.mode = null;
  EventBus.emit(Events.TTS_END);
  updateGlobalTtsButtons();
}
```

- [ ] **Step 5: Replace `pauseSpeaking()` (lines 52-61)**

```js
function pauseSpeaking() {
  if (!currentUtterance.isPlaying || currentUtterance.isPaused) return;
  ttsQueue.pause();
  currentUtterance.isPaused = true;
  updateGlobalTtsButtons();
}
```

- [ ] **Step 6: Replace `resumeSpeaking()` (lines 63-72)**

```js
function resumeSpeaking() {
  if (!currentUtterance.isPaused) return;
  ttsQueue.resume();
  currentUtterance.isPaused = false;
  updateGlobalTtsButtons();
}
```

- [ ] **Step 7: Replace `playSegment()` (lines 119-150)**

```js
function playSegment(_seg) {
  // Logika pindah ke ttsQueueManager. Method ini jadi no-op.
}
```

- [ ] **Step 8: Replace `playSegmentBrowser()` (lines 152-176)**

```js
function playSegmentBrowser(_seg) {
  // Logika pindah ke ttsQueueManager. Web Speech fallback udah ada di _speakFallbackBrowser.
}
```

- [ ] **Step 9: Replace `playNextSegment()` (lines 178-189)**

```js
function playNextSegment() {
  // Tidak dipakai lagi; ttsQueueManager manage sequencing.
}
```

- [ ] **Step 10: Update `speakMessage()` mixed-mode branch (lines 197-232)**

Find bagian ini:

```js
  if (segments && segments.length > 0) {
    // Mixed mode: Azure MP3 + Web Speech fallback per segment.
    currentAudioSegments[msgId] = segments;
    currentUtterance.id = msgId;
    currentUtterance.mode = 'mixed';
    currentUtterance.segmentIndex = -1;
    currentUtterance.isPlaying = true;
    currentUtterance.isPaused = false;
    EventBus.emit(Events.TTS_START);
    playNextSegment();
    return;
  }
```

Replace dengan:

```js
  if (segments && segments.length > 0) {
    currentUtterance.id = msgId;
    currentUtterance.mode = 'mixed';
    currentUtterance.isPlaying = true;
    currentUtterance.isPaused = false;
    EventBus.emit(Events.TTS_START);
    ttsQueue.enqueueSegments(segments);
    ttsQueue.play();
    updateGlobalTtsButtons();
    return;
  }
```

- [ ] **Step 11: Remove `currentAudioSegments` map (jika tidak dipakai lagi)**

Check apakah `currentAudioSegments` masih direferensikan di tempat lain. Kalau tidak ada referensi lain, hapus deklarasi line 195.

Run: `grep -n "currentAudioSegments" frontend/public/js/pages/story.page.js`
Expected: hanya deklarasi di line 195 (atau terdistribusi sebagai referensi dari playNextSegment/playSegment yang sudah dihapus).

Hapus deklarasi:

```js
const currentAudioSegments = {};
```

- [ ] **Step 12: Update referensi legacy `utterance` shader**

Find lines ~244-263 (legacy mode di `speakMessage`) — pastikan `utterance.onstart/onend/onerror` masih valid karena mereka set `currentUtterance.id`, `currentUtterance.isPlaying`, `currentUtterance.utterance`. Update agar tidak mengakses `currentUtterance.utterance` (sudah dihapus):

Replace semua `currentUtterance.utterance = utterance;` dengan komentar atau hapus (UI tidak pakai field ini lagi). Hanya `currentUtterance.id`, `isPlaying`, `isPaused`, `mode` yang dipakai sekarang.

- [ ] **Step 13: Verify tidak ada error referensi**

Run: `grep -n "currentUtterance\." frontend/public/js/pages/story.page.js`
Expected: hanya mengakses `id`, `isPlaying`, `isPaused`, `mode`. Tidak ada `audioEl`, `utterance`, `segmentIndex`, `pendingCallback`.

Kalau ada referensi ke field yang sudah dihapus, fix inline (ganti dengan alternatif yang setara atau hapus kalau tidak perlu).

- [ ] **Step 14: Verify syntax**

Run: `node --check frontend/public/js/pages/story.page.js 2>&1 || true`
Expected: tidak ada error.

- [ ] **Step 15: Commit**

```bash
git add frontend/public/js/pages/story.page.js
git commit -m "refactor(story-page): delegate mixed-mode playback ke ttsQueueManager"
```

---

### Task 8: Manual smoke test (Playwright)

**Files:** none (verification only)

- [ ] **Step 1: Backend running check**

Run: `cd backend && npm list @lixen/edge-tts 2>&1 | head -5`
Expected: `@lixen/edge-tts@1.x.x`.

If not installed: `cd backend && npm install`.

- [ ] **Step 2: Start backend**

```bash
cd backend && PORT=3000 node src/app.js
```

Expected: console shows "Server listening on port 3000".

- [ ] **Step 3: Test `/api/tts` directly via curl**

```bash
curl -X POST http://localhost:3000/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Halo dunia","gender":"female"}' \
  --output /tmp/test.mp3
```

Expected: `/tmp/test.mp3` exists, `file /tmp/test.mp3` shows "Audio file with ID 3 (mpeg)".

If error: periksa backend log, pastikan `MODEL_PROVIDER_API_KEY` diisi di `backend/.env`.

- [ ] **Step 4: Open story page di browser**

Navigate `http://localhost:3000/story.html?id=<story_id>` di Chrome.

- [ ] **Step 5: Trigger chat → dapat audio_segments**

Kirim pesan user, tunggu AI response dengan audio_segments[]. Verify di DevTools Network tab: ada `POST /api/tts` request per segment saat klik TTS button.

- [ ] **Step 6: Klik TTS button → dengar audio**

Verify audio plays sequentially per segment.

- [ ] **Step 7: Klik stop mid-play → audio berhenti**

Verify di DevTools Network: tidak ada pending request (no AbortController pending).

- [ ] **Step 8: Stop backend → klik TTS → fallback Web Speech**

Kill backend process. Klik TTS. Verify Web Speech fallback kicks in (voice terdengar dalam bahasa Indonesia dengan browser voice).

- [ ] **Step 9: Memory leak check**

Buka DevTools Memory tab, take snapshot. Klik TTS 10×. Take snapshot lagi. Verify JS heap delta < 5MB.

- [ ] **Step 10: Commit verification log (optional)**

```bash
git add -A
git commit -m "chore: tts hybrid playback verified manually" --allow-empty
```

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| Architecture (single source of truth, layer) | 5, 7 |
| Voice resolution helper | 2 |
| Fetch / Blob / Audio playback | 5 |
| 8s AbortController timeout | 3, 5 |
| Web Speech fallback | 5 |
| Pause/Resume (audio.pause, no abort) | 6 |
| Stop (abort + revoke Blob URL) | 6, 5 |
| Blob URL leak prevention | 5 (`_disposeCurrent`) |
| State sync dengan currentUtterance | 7 (shrink + delegate) |
| Test plan | 8 |

**Placeholder check:** tidak ada "TBD/TODO/implement later". Semua step punya code konkret.

**Type consistency:** `resolveTtsVoice`, `_disposeCurrent`, `_speakFallbackBrowser`, `_playBlob`, `_currentAudioEl`, `_currentBlobUrl`, `_activeAbort`, `_currentTimeoutId` dipakai konsisten lintas Task 2-6.

**Gotchas:**
- Task 4 stub `_speakCurrent()` di-commit terpisah sehingga rollback granular. Commit message jelas (`stub ... untuk hybrid rewrite`).
- Task 5 pakai dynamic `import('../api/apiClient.js')` di dalam method untuk hindari top-level circular dependency check (file ini di-load sebagai modul terpisah).
- Task 7 step 11 menghapus `currentAudioSegments` HANYA kalau tidak ada referensi lain — grep dulu.
- Task 7 step 12-13 adalah sweep cleanup untuk field `currentUtterance` yang dihapus.
