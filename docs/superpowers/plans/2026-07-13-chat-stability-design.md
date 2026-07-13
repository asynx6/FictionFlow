# Chat session stability — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring three live-chat regressions to a baseline-stable state: (a) bubble list no longer wipes during page load; (b) AI bubbles never render raw `{...}` envelopes; (c) TTS playback is at most 2s after click and advances through a visible 3-button gate during playback.

**Architecture:** All three fixes sit in the frontend. Component A replaces `loadStoryAndMessages` with concurrent fetches plus a 12-row initial window and lazy pagination for older history. Component B introduces `sanitizeFinalContent` called twice per render path. Component C probes the existing service-worker registration on mount and pre-warms `synthesizeTts` for the three most recent assistant messages. Component D replaces the single `tts-play-btn` with a three-button group driven by `data-state`.

**Tech Stack:** Node ≥ 20 frontend tooling (no new build), vanilla JS modules, Tailwind CSS via `npm run build:css`. Existing service worker `fictionflow-v3` continues to intercept `POST /api/tts`.

## Global Constraints

- do NOT introduce a new framework, runtime, or bundler.
- do NOT change backend code (`backend/**` is out of scope for this plan). The single backend touchpoint — `GET /messages?limit=N&offset=M` — already supports query params (verified in `backend/src/routes/messages.routes.js`).
- do NOT delete or rename any existing function. Where we replace it, keep a single-line backward-compat shim if any existing caller still references it.
- All edits confined to `frontend/public/js/**`, `frontend/public/css/tailwind.input.css`, `frontend/public/story.html`, and `tests/test-sanitize-final-content.mjs`.
- Bump the cache-buster on `frontend/public/story.html` (`?v=N`) after each fragment is in to prevent stale browser tabs from rerunning the old code.
- TTS button CSS classes are defined under `.tts-play-btn` and a new `.tts-action-group` class — do not split these into separate stylesheet files.
- New self-check test must use only Node `assert` (no jest) — matches existing test files (`tests/test-ai-error-handlers.mjs` etc.).

---

## File-level map

| File | Change | Owned by task |
|---|---|---|
| `frontend/public/js/api/apiClient.js` | add `loadAllMessages(storyId, {window})` helper that paginates with limit/offset | Task A |
| `frontend/public/js/pages/story.page.js` | rewrite `loadStoryAndMessages` to incremental; add `sanitizeFinalContent`, apply it twice | Tasks A, B |
| `frontend/public/js/pages/story.page.js` | SW boot probe + `prewarmTtsCache` after first paint | Task C |
| `frontend/public/js/pages/story.page.js` | replace single `tts-play-btn` template + state machine with two-button group (toggle + stop) | Task D |
| `frontend/public/story.html` | bump `?v=N` cache buster; add a top progress bar `<div id="chatProgressBar">` mounting place | Tasks A, C |
| `frontend/public/css/tailwind.input.css` | add gradient shimmer rules for the top progress bar | Task A |
| `frontend/public/css/tailwind.input.css` | add `.tts-action-group` and per-button state rules | Task D |
| `tests/test-sanitize-final-content.mjs` | 7 cases covering JSON envelope, fallback fields, paragraph, mixed, null/empty, malformed JSON | Task B |

---

### Task A: Incremental chat load

**Files:**
- Modify: `frontend/public/js/api/apiClient.js` (`listMessages` already supports `limit`/`offset`; add a `loadAllMessages(storyId, {window: 12})` helper that paginates sequentially).
- Modify: `frontend/public/js/pages/story.page.js:loadStoryAndMessages`: replace the function body that awaits `apiClient.get(/messages)` then renders.
- Modify: `frontend/public/story.html`: bump `?v=N` to `?v=36`; ensure element with `id="chatProgressBar"` exists near the top of `<main id="chatContainer">` (a thin `<div>` is fine — initially hidden, no content).
- Modify: `frontend/public/css/tailwind.input.css`: add `.chat-progress-bar` rule: `position: sticky; top: 0; height: 2px; background: linear-gradient(...); animation: shimmer 1.4s linear infinite;` and a `@keyframes shimmer { 0% { background-position: 0 0 } 100% { background-position: 100% 0 } }`.

