# Task A fix brief — close review findings

## Why this fix

Task A reviewer (`f49ed59`) returned:
- **Spec compliance: FAIL** — drift in function naming (`listMessages` → `loadAllMessages`, `window` → `initialWindow`, two-phase state machine). The drift is acceptable and matches the global-constraints rule "keep `listMessages` as backward-compat shim". No fix needed.
- **Code quality: NEEDS_FIX**:
  - **Critical**: `if (batch.length === 0) continue;` in `story.page.js` line 1264 + history-phase termination in `apiClient.loadAllMessages` only checks `batch.length < pageSize`. **Empty mid-history page → infinite loop.** Fix at the iterator: an empty batch in history phase means "we hit the top", so `return`.
  - **Minor**: `/tts-latest` fetch is informational only; the renderer ignores it. Out-of-scope drop. **Acceptable to keep or drop — drop it.**

## What to change

### 1. `frontend/public/js/api/apiClient.js` — `loadAllMessages`

In the history-phase branch, treat `batch.length === 0` as terminal:

```javascript
} else {
  // History phase: empty page or short remainder terminates cleanly.
  if (batch.length === 0 || batch.length < pageSize) return;
  offset += batch.length;
}
```

Place the guard before the offset advance so a single line covers both
empty-mid-history and short-remainder.

### 2. `frontend/public/story.html` — no change

### 3. `frontend/public/js/pages/story.page.js`

Two changes:

**(a) Drop the now-redundant `if (batch.length === 0) continue;` in the lazy
pagination loop** (lines 1263–1264). With the iterator fix, an empty batch
will terminate the loop via `next.done`. The branch becomes:

```javascript
while (true) {
  const next = await messagesIter.next();
  if (next.done) break;
  appendOlderMessages(next.value);
  await new Promise(requestAnimationFrame);
}
```

The `const batch = Array.isArray(next.value) ? next.value : []` defensive
guard becomes dead code too. Drop it.

**(b) Drop the `/tts-latest` fetch** + the `ttsByMessageId` parsing block
(lines 1206–1235). The `Promise.allSettled` was
`[messagesIter.next(), apiClient.get(.../tts-latest)]`. After the drop it
becomes just `await messagesIter.next()`. Wrap in its own try/catch so a
hard failure on the initial window doesn't break the empty-state path.

```javascript
let initial;
try {
  initial = { status: 'fulfilled', value: { value: (await messagesIter.next()).value ?? [] } };
} catch (err) {
  initial = { status: 'rejected', reason: err };
}
```

Then the rest of the function reads `initial.value?.value ?? []` /
`initial.reason`.

## Tests to add

Add ONE case to `tests/test-pagination-e2e.mjs` (or create a new
`tests/test-pagination-empty-mid-history.mjs` if simpler):

- Server returns `[12, 24, 0, ...]` mid-history (i.e. an empty page after
  one full page). Confirm the iterator terminates and total fetched URLs
  is exactly 2 (window + one history page) without infinite loop.
- Add a 200ms timeout via `Promise.race` so a regression that loops
  forever fails the test fast.

## Verify

Run all of:

```
node tests/test-incremental-load.mjs
node tests/test-pagination-e2e.mjs
node tests/test-list-messages-shim.mjs
node tests/test-ai-error-handlers.mjs
node tests/test-memory-state.mjs
node tests/test-model-chain.mjs
npm run build:css
```

All must exit 0. Add the new test to the run list. Append results to the
report file.

## Commit

Single commit: `fix(chat): close incremental-load infinite-loop on empty mid-history page`

## Report

Append your report to `.superpowers/sdd/task-A-report.md` under a `## Fix
follow-up` heading. Include:
- Files modified
- Test runs (the table, exit code + one-line summary)
- Concerns (any)

Return status: DONE | DONE_WITH_CONCERNS | BLOCKED.