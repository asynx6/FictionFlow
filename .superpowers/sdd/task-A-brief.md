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