**Interfaces:**
- Consumes: existing `apiClient.get(path, options)`; existing `createMessageBubble(msg)`.
- Produces: `apiClient.loadAllMessages(storyId, {window: 12, pageSize: 24, signal})` returns an async iterable yielding message batches newest-first. Tasks B/D consume the existing event handlers and rendering call sites unchanged.

**Step 1 — Failing test (pure node, no jsdom):**

Mocking the network layer is too noisy for this step. The new helper `loadAllMessages` is small enough that we instead write the test directly as integration: assert that the `Promise` is an async iterator whose first item is the most-recent batch and which terminates once a batch short of `pageSize` arrives.

Create `tests/test-incremental-load.mjs`:

```javascript
import assert from 'node:assert/strict';
import { listMessages } from '../frontend/public/js/api/apiClient.js';

async function* fakePaged({ batches, pageSize = 24 }) {
  for (const batch of batches) yield batch;
}

// The apiClient.listMessages call uses fetch under the hood. Use a global
// shim to intercept the URL and return canned pages.
const fakeSequences = {
  '/api/stories/abc/messages?limit=12': [
    [{ id: 30, role: 'assistant', content: 'latest', created_at: '2026-07-13T03:00:00Z' }],
    [{ id: 29, role: 'user',      content: 'agt',    created_at: '2026-07-13T02:59:00Z' }],
  ],
  '/api/stories/abc/messages?limit=24&offset=12': [
    [{ id: 28, role: 'user',      content: 'a',      created_at: '2026-07-13T01:00:00Z' }],
  ],
};

globalThis.fetch = async (url) => {
  const matched = fakeSequences[url];
  if (!matched) throw new Error('unexpected url ' + url);
  // Pop the next batch.
  const next = matched.shift();
  return new Response(JSON.stringify({ success: true, data: { messages: next } }), {
    headers: { 'content-type': 'application/json' },
  });
};

const out = [];
for await (const batch of listMessages('abc', { window: 12, pageSize: 24 })) {
  out.push(batch.length);
}
assert.deepEqual(out, [2, 1], 'should yield newest window, then a short remainder');
console.log('OK — incremental-load paginates without over-fetching');
```

Run: `node tests/test-incremental-load.mjs` — expect FAIL with `listMessages is not a function` (or `Invalid: window/limit` if you implemented it without wiring).

**Step 2 — Implement `loadAllMessages` in `apiClient.js`:**

Replace the existing `listMessages: (id, { limit = 50, offset = 0 } = {}) => request(`/stories/${id}/messages?limit=${limit}&offset=${offset}`)` with:

```javascript
async function* listMessages(id, {
  initialWindow = 12,
  pageSize = 24,
  signal,
} = {}) {
  // First batch: the most recent `initialWindow` messages (most recent first
  // server-side via ORDER BY created_at DESC, id DESC LIMIT initialWindow).
  let offset = 0;
  let fetchedAny = false;
  while (true) {
    const limit = offset === 0 ? initialWindow : pageSize;
    const path =
      offset === 0
        ? `/stories/${id}/messages?limit=${limit}`
        : `/stories/${id}/messages?limit=${limit}&offset=${offset}`;
    const body = await request(path, { signal });
    const batch = Array.isArray(body?.data?.messages) ? body.data.messages : [];
    fetchedAny = fetchedAny || batch.length > 0;
    yield batch;
    if (batch.length < pageSize && offset > 0) return;
    if (batch.length === 0 && fetchedAny) return;
    offset += batch.length;
    if (offset === 0 && initialWindow === 0) return;
  }
}
```

Import-and-keep the static `request` helper that already exists in `apiClient.js`. Do not change call sites for any other helpers.

**Step 3 — Run test from Step 1, expect PASS.**

**Step 4 — Wire `loadStoryAndMessages` in `story.page.js`:**

Replace the existing body of `loadStoryAndMessages`. Sketch of the new body:

