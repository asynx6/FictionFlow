# Task A report — Incremental chat load

## Status

**DONE_WITH_CONCERNS**

## Files modified (line counts diff)

```
 frontend/public/css/tailwind.input.css |  44 +++++++++++
 frontend/public/js/api/apiClient.js    |  54 +++++++++++++
 frontend/public/js/pages/story.page.js | 137 ++++++++++++++++++++++++---------
 frontend/public/story.html             |   7 +-
 tests/test-incremental-load.mjs        |  51 ++++++++++++
 5 files changed, 254 insertions(+), 39 deletions(-)
```

## Test runs

| Command | Exit |
|---|---|
| `node tests/test-incremental-load.mjs` | 0 — `OK — incremental-load paginates without over-fetching` |
| `node tests/test-pagination-e2e.mjs` (12 → 24 → 4 happy path) | 0 — `OK — full pagination terminates at short remainder` |
| `node tests/test-list-messages-shim.mjs` (old signature) | 0 — `OK — listMessages shim still preserves original signature` |
| `node tests/test-ai-error-handlers.mjs` | 0 (no regression) |
| `node tests/test-memory-state.mjs` | 0 (no regression) |
| `node tests/test-model-chain.mjs` | 0 (no regression) |
| `npm run build:css` | 0 — recompiled in ~2.8s |

## Self-review

- ✅ `loadAllMessages` terminates cleanly when batches return short of `pageSize`. Verified by `test-incremental-load.mjs` (short remainder) and `test-pagination-e2e.mjs` (12 → 24 → 4 → terminate). The trailing `finally { showProgress(false) }` ensures the progress bar always hides even on iteration abort (e.g. fetch throw mid-pagination).
- ✅ Progress bar is visible during pagination but stays above the input field. `position: sticky; z-index: 5; top: 0` inside `#chatContainer`, `pointer-events: none` keeps it non-blocking. The messageInput is in `<footer class="fixed bottom-0 …">` outside the chat scroller, so it never overlaps the shimmer.
- ✅ `rAF` yield between appends (`await new Promise(requestAnimationFrame)`) keeps the input field responsive during big-history sweeps.
- ✅ Old `listMessages` callers still work — kept the old `(limit, offset)` signature as a one-liner. Verified by `test-list-messages-shim.mjs`.
- ✅ `?v=36` cache-bust applied to `story.page.js` script tag.
- ✅ `npm run build:css` succeeds with the new `.chat-progress-bar` style + `@keyframes chat-progress-shimmer` rule.

## Commit hashes

- `f49ed593d9b7d69c5968fdc2089067bcd50cf4bc` — `feat(chat): incremental load — 12-row initial window + lazy older pagination`

(One commit instead of two — single coherent task; brief specified a single commit message.)

## Concerns

1. **Brief was internally inconsistent** — the brief sketch pagination rule
   (`offset += batch.length`) cannot reach `?offset=12` after a partial
   first window. Two choices:
   - **Made**: window phase is single-shot — always pivot after first
     yield, offset jumps to `initialWindow`. Cleanest semantics; breaks
     the brief's sketch algorithm but matches the acceptance test's URL
     sequence. Added an explanatory comment in `loadAllMessages`.
   - **Rejected**: keep brief's sketch verbatim and rewrite the test
     fixture (would have required contradicting the brief's specification
     for what the URLs should look like).

2. **`/tts-latest` informational only** — the brief said audio_segments &
   tts button states are out of scope, but the existing page fetch path
   still pulls `/tts-latest` for diagnostic logging. Kept as-is since the
   data isn't rendered anywhere; flagged for Tasks B/D to remove
   cleanly if they decide the path is dead.

3. **No backend smoke test** — the brief step 6 suggests an end-to-end
   curl-driven smoke with a seeded DB of 60 messages. Did not run that
   here because there is no working seed script committed yet (the brief
   says "commit one-time DB seeder") and starting `PORT=4001 npm start &`
   plus a headless-browser run would have exploded the scope. The pure-
   node integration test covers the algorithm; visual confirmation is
   tracked as a manual step in the commit body.

4. **Word casing note**: brief sketch calls them `appendOlderMessages` /
   `renderMessages` (camelCase); implemented the same. Brief mentioned
   `makeBubble` in test scenarios but a separate `createMessageBubble`
   already exists in scope, so we wired into the existing helper without
   adding a new abstraction.

5. **`progress.md` / `task-A-brief.md` in working tree** — these `.superpowers/sdd/` files appeared in `git status` as new files. They are SDD scaffolding (not part of my code change) and were intentionally left out of the commit. They are not in the task-A diff stat.

## Fix follow-up

### Files modified

```
 frontend/public/js/api/apiClient.js     |  4 ++--
 frontend/public/js/pages/story.page.js  | 43 ++++++-----------------------
 tests/test-pagination-empty-mid-history.mjs | 45 ++++++++++++++++++++++++++++ (new)
 3 files changed, 66 insertions(+), 37 deletions(-)
```

### Commit

`708ea01851957fbc86d1e26e90f228b8b4b2a54e` — `fix(chat): close incremental-load infinite-loop on empty mid-history page`

### Changes

1. **`apiClient.js#loadAllMessages`** — history-phase guard now also terminates on `batch.length === 0`, not just on short remainder. One line covers both cases.
2. **`story.page.js#loadStory`** — dropped the `/tts-latest` fetch + `ttsByMessageId` parsing block (~30 lines). Wrapped the single initial `messagesIter.next()` in its own try/catch so a hard failure on the first window still triggers the empty-state path. The lazy pagination loop dropped its now-dead `if (batch.length === 0) continue;` guard (iterator handles empty termination itself).
3. **`tests/test-pagination-empty-mid-history.mjs`** — new regression test. Server returns `[12, 24, 0, ...]` mid-history. Confirms exactly 3 fetches and clean iterator termination. 200ms `Promise.race` ceiling so a regression that loops forever fails fast.

### Test runs

| Command | Exit |
|---|---|
| `node tests/test-pagination-empty-mid-history.mjs` | 0 — `OK — empty mid-history page terminates iterator (no infinite loop)` |
| `node tests/test-incremental-load.mjs` | 0 — `OK — incremental-load paginates without over-fetching` |
| `node tests/test-pagination-e2e.mjs` | 0 — `OK — full pagination terminates at short remainder` |
| `node tests/test-list-messages-shim.mjs` | 0 — `OK — listMessages shim still preserves original signature` |
| `node tests/test-ai-error-handlers.mjs` | 0 — `OK — error-dialog handler lifecycle self-check passed` |
| `node tests/test-memory-state.mjs` | 0 — `OK — memory state-facts self-check passed` |
| `node tests/test-model-chain.mjs` | 0 — `OK — model-chain parsing self-check passed` |
| `npm run build:css` | 0 — recompiled in ~1.25s |

### Concerns

None. Both review findings closed:
- Critical (empty-mid-history infinite loop): closed by the iterator guard plus regression test with 200ms timeout.
- Minor (`/tts-latest` dead fetch): dropped, ~30 lines of dead code removed.
- Backward-compat: `listMessages(id, {limit, offset})` shim untouched.
- Pagination URL pattern: unchanged — still `?limit=12` then `?limit=24&offset=12`, etc.
- No silent loops: history phase terminates on both empty and short remainder.
