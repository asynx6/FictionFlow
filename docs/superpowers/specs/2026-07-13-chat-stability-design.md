# Chat session stability — design

## Context

After the recent sweep of TTS + provider-config + streaming-buffer
work, interactive testing surfaced three conflated live bugs that
appear during normal chat use:

1. **Bubble disappears on refresh.** The most recent user + AI bubble
   pair goes missing from the chat list after the browser is reloaded.
   Sometimes it comes back on a second reload. Backend `messages` rows
   are intact (verified) — disappearance is a frontend rendering
   race condition between the initial empty-state and the awaited fetch
   result landing.

2. **JSON wrapper appears in body chat, sometimes.** A user message
   bubble wrapped in `{"full_story": "...", "audio_segments": [...]}` —
   not always, but enough. The streaming token buffer is hidden
   correctly. The leak happens when `controller.streamChat`'s parser
   `tryParseStoryJson` returns null (because the LLM emitted
   non-JSON-clean text) and we fall through to
   `buildFallbackSegmentsFromText(legacyText)`, which then emits the
   raw text over SSE `done.full_content`. The bubble renders this
   raw envelope.

3. **TTS playback cold load.** Even with the 3-tier cache stack
   (backend Edge TTS LRU, service worker
   `CacheStorage` keyed by `tts:voice:sha256(text)`, frontend
   `_ttsCache: Map<msgId, Blob>`), the first play after a hard
   reload feels "lama banget". The most likely cause: service worker
   `fictionflow-v3` registration isn't picking up the new fetch handler
   immediately after install (`skipWaiting()` is in place but old SW
   tab does not reload until next navigation). Until the page reloads,
   `POST /api/tts` falls through to network.

We address these together because they all manifest in the chat
session loop and partly share the same code path
(`loadStoryAndMessages` and the `done` event).

## Goals

- Chat list never visibly empties between page load and first fetch
  complete. A short visible window (e.g. the most recent 12 turns)
  renders immediately; older history fills in lazily behind the
  chat scroll without blocking input.
- The body of an AI bubble is always clean prose — never a stray
  JSON envelope.
- Click on a bubble's play button reaches audible output at most 2
  seconds after the click, regardless of provider or cache state.
- The TTS button lifecycle is exactly:
  - **idle**: one button (`volume_up` icon, "Dengarkan").
  - **loading**: one button (`hourglass_top` icon, spin animation, "Memuat audio…"). The idle play icon is replaced entirely.
  - **playing**: two buttons — `pause`/`resume` toggle (one button whose icon changes between `pause` and `play_arrow` based on state) and `stop`.
  - **stop**: returns immediately to idle (the single `volume_up` button). Audio is paused and currentTime resets to 0.
  - **resume from paused**: continues from the last paused timestamp (not from 0).

## Non-goals

- Persisting locally-cached bubbles beyond what the backend has
  already committed (no offline-first story for now).
- Replacing the streaming token layer architecture (token buffer is
  intentionally silent — leaks elsewhere).
- Removing any TTS playback code (commit history shows the
  speaker-restoration work; we keep the surface stable).

## Architecture

Three independent components. Each verified end-to-end.

### Component A — Incremental chat load (`story.page.js`)

For long chats, the previous flow load everything at once. We change
it so the user can start reading + scrolling immediately:

1. At function entry, kick off three fetches concurrently with
   `Promise.allSettled`:
   - `GET /stories/{id}` (always)
   - `GET /messages?limit=12` (initial window — most recent 12 turns)
   - `GET /messages/tts-latest` (initial window)
2. As soon as `messages?limit=12` resolves, render the visible window.
   `chatList.innerHTML = ''` then loop and append. The loading
   spinner stays at the top of `#chatContainer` until the full
   `messages.length` total is known.
3. After the initial render, auto-fetch the rest via
   `GET /messages?offset=12&limit=24` in batches of 24, until the
   server returns fewer than the limit (ggez). Each batch appends
   older messages above the visible window — the user can scroll up
   to see them as they appear. The append uses `insertBefore` on the
   first child so order is preserved (oldest at top of list).
4. While the lazy background fetch is in progress, the spinner at
   the top of `chatList` keeps spinning but is small (16px) so the
   chat is still usable. No skeleton rows.

This keeps the UI responsive even on chats with hundreds of turns:
first paint is ~150ms (just the recent 12), background fills
independently.

#### Files

- `frontend/public/js/api/apiClient.js` — `listMessages` already
  supports `limit`/`offset`. No API change. Add `loadAllMessages`
  helper that paginates.