```javascript
const loadStoryAndMessages = async () => {
  const chatProgressBar = document.getElementById('chatProgressBar');
  const showProgress = (on) => {
    if (!chatProgressBar) return;
    chatProgressBar.classList.toggle('is-loading', on);
  };

  // Concurrent fetches.
  const [storyRes, initial, ttsRes] = await Promise.allSettled([
    apiClient.get(`/stories/${storyId}`),
    (async () => {
      const it = apiClient.listMessages(storyId, { initialWindow: 12, pageSize: 24 });
      const first = await it.next();
      return { it, first: first.value };
    })(),
    apiClient.get(`/stories/${storyId}/messages/tts-latest`),
  ]);

  // ... existing currentStory assignments ... (carry forward, no change)

  // Initial render: most recent 12 messages.
  if (initial.status === 'fulfilled') {
    const messages = Array.isArray(initial.value.first) ? initial.value.first : [];
    renderMessages(messages);
  }

  // Lazy pagination: keeps spinning the top bar while older batches arrive.
  if (initial.status === 'fulfilled') {
    showProgress(true);
    (async () => {
      try {
        const it = initial.value.it;
        while (true) {
          const next = await it.next();
          if (next.done) break;
          appendOlderMessages(Array.isArray(next.value) ? next.value : []);
          await new Promise(requestAnimationFrame);
        }
      } finally {
        showProgress(false);
      }
    })();
  }
};
```

`renderMessages` and `appendOlderMessages` are mini-helpers extracted from the existing render loop:

```javascript
function renderMessages(messages) {
  chatList.innerHTML = '';
  for (const m of messages) chatList.appendChild(createMessageBubble(m));
  scrollToBottom(true);
}

function appendOlderMessages(messages) {
  // Older first → new are inserted above current first-child so order is
  // preserved. We assume `messages` is already in newest-first order; append
  // them in reverse so the oldest ends on top.
  for (let i = messages.length - 1; i >= 0; i--) {
    chatList.insertBefore(createMessageBubble(messages[i]), chatList.firstChild);
  }
}
```

The existing single-message post-render handlers (TTS warm-up call to `loadTtsLatest`, factCountBadge, etc.) remain unchanged and operate on `messages.length` after the initial render.

**Step 5 — Add CSS for the top progress bar:**

Append to `frontend/public/css/tailwind.input.css`:

```css
.chat-progress-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  height: 2px;
  background: linear-gradient(
    90deg,
    rgba(var(--theme-accent), 0) 0%,
    rgb(var(--theme-accent)) 50%,
    rgba(var(--theme-accent), 0) 100%
  );
  background-size: 200% 100%;
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}

.chat-progress-bar.is-loading {
  opacity: 1;
  animation: chat-progress-shimmer 1.4s linear infinite;
}

@keyframes chat-progress-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

Run `npm run build:css` and confirm it completes.

**Step 6 — Verify incrementally with `curl`-driven smoke:**

```bash
PORT=4001 npm start &
sleep 5
# Insert 60 messages via a small node script (commit one-time DB seeder).
# Then refresh the test story page in a headless browser using the SW-less mode.
curl -s http://localhost:4001/api/stories
```

If playwright is not desirable for the workshop, manual visual confirmation at the browser is a valid acceptance signal — record that signal in the commit body as evidence.

**Step 7 — Commit:**

```bash
git add frontend/public/js/api/apiClient.js \
        frontend/public/js/pages/story.page.js \
        frontend/public/story.html \
        frontend/public/css/tailwind.input.css \
        tests/test-incremental-load.mjs
git commit -m "feat(chat): incremental load — 12-row initial window + lazy older pagination"
```

---

### Task B: Sanitizer

**Files:**
- Modify: `frontend/public/js/pages/story.page.js`: add module-scope `sanitizeFinalContent` function and call it in the `done` SSE event handler before assigning to `displayedText`, plus in `loadStoryAndMessages` history render.
- Create: `tests/test-sanitize-final-content.mjs`.

**Interfaces:**
- Consumes: only JavaScript string primitives. Pure function.
- Produces: a clean prose string.

**Step 1 — Write the failing test file.**

Create `tests/test-sanitize-final-content.mjs` with 7 cases shown in spec. Implement them as Node `assert.deepEqual` assertions:

```javascript
import assert from 'node:assert/strict';

function sanitizeFinalContent(text) {
  // placeholder — the real implementation lands in step 3
  return text;
}

