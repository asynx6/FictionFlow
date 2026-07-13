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
  complete. Skeleton placeholders match the eventual count.
- The body of an AI bubble is always clean prose — never a stray
  JSON envelope.
- A repeat click on the same bubble's play button is at most a few
  hundred ms after a hard refresh.

## Non-goals

- Persisting locally-cached bubbles beyond what the backend has
  already committed (no offline-first story for now).
- Replacing the streaming token layer architecture (token buffer is
  intentionally silent — leaks elsewhere).
- Removing any TTS playback code (commit history shows the
  speaker-restoration work; we keep the surface stable).

## Architecture

Three independent components. Each verified end-to-end.

### Component A — Skeleton-first chat load (`story.page.js`)

`loadStoryAndMessages` currently does:
1. Read `currentStory = res.data.story`.
2. `await apiClient.get(/messages)` then nested in ttsLatest fetch.
3. Replace `chatList.innerHTML = ''` then render loop.

We refactor so the user never sees an empty list:

1. At function entry, set `chatList.innerHTML` to N=10 skeleton pairs
   (5 user + 5 AI) — small gray pill shapes. Skeleton count is large
   enough that real messages always have a slot to replace.
2. Kick off three fetches concurrently with `Promise.allSettled` —
   never one failure erases the other results.
3. After each fetch resolves, retroactively update the skeleton
   count to the new real count and replace skeleton placeholders with
   real bubbles (fade-in animation 120ms ease-out).
4. If `messages.length === 0` → fade skeletons and show centered CTA.
5. The `loadingChat` spinner (existing `#loadingChat`) becomes a
   progress hint at the top of `#chatContainer` (a `min-h-[2px]`
   indeterminate top progress bar), not a centered autorenew.

#### Files

- `frontend/public/js/pages/story.page.js` — replace `loadStoryAndMessages`.
- `frontend/public/story.html` — adjust `loadingChat` element to a top-bar.
- `frontend/public/css/tailwind.input.css` — skel-pill animation keyframes.

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

## Verification

1. **Skeleton first load:**
   - Hard refresh. The chat list shows 10 gray skeleton pills first,
     then real bubbles fade in within ~150ms.
   - Refresh right after submitting a chat. All previously committed
     bubbles still appear (no vanishing).

2. **Sanitizer (Bug 2):**
   - Inject a synthetic LLM response whose body is
     `'{"full_story":"halo", "audio_segments":[…]}'` via tests
     fixture. `sanitizeFinalContent` returns `'halo'`.
   - Inspect DB rows from prior live tests — any bubble rendered
     with raw JSON is sanitized on next render (audit + visual).

3. **TTS pre-warm + SW:**
   - Hard refresh with service worker disabled → SW unregister path
     kicks in; user gets a 1-time "Cache audio tidak aktif" toast.
   - With SW active, after first paint the 3 most recent messages
     appear in `caches.open('fictionflow-tts-v3')` — verify via DevTools.
   - Click play on any of those 3 → no loading state visible.

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