- `frontend/public/js/pages/story.page.js` — replace
  `loadStoryAndMessages` to use incremental fetch.

### Component B — Sanitize finalContent before render (`story.page.js`)

The browser-side sanitizer that runs at two sites:

1. Both event handlers that consume `data.full_content`:
   - On `done` event for an in-flight SSE response.
   - When restoring historical bubbles from `messages[i].raw_content`.
2. The sanitizer is a plain function `sanitizeFinalContent(text)` in
   module scope:

```javascript
function sanitizeFinalContent(text) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  // Case A: response is a complete JSON envelope.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.full_story === 'string' && obj.full_story.trim())
        return obj.full_story;
      if (Array.isArray(obj.audio_segments)) {
        const narrated = obj.audio_segments
          .map((s) => s?.text ?? '')
          .filter((t) => t && t.trim())
          .join('\n');
        if (narrated) return narrated;
      }
      const candidate = obj.story ?? obj.text ?? obj.narration;
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    } catch {
      /* not JSON — fall through */
    }
  }
  // Case B: response starts with a partial JSON line that never closed.
  // Heuristic: drop leading line if it opens `{` without matching `}`.
  const cleaned = [];
  for (const line of trimmed.split('\n')) {
    const lt = line.trim();
    if (lt.startsWith('{') && !lt.includes('}')) continue;
    cleaned.push(line);
  }
  return cleaned.join('\n');
}
```

Apply this in:
- `done` SSE event handler, before `displayedText = finalContent`.
- `loadStoryAndMessages` history render, before passing text through
  `formatTextWithMarkdown`.

#### Trade-off

Indonesian roleplay prose may legitimately use `{` (curly brace) in a
line. The strict-line heuristic drops that first line. The strict
heuristic is acceptable for FictionFlow because narrative rarely
features curly braces; if it does, user still retains the AI bubble in
DB (raw row untouched) and can copy the row text. We document this
limitation in the spec so future maintainers know.

### Component C — Pre-warm and SW re-registration

The 3-tier cache stack is already in place from prior commits. We add:

1. **SW-version probe at boot.** On `loadStoryAndMessages` mount, fetch
   `/sw.js?v=<current>` and `navigator.serviceWorker.getRegistration()`
   — if a stale SW is registered, send it `{type: 'SKIP_WAITING'}` so
   the new fetch handler takes over immediately. (No full reload
   needed most of the time).