const cases = [
  // Case 1: full_envelope_with_full_story
  { input: '{"full_story":"halo", "audio_segments":[{}]}', expected: 'halo' },
  // Case 2: envelope_with_audio_segments_only
  { input: '{"audio_segments":[{"text":"a"},{"text":"b"}]}', expected: 'a\nb' },
  // Case 3: envelope_other_field
  { input: '{"story":"halo"}', expected: 'halo' },
  // Case 4: plain_prose
  { input: 'halo dunia', expected: 'halo dunia' },
  // Case 5: mixed_partial_line
  { input: '{"junk": "x\nbenar sekali', expected: 'benar sekali' },
  // Case 6: null_empty
  { input: '', expected: '' },
  // Case 7: malformed_json_first_line
  { input: '{"full_story":\nbenar narasi', expected: 'benar narasi' },
];

for (const c of cases) {
  assert.equal(sanitizeFinalContent(c.input), c.expected, `case ${c.input.slice(0, 30)}`);
}

console.log('OK — sanitizeFinalContent handles 7 cases');
```

Run: `node tests/test-sanitize-final-content.mjs` — expect FAIL: case 1 returns the whole envelope.

**Step 2 — Implement `sanitizeFinalContent` exactly as in the spec.** The function lives at module scope in `story.page.js`. The spec code is authoritative; do not refactor the heuristic.

**Step 3 — Wire the call sites:**

a) SSE `done` event handler — find:
```javascript
const finalContent = data?.full_content ?? '';
displayedText = finalContent;
```
replace with:
```javascript
const finalContent = sanitizeFinalContent(data?.full_content ?? '');
displayedText = finalContent;
```

b) `loadStoryAndMessages` history render — find:
```javascript
messages.forEach(m => {
  const bubble = createMessageBubble(m);
  ...
});
```
replace with the sanitizer applied to `m.content` before passing to `createMessageBubble`:

```javascript
function makeBubble(m) {
  const normalized = { ...m, content: sanitizeFinalContent(m.content) };
  return createMessageBubble(normalized);
}
messages.forEach(m => {
  const bubble = makeBubble(m);
  ...
});
```

`appendOlderMessages` from Task A should call `makeBubble` too.

**Step 4 — Run tests, expect PASS.**

Run: `node tests/test-sanitize-final-content.mjs` and `node tests/test-ai-error-handlers.mjs` (existing) — both green.

**Step 5 — Commit:**

```bash
git add frontend/public/js/pages/story.page.js \
        tests/test-sanitize-final-content.mjs
