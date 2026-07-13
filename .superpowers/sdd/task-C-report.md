# Task C report — SW boot probe + TTS prewarm

## Status

DONE

## Commit

`6f4411b` — `perf(tts): SW boot probe + prewarm latest 3 assistant messages`

## Files modified

- `frontend/public/js/pages/story.page.js` (+98 lines, module-scope only — no edits to existing surface)
  - New module-scope helpers: `probeServiceWorker(currentV, timeoutMs = 1000)`, `_currentSwVersion()`, `prewarmLatestAssistantTts(messages, voice)`
  - SW probe fired at the top of `loadStoryAndMessages` (fire-and-forget; toast on timeout rejection)
  - `prewarmLatestAssistantTts` invoked after the first `renderMessages(messages)` paint, deferred to `requestAnimationFrame` so the actual paint lands first
- `tests/test-sw-boot-probe.mjs` (new — 4 cases)

No changes to `frontend/public/js/api/apiClient.js` — `synthesizeTts` already exists at `frontend/public/js/api/apiClient.js:276` and returns a Promise resolving with the audio Blob.

## Test runs

```
node tests/test-sw-boot-probe.mjs                       # new
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

All exit 0. New self-check `OK — sw-boot-probe: 4/4 cases pass`.

## Concerns

- The `?v=` baseline comes from the `<script src="...story.page.js?v=N">` tag in `story.html`. The current registration in `story.html` registers `/sw.js` (no query), so neither `reg.active.scriptURL` nor `navigator.serviceWorker.controller.scriptURL` will ever include `?v=N` in production. This means the helper will *always* post `SKIP_WAITING` on first probe — which is the desired outcome (the SW is updated whenever the page script bumps its `?v=N`, so we always nudge the SW to claim). The helper sketch in the brief allowed for both URL-match and SKIP_WAITING paths, so this is consistent; we just don't get the "already current" early-out in practice. If we later want the optimization, register SW with `?v=N` too.
- The probe runs fire-and-forget — `apiClient.get(story)` does not wait on it. Network fetch and SW claim race; SW typically claims within a few hundred ms so the first `/api/tts` POST after warmup usually hits the SW cache, but a slow claim still surfaces via the toast.
- The prewarm awaits each `synthesizeTts` serially. Synthesis can take several seconds per bubble when the backend Edge TTS cache is cold; with 3 messages and a cold cache the loop can take 10–20s. The fire-and-forget pattern means this never blocks UI, but the *cache fills* trickle in over time. If the user clicks the 3rd-newest message first (synthesized last), they may still pay cold-cache latency. Acceptable for now — the prewarm is best-effort.
- The prewarm text source uses the same `sanitizeFinalContent` used for bubble render, so any `{"full_story": ...}` envelope legacy rows will be stripped before they hit the TTS cache. No duplication of sanitization logic.

## Self-check

The new `tests/test-sw-boot-probe.mjs` stubs `globalThis.navigator` via `Object.defineProperty` (Node 18+ has navigator as non-writable). The `timeoutMs` parameter (default 1000) lets case 3 use 50ms for fast CI; production callers rely on the default. The four required cases all pass.