2. **Post-render pre-warm.** After the first paint completes, kick
   off `apiClient.synthesizeTts` for the latest 3 assistant messages
   with `voice: ''` (the story's resolved voice). Silent failures
   (no toast) — these are for warm-up only.
3. **Service-worker boot-time toast.** If the SW does not respond to
   `SKIP_WAITING` within 1s, show a single transient toast: "Cache
   audio tidak aktif — pemutaran pertama mungkin lebih lambat." This
   helps user understand why click is slower than expected.

#### Files

- `frontend/public/js/pages/story.page.js` — boot probe + pre-warm.
- `frontend/public/js/api/apiClient.js` — give `_postSSE` a path-aware
  logger for diagnostic.
- `frontend/public/sw.js` — confirm `skipWaiting()` already in place.

### Component D — TTS button lifecycle (2-button gate)

The current button lifecycle is: idle single button → click → state
machine on a single play button. User requested a clearer 2-button
flow during playback. So we replace the lone button with a small
group carrying the actions:

- **idle (no bubble playing yet)**: render one button
  (`tts-play-btn`, icon `volume_up`, tooltip "Dengarkan").
- **click → loading**: replace the play button entirely with the
  `tts-loading-btn` (icon `hourglass_top` spin animation, tooltip
  "Memuat audio…"). The play icon disappears while loading.
- **fetch resolves → playing**: replace the loading button with a
  **two-button group**: `tts-toggle-btn` (icon `pause`, tooltip
  "Jeda") and `tts-stop-btn` (icon `stop`, tooltip "Hentikan"). The
  toggle button icon and tooltip change with state.
- **click toggle-btn → paused**: toggle icon becomes
  `play_arrow`, tooltip becomes "Lanjutkan". `tts-stop-btn` stays
  available. Audio playback pauses at the current `currentTime`.
- **click toggle-btn → playing**: pause icon restored button. Audio
  playback resumes from the same `currentTime` (we never reset
  currentTime on pause).
- **click stop → idle**: pause + `currentTime = 0`. The action
  group reverts to a single `tts-play-btn`. No resume from a
  previously-played position (currentTime reset).

Only one bubble plays at a time. Switching bubble mid-play: previous
bubble reverts to its idle `tts-play-btn`; new bubble enters
loading then 2-button state.

Visual layout: 2-button group inline, `flex gap-1`. The toggle button
label and icon switch in-place; we do not render two separate
buttons for pause / resume.

#### Files

- `frontend/public/js/pages/story.page.js` — replace the single
  `tts-play-btn` template with a 3-element wrapper carrying play /
  loading / toggle / stop. State machine stays the same; only the
  DOM wiring changes. `_setTtsBtnState` swaps visibility + icon +
  tooltip of the toggle button.
- `frontend/public/css/tailwind.input.css` — add `.tts-action-group`
  rules for the button layout and pulse animation.
- The sanitizer (Component B) and the cache (Component C) continue
  to apply — only the visible chrome changes.

## Verification

1. **Incremental load:**
   - Inject a story with 60 messages in DB.
   - Hard refresh. The most recent 12 messages render within ~150ms.
     Scrolling to top while background pagination is in progress shows
     older messages progressively. Input bar remains responsive during
     the entire flow.
   - Refresh right after submitting a chat. All previously committed
     bubbles still appear (no vanishing).

2. **Sanitizer (Bug 2):**
   - Inject a synthetic LLM response whose body is
     `'{"full_story":"halo", "audio_segments":[…]}'` via tests
     fixture. `sanitizeFinalContent` returns `'halo'`.
   - Inspect prior live rows — bubbles rendered with raw JSON are
     sanitized on next render.

3. **TTS cache hit fast:**
   - With SW + backend cache populated, click play on a bubble.
     Audio output starts within ~100ms. If SW is missing, click
     within 2s target is satisfied via backend cache.

4. **2-button flow:**
   - Click idle `volume_up` → icon swaps to `hourglass_top` (loading,
     ~150–300ms typical).
   - Loading resolves → 2-button group appears: toggle button
     (currently `pause`) + stop button.
   - Click pause → toggle button icon becomes `play_arrow`. Audio
     paused at current currentTime. Stop still active.
   - Click toggle (now `play_arrow`) → icon back to `pause`. Audio
     resumes from the same currentTime (same `_ttsAudio` element).
   - Click stop → reverts to single `volume_up` on this bubble.
     `_ttsAudio.pause()` and `currentTime = 0` called.

## Self-check tests

Add a fast-node test file `tests/test-sanitize-final-content.mjs`:

- 7 cases covering:
  - JSON envelope with `full_story`.
  - JSON envelope with `audio_segments` array.
  - JSON envelope with neither (string fallback to `story` or `text`).
  - Plain prose (no transformation).
  - Mixed: starts with `{` then legitimate prose — only first line dropped.
  - Null / empty / non-string inputs.
  - Malformed JSON `{"full_story":` (truncated) handled gracefully —
    partial line dropped.

Add a second test file `tests/test-tts-button-lifecycle.mjs` (in-browser
smoke via Node mock of the DOM state machine isn't strictly needed —
the lifecycle is short, manual test suffices). Document the 3 expected
button appearances in the README instead — single play, single
loading, three-button group in playing state, three-button group in
paused state, single play (post-stop).

All other self-check tests must continue to pass.

## Risk

- The skeleton render depends on a CSS animation rule that lives in
  `tailwind.input.css`. If that file is not regenerated via
  `npm run build:css`, the animation may not apply. The bubble is
  rendered disabled-state on first appearance; the fade-in is progressive
  enhancement.
- The sanitizer's `startsWith('{') ... endsWith('}')` heuristic fails
  on prose that legitimately starts with curly braces mid-line. We
  accept this for roleplay content; future format-aware sanitization
  (e.g. finding JSON substrings with balanced quote counts) is out of
  scope for this spec.
- The SW probe + `SKIP_WAITING` message does not force a controlled
  reload of the page. If the user has not interacted with the page
  before the new SW claims clients, no swipe happens. Acceptable — the
  initial bubble render happens; first new chat after that triggers
  the cache.

## Out of scope

- Offline story browsing (no `CacheStorage` for `messages` API today
  — only `/api/tts` is cached).
- Persistent localStorage mirror of bubble list (if a rollback is
  desired this is a future spec).
- New TTS voice additions (still 4 voices).
- Memory extractor changes (tagged-state refactor is shipped).