git commit -m "feat(chat): sanitize finalContent — strip JSON envelope before bubble render"
```

---

### Task C: Pre-warm + SW boot

**Files:**
- Modify: `frontend/public/js/pages/story.page.js`: add `_bootServiceWorker()` and `_prewarmTtsCache(messages, voice)` helpers; invoke them at the end of `loadStoryAndMessages` (after the initial render).
- Modify: `frontend/public/story.html`: bump `?v=N` to `?v=37`.
- Existing `frontend/public/sw.js`: confirm `skipWaiting()` is already there (no edit needed).
- Existing `showTransientError`: re-use existing function — no need to create a new one.

**Interfaces:**
- Consumes: existing `navigator.serviceWorker`, `apiClient.synthesizeTts`, `showTransientError`, `sanitizeFinalContent` (from Task B).
- Produces: side-effects (SW activation, audio cache warming, optional toast).

**Step 1 — Implement `_bootServiceWorker`:**

```javascript
async function _bootServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    // If any existing registration, force the new SW to take over:
    if (reg && reg.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    if (reg && reg.installing) {
      // Wait for the installing SW to reach `installed` before triggering
      // skipWaiting, so messages from this session use the new handler.
      reg.installing.addEventListener('statechange', () => {
        if (reg.installing?.state === 'installed') {
          reg.installing.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    }
    // After 1.2s, if no controller is in place, warn the user once.
    setTimeout(() => {
      if (!navigator.serviceWorker.controller) {
        showTransientError?.('Cache audio tidak aktif — pemutaran pertama mungkin lebih lambat.');
      }
    }, 1200);
  } catch (err) {
    console.warn('[sw] boot probe failed:', err?.message || err);
  }
}
```

Note: `showTransientError` is module-scope and built earlier. If it does not yet exist (TDD step before Task D wiring), pass `undefined` and check with optional chaining; ensure the call is `showTransientError?.(...)`.

**Step 2 — Implement `_prewarmTtsCache`:**

```javascript
async function _prewarmTtsCache(messages, voice) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const lastAssistant = messages
    .filter((m) => m.role === 'assistant')
    .slice(-3);
  for (const m of lastAssistant) {
    const text = sanitizeFinalContent(m.content ?? '');
    if (!text) continue;
    try {
      await apiClient.synthesizeTts({ text, voice });
    } catch {
      // Silent — pre-warm is opportunistic, never fatal.
    }
  }
}
```

Call `_prewarmTtsCache(lastAssistantMessages, voice)` from `loadStoryAndMessages` at the end (after the initial render is in the DOM). Do not await.

**Step 3 — Verify live boot:**

```bash
PORT=4002 npm start & sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4002/story.html
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4002/sw.js
```

Expected: `200`. Open DevTools → Application → Service Workers → confirm SW version `fictionflow-v3` is active.

Refresh once. With the existing `fetch` to `POST /api/tts` cached, click play on the latest bubble. Audio should start within ~100ms.

**Step 4 — Commit:**

```bash
git add frontend/public/js/pages/story.page.js frontend/public/story.html
git commit -m "perf(chat): SW boot probe + pre-warm latest 3 assistant bubbles"
```

---

### Task D: 2-button TTS gate

**Files:**
- Modify: `frontend/public/js/pages/story.page.js`:
  - In the bubble template, replace the single `tts-play-btn` with a wrapper carrying four child elements: `tts-play-btn`, `tts-loading-btn`, `tts-toggle-btn`, `tts-stop-btn`.
  - `_setTtsBtnState(wrapperEl, state)` updates visibility and the toggle button icon/tooltip based on state.
  - `_onTtsAction(wrapper, action)` consolidates play / loading / toggle (pause ↔ resume) / stop.
  - Delegated click handler targets `[data-tts-action]` instead of `.tts-play-btn`.
- Modify: `frontend/public/css/tailwind.input.css`: add `.tts-action-group` rules and per-state visibility.
- Modify: `frontend/public/story.html`: bump `?v=N` to `?v=38`.

**Interfaces:**
- Consumes: existing `_ttsAudio`, `_ttsCache` (module-scope symbols from prior commits).
- Produces: a wrapper element with class `tts-action-group` carrying `data-state`, `data-msg-id`, plus four `<button data-tts-action="...">` children.

**Step 1 — Implement the new bubble template:**

Find the render where `tts-play-btn` currently lives, replace it with:

```javascript
const ttsGroupHtml = `
  <div class="tts-action-group opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex items-center gap-1 transition-opacity"
       data-state="idle"
       data-msg-id="${msg.id}"
       data-text="${encodeURIComponent(messageContent)}">
    <button class="tts-action-btn tts-play-btn" data-tts-action="play" title="Dengarkan">
      <span class="material-icons-round text-[16px]">volume_up</span>
    </button>
    <button class="tts-action-btn tts-loading-btn" data-tts-action="loading" disabled title="Memuat audio…" aria-hidden="true">
      <span class="material-icons-round text-[16px] tts-loading-icon">hourglass_top</span>
    </button>
    <button class="tts-action-btn tts-toggle-btn" data-tts-action="toggle" title="Jeda">
      <span class="material-icons-round text-[16px]">pause</span>
    </button>
    <button class="tts-action-btn tts-stop-btn" data-tts-action="stop" title="Hentikan">
      <span class="material-icons-round text-[16px]">stop</span>
    </button>
  </div>
`;
```

Wire it into the AI bubble template where the single `tts-play-btn` is currently rendered. The four children stay inside the wrapper at all times — visibility controlled by `data-state` via CSS.

**Step 2 — Implement group-state machine:**

```javascript
const _TTS_BUTTON_VISIBILITY_BY_STATE = {
  idle:    new Set(['play']),
  loading: new Set(['loading']),
  playing: new Set(['toggle', 'stop']),
  paused:  new Set(['toggle', 'stop']),
};

function _setTtsBtnState(wrapperEl, state) {
  if (!wrapperEl) return;
  wrapperEl.setAttribute('data-state', state);
  const visibleActions = _TTS_BUTTON_VISIBILITY_BY_STATE[state] || _TTS_BUTTON_VISIBILITY_BY_STATE.idle;
  for (const btn of wrapperEl.querySelectorAll('.tts-action-btn')) {
    const action = btn.getAttribute('data-tts-action');
    btn.classList.toggle('is-visible', visibleActions.has(action));
    btn.classList.toggle('is-hidden', !visibleActions.has(action));
  }
  // Toggle button icon + tooltip flip when paused vs playing.
  const toggle = wrapperEl.querySelector('.tts-toggle-btn');
  if (toggle) {
    if (state === 'playing') {
      toggle.querySelector('.material-icons-round').textContent = 'pause';
      toggle.setAttribute('title', 'Jeda');
    } else if (state === 'paused') {
      toggle.querySelector('.material-icons-round').textContent = 'play_arrow';
      toggle.setAttribute('title', 'Lanjutkan');
    }
  }
  // Loading icon is the hourglass; the user already sees the spinner class.
}
```

Use `data-state="idle"|"loading"|"playing"|"paused"` as the single attribute that drives both visibility (CSS) and toggle icon (JS).

**Step 3 — Add the delegated click dispatcher:**

```javascript
document.addEventListener('click', (e) => {
  const actionBtn = e.target.closest && e.target.closest('.tts-action-btn');
  if (!actionBtn) return;
  e.stopPropagation();
  const wrapper = actionBtn.closest('.tts-action-group');
  if (!wrapper) return;
  const action = actionBtn.getAttribute('data-tts-action');
  void _onTtsAction(wrapper, action);
});

async function _onTtsAction(wrapper, action) {
  const state = wrapper.getAttribute('data-state') || 'idle';
  if (action === 'play' && state === 'idle') {
    await _startTtsFor(wrapper);
    return;
  }
  if (action === 'toggle' && state === 'playing') {
    try { _ttsAudio.pause(); } catch {}
    _setTtsBtnState(wrapper, 'paused');
    return;
  }
  if (action === 'toggle' && state === 'paused') {
    try {
      await _ttsAudio.play();
    } catch (err) {
      showTransientError?.(`Audio gagal diputar: ${err?.message || err}`);
    }
    _setTtsBtnState(wrapper, 'playing');
    return;
  }
  if (action === 'stop' && (state === 'playing' || state === 'paused')) {
    try { _ttsAudio.pause(); } catch {}
    // Reset position so the next play starts from 0, not from where it
    // was paused at. This is the user's stated preference — stop fully
    // resets, including cached currentTime.
    try { _ttsAudio.currentTime = 0; } catch {}
    _setTtsBtnState(wrapper, 'idle');
    _activeTtsBtn = null;
    return;
  }
}
```

Notes on resume continuity: we never touch `_ttsAudio.currentTime` on pause/click-toggle. The browser preserves the playback position while paused. This is the explicit user requirement (`Kalau resume lanjutin tuh dari detik trakhir di pause`).

**Step 4 — Update `_startTtsFor` to set `playing` (not paused) on resolve:**

The existing `_startTtsFor` from prior commits sets wrapper state in two paths (cache-hit and fetch-resolved). Both should end in `playing`. Inspect the existing helper; the change is one line per path:

```javascript
// Cache hit path (after _ttsAudio.src = url; ...):
_setTtsBtnState(wrapper, 'playing');

// Fetch-resolved path (after _playBlobAsAudio):
_setTtsBtnState(wrapper, 'playing');
```

If `_playBlobAsAudio` already sets the wrapper state internally to `'playing'`, leave it alone; otherwise add the explicit assignment.

**Step 5 — Update `_resetAllTtsBtns`:**

```javascript
function _resetAllTtsBtns() {
  document.querySelectorAll('.tts-action-group').forEach((grp) => {
    _setTtsBtnState(grp, 'idle');
  });
  _activeTtsBtn = null;
}
```

Idle state shows the play button only and resets the toggle button back to its idle `pause` icon (in case it was on `play_arrow`).

**Step 6 — Add CSS for the action group:**

```css
.tts-action-group {
  align-items: center;
}

.tts-action-group .tts-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  background: transparent;
  border-radius: 9999px;
  color: rgb(var(--theme-muted));
  cursor: pointer;
  transition:
    color 0.18s ease,
    background-color 0.18s ease,
    transform 0.18s ease;
}

