# Frontend Hybrid TTS Playback — Design

**Date:** 2026-06-25
**Status:** Approved (verbal in conversation)
**Owner:** Backend + Frontend TTS pipeline
**Scope:** Replace pure Web Speech `ttsQueueManager` with hybrid Edge TTS (primary) + Web Speech (fallback). Backend `/api/tts` (Edge TTS) already shipped.

## Goals

- `ttsQueueManager` jadi **single source of truth** untuk audio playback di frontend.
- Primary: fetch `POST /api/tts` → MP3 Blob → `new Audio(blob:url).play()`.
- Fallback: Web Speech API saat fetch timeout, error, atau audio decode failure.
- Tidak ada Blob URL memory leak.
- Tidak ada in-flight fetch menggantung saat user stop.

## Non-goals

- Tidak refactor pause/resume UI lifecycle — `currentUtterance` di `story.page.js` tetap jadi state UI.
- Tidak ubah schema DB.
- Tidak ubah API `/api/tts` (sudah stabil).
- Tidak hapus `ttsEngine.js` — masih dipakai oleh legacy path (cerita lama tanpa `audio_segments`).

## Architecture

### Layering

```
story.page.js (UI transport)        ← currentUtterance, button state, EventBus
        │
        ├── delegates to →  ttsQueueManager (audio playback)
        │
        └── fallback path →  Web Speech API (langsung di queue manager)
```

`ttsQueueManager` jadi thin client untuk Edge TTS + Web Speech fallback. `story.page.js` jangan instantiate `Audio` lagi.

### Single playback path

| Caller | Action |
|---|---|
| `speakMessage(msgId, audio_segments[])` | `ttsQueueManager.enqueueSegments(segs)` → `queueManager.play()` |
| `pauseSpeaking()` | `ttsQueueManager.pause()` + mirror state ke `currentUtterance.isPaused` |
| `resumeSpeaking()` | `ttsQueueManager.resume()` + mirror state |
| `stopSpeaking()` | `ttsQueueManager.stop()` + reset `currentUtterance` |

### Voice resolution (in `ttsQueueManager`)

```js
function resolveTtsVoice(segment) {
  const hint = segment?.voice_config?.voice_name;
  if (hint && typeof hint === 'string' && hint.trim()) return hint.trim();
  if (segment?.gender === 'female') return 'id-ID-GadisNeural';
  return 'id-ID-ArdiNeural';
}
```

Backend pakai mapping yang sama di `backend/src/services/edgeTts.service.js`.

## Components

### `ttsQueueManager.js` rewrite

New internal state:
- `_currentAudioEl: HTMLAudioElement | null`
- `_currentBlobUrl: string | null`
- `_activeAbort: AbortController | null`
- `_currentTimeout: number | null` (8s)

New private method `_speakCurrent()`:

1. Kalau `!this.playing` atau `index >= segments.length`, return.
2. Ambil `segment = this.segments[this.index]`.
3. Buat `controller = new AbortController()`, simpan di `_activeAbort`.
4. Set timer 8s dengan `controller.abort()`.
5. Call `apiClient.synthesizeTts({text: segment.text, voice: resolveTtsVoice(segment), gender: segment.gender, signal: controller.signal})`.
6. On success:
   - `blobUrl = URL.createObjectURL(blob)` → simpan di `_currentBlobUrl`.
   - `audio = new Audio(blobUrl)` → simpan di `_currentAudioEl`.
   - `audio.play()` (kalau `this.playing && !this.paused`).
   - `audio.onended` → reset `_currentBlobUrl`/`_currentAudioEl` (revoke URL dulu), increment index, kalau `playing` rekursif `_speakCurrent()`.
   - `audio.onerror` → dispose (revoke URL), fallback Web Speech untuk text yang sama, lalu advance.
7. On error (`AbortError` karena user stop/timeout) → cleanup tanpa fallback kecuali timeout.
8. On timeout (`AbortError` dari timer internal, bukan user cancel) → dispose + Web Speech fallback untuk text segmen yang sama, lalu advance.

New methods:

