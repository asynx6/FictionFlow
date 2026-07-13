# Task C brief — SW boot probe + prewarm TTS for latest 3 assistant messages

## Goal

Make the first TTS play click reach audible output within ~2 seconds
regardless of cache state. Two additions:

1. **SW-version probe at boot.** On `loadStoryAndMessages` mount, ensure
   the service worker controlling the page is the current build. If a
   stale SW is registered, send `{type: 'SKIP_WAITING'}` so the new fetch
   handler takes over immediately. No full reload needed.
2. **Post-render pre-warm.** After the first paint completes, call
   `apiClient.synthesizeTts` for the latest 3 assistant messages with the
   resolved story voice. Silent failures (no toast).
3. **Missing-SW toast.** If the SW does not respond to `SKIP_WAITING`
   within 1 second, show a single transient toast:
   "Cache audio tidak aktif — pemutaran pertama mungkin lebih lambat."

## Spec contract (Component C of the design spec)

Read Component C from `docs/superpowers/specs/2026-07-13-chat-stability-design.md`
for the full text. Three pieces:

- **SW-version probe** — fetch `/sw.js?v=<current>` (use `?v=` from the
  HTML cache-bust query, e.g. `?v=37`). Read
  `navigator.serviceWorker.controller?.scriptURL` (or `.getRegistration()`
  → `.active?.scriptURL`). If the registered SW's scriptURL is not the
  current `?v=N`, post `{type: 'SKIP_WAITING'}` to it. Wait up to 1s
  for the new SW to claim (`controllerchange` event).
- **Post-render pre-warm** — after `renderMessages(messages)` paints the
  first batch, filter to assistant messages, take the last 3, and call
  `apiClient.synthesizeTts({ text, voice: story.tts_voice })` for each.
  Fire-and-forget; no toast, no error UI. Use a small concurrency limit
  (1 at a time is fine — prewarm is best-effort).
- **Missing-SW toast** — if `controllerchange` does NOT fire within 1s
  after sending `SKIP_WAITING`, show a one-shot toast via the existing
  transient-toast helper. Find the existing toast function in
  `story.page.js` (likely `showTransientError` / `showToast` /
  `showNotification`). Re-use it; don't create a parallel one.

## Files to touch

- Modify: `frontend/public/js/pages/story.page.js`
  - Add module-scope helper `punchSwToCurrent()` returning a Promise that
    resolves when the new SW claims the client (or rejects after 1s).
  - Call `punchSwToCurrent()` at the top of `loadStoryAndMessages`
    (before `apiClient.get(story)`) and chain the missing-SW toast on
    rejection.
  - Add module-scope helper `prewarmLatestAssistantTts(messages, voice)`
    that filters assistant messages, takes the last 3 (newest-first
    order from Task A's iterator), and synthesizes them serially with
    `apiClient.synthesizeTts`. Catch all errors silently.
  - Call `prewarmLatestAssistantTts(messages, settledVoice)` after
    `renderMessages(messages)` paints the first batch.
- Modify: `frontend/public/js/api/apiClient.js`
  - Confirm `synthesizeTts({text, voice})` exists and returns a Promise
    resolving with the audio Blob (or `{success, data: {audio: ...}}`).
    If absent, add it as a thin POST wrapper around `/api/tts` (no
    SSE — the prewarm can block on a regular fetch).

## Constraints

- Vanilla JS, no new deps, exact-match edits.
- The prewarm must NOT block the first paint. Fire after `renderMessages`.
- The SW probe must NOT block if SW is unsupported (`'serviceWorker' in navigator`).
- Toast helper must already exist — find and re-use; don't add a parallel
  toast system.
- The synthesized TTS in prewarm uses the same `apiClient.synthesizeTts`
  that the page's per-bubble play button uses, so the backend's Edge-TTS
  cache fills up identically.

## Self-check test

Add `tests/test-sw-boot-probe.mjs`:

- Pure-Node test of the helper logic with `navigator` / `serviceWorker`
  stubbed via `globalThis`. The helper must:
  1. Resolve immediately if `'serviceWorker' in navigator` is false.
  2. Resolve immediately if `navigator.serviceWorker.controller` already
     matches the current `?v=N`.
  3. Reject (so the toast fires) if `postMessage({type: 'SKIP_WAITING'})`
     is sent and `controllerchange` does not fire within the 1s ceiling.
  4. Resolve on `controllerchange` within 1s.

To keep the test pure-Node, factor the helper so the timeout / postMessage /
controllerchange logic lives in a testable inner function. Acceptable
shape:

```javascript
// top of story.page.js
async function probeServiceWorker(currentV) {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  const ctrl = navigator.serviceWorker.controller;
  if (reg?.active?.scriptURL?.includes(`?v=${currentV}`) ||
      ctrl?.scriptURL?.includes(`?v=${currentV}`)) {
    return 'current';
  }
  if (!reg || !reg.active) return 'missing';
  reg.active.postMessage({ type: 'SKIP_WAITING' });
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 1000);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(t);
      resolve('claimed');
    }, { once: true });
  });
}
```

Test stub `globalThis.navigator.serviceWorker` with a tiny mock that
emits `controllerchange` (or not) on demand.

Exit 0 with all four cases passing. Print:
`OK — sw-boot-probe: 4/4 cases pass`.

## Verify

```
node tests/test-sw-boot-probe.mjs        # new
node tests/test-sanitize-final-content.mjs
node tests/test-incremental-load.mjs
node tests/test-pagination-e2e.mjs
node tests/test-pagination-empty-mid-history.mjs
node tests/test-list-messages-shim.mjs
node tests/test-ai-error-handlers.mjs
node tests/test-memory-state.mjs
node tests/test-model-chain.mjs
npm run build:css
```

All must exit 0.

## Commit

Single commit: `perf(tts): SW boot probe + prewarm latest 3 assistant messages`

## Report

Write to `.superpowers/sdd/task-C-report.md`. Include status, files modified,
test runs, concerns, commit hash.

Return only status + commit hash + one-line test summary + concerns.