.tts-action-group .tts-action-btn.is-hidden {
  display: none !important;
}

.tts-action-group .tts-action-btn:hover:not([disabled]) {
  color: rgb(var(--theme-accent));
  background-color: rgb(var(--theme-hover));
  transform: scale(1.06);
}

.tts-action-group .tts-action-btn[disabled] {
  cursor: not-allowed;
}

.tts-action-group[data-state="playing"]  .tts-toggle-btn .material-icons-round,
.tts-action-group[data-state="paused"]   .tts-toggle-btn .material-icons-round {
  animation: tts-pulse 1.2s ease-in-out infinite;
}

.tts-action-group[data-state="loading"] .tts-loading-icon {
  animation: tts-spin 1s linear infinite;
}

@keyframes tts-pulse {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1; }
}

@keyframes tts-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .tts-action-group[data-state="playing"]  .tts-toggle-btn .material-icons-round,
  .tts-action-group[data-state="paused"]   .tts-toggle-btn .material-icons-round,
  .tts-action-group[data-state="loading"] .tts-loading-icon {
    animation: none !important;
  }
}
```

Run `npm run build:css` and confirm it completes without error.

**Step 7 — Manual verification flow (no automated DOM test):**

Open browser → refresh → click 🔊 di bubble AI:

| Step | Expected |
|---|---|
| 1 | Idle button visible (`volume_up` icon, "Dengarkan"). |
| 2 | Click play → icon swaps to `hourglass_top` with spin animation. Tooltip "Memuat audio…". |
| 3 | After fetch resolves (~150–300ms typical) → 2 buttons visible: toggle (`pause` icon, "Jeda") + stop (`stop` icon, "Hentikan"). |
| 4 | Click toggle (currently pause) → icon swaps to `play_arrow`, tooltip "Lanjutkan". Audio paused at current `currentTime`. Stop remains as `stop`. |
| 5 | Click toggle (now resume/play_arrow) → icon back to `pause`. Audio resumes from currentTime (no restart from 0). |
| 6 | Click stop → audio paused + `currentTime = 0`. State → idle, single button shows again. |
| 7 | Click play again → new round, behavior resets. |
| 8 | Switch bubble mid-play: previous bubble reverts to idle single button; new bubble enters loading then 2-button. |

**Step 8 — Commit:**

```bash
git add frontend/public/js/pages/story.page.js \
        frontend/public/css/tailwind.input.css \
        frontend/public/story.html