- `pause()` — pause `audio` kalau ada. Timer pause (clear `_currentTimeout`). `paused = true`. **Tidak** abort fetch.
- `resume()` — kalau `audio` ada, `audio.play()`. Kalau ada `_activeAbort` & belum ada blob hasil, **jangan pause** timer (resume berarti lanjut fetch kalau belum selesai).
- `stop()` — pause `audio`, `audio.src = ''`, `URL.revokeObjectURL(_currentBlobUrl)`, `controller.abort()` (cancel in-flight fetch), clear timer, reset `index = 0`, `playing = false`, `paused = false`.

Dispose di tiap transition (ended/error/stop) untuk cegah Blob URL leak.

### `story.page.js` refactor

Changes minimal:

1. Di `speakMessage` mixed-mode branch:
   - Tetap set state `currentUtterance` (msgId, segmentIndex=-1, isPlaying=true, mode='mixed').
   - Panggil `ttsQueueManager.enqueueSegments(segments)` + `ttsQueueManager.play()`.
2. `pauseSpeaking`/`resumeSpeaking`/`stopSpeaking`: delegate ke ttsQueueManager + mirror state dengan memanggilnya.
3. Hapus `playSegment`/`playNextSegment`/`playSegmentBrowser` (logic pindah ke queue manager).
4. `currentUtterance.audioEl`/`currentUtterance.utterance` **dihapus**; UI state cukup pakai `isPlaying`/`isPaused`/ttsQueueManager snapshot.

Subscribe `ttsQueueManager.subscribe(fn)` untuk emit `'segment'` event saat advance segmen — bisa dipake untuk highlight segment element.

### `currentUtterance` shrink

After refactor, `currentUtterance` cuma:
```js
const currentUtterance = {
  id: null,
  isPlaying: false,
  isPaused: false,
  mode: null,             // 'mixed' | 'legacy'
  messageId: null,
};
```

Bug yang ditemukan saat eksplorasi: line 133 `if (currentUtterance.id !== currentUtterance.id)` self-comparison — **tidak masuk design ini** karena code line itu akan dihapus dengan refactor.

## Race conditions & failure modes

| Scenario | Behavior |
|---|---|
| User stop saat fetch `/api/tts` jalan | `AbortController.abort()` → no fallback, no leak |
| Fetch timeout (>8s) | `AbortController.abort()` → Web Speech fallback untuk segmen itu, lanjut segmen berikutnya |
| `audio.play()` reject (autoplay policy) | Catch → Web Speech fallback untuk text segmen |
| `audio.onerror` (decode failure) | Dispose → Web Speech fallback untuk text segmen |
| User pause lalu resume cepat (playback selesai saat pause) | Kalau `_currentAudioEl` null saat resume → rekursif `_speakCurrent()` |
| Stop di `paused` state | Sama dengan stop di playing state, plus clear `_activeAbort` |

## Test plan

Manual + Playwright:

1. **Happy path**: kirim chat, dapat 5 audio_segments, klik TTS button. Dengar audio load + play + advance per segment.
2. **Stop mid-play**: klik stop saat segmen ke-2 dari 5. Audio berhenti. Refresh page → tidak ada pending request di DevTools Network.
3. **Backend down**: stop service, klik TTS → fallback Web Speech kicks in <9s. Verify network status 500/503.
4. **Slow 3G**: Playwright throttling Slow 3G, klik TTS → fallback Web Speech kicks in saat timeout 8s.
5. **Pause/resume**: pause di tengah audio (audio pause, bukan cancel), resume → audio lanjut tanpa re-fetch.
6. **Memory leak check**: Playwright loop klik TTS 50× → pantau memory heap. Heap harus stabil (Blob URL revoke work). Baseline: <50MB growth.
7. **Legacy path**: kirim pesan dengan cerita lama (tanpa audio_segments) → legacy Web Speech path masih jalan.

## Out of scope (deferred)

- **Phase 2**: Audit 22 file JS untuk celah non-TTS (SQL injection, XSS, dll). Read-only, hasil laporan ke user.
- **Phase 3**: Fix celah dari audit (separate spec).

## Migration notes

- `ttsQueueManager` sudah ada di repo tapi **orphan** (tidak dipakai di story.page.js). Refactor ini menyatukan caller.
- Backend pipeline (`edgeTts.service.js`, `tts.routes.js`, `apiClient.synthesizeTts`) sudah shipped — design ini frontend-only.