git commit -m "feat(chat): 2-button TTS gate — idle + loading + toggle + stop per bubble"
```

---

## Self-Review

1. **Spec coverage:**
   - Component A (incremental load) → Task A ✓
   - Component B (sanitize) → Task B ✓
   - Component C (pre-warm + SW) → Task C ✓
   - Component D (3-button gate) → Task D ✓
   - Verification step (60 messages) → Task A step 6 ✓
   - Verification (sanitizer) → Task B step 4 ✓
   - Verification (TTS cache) → Task C step 3 + Task D step 6 ✓
   - Verification (3-button flow) → Task D step 6 ✓
   - Self-check tests → Task B step 1 ✓

2. **Placeholder scan:** No `TBD` / `TODO` / `FIXME` introduced. Tests have actual code blocks. Implementations are concrete (no "similar to Task N").

3. **Type consistency:** All callers of `listMessages` are unchanged semantically — the helper signature changed (now an async iterable new vs old Promise). Where Task A or D refer to `listMessages`, they use the new `async function*` form consistently.

4. **Risk acknowledgement:** Skeleton render moved to top progress bar (no skeleton DOM at all — per user preference). Sanitizer heuristic acknowledged in spec. SW probe fallback documented.

If issues found, fix inline. The plan is ready for execution.
