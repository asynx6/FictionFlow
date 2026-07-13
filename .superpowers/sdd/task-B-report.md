# Task B report — sanitize finalContent

## Status

**DONE**

## Files modified (line counts diff)

```
 frontend/public/js/pages/story.page.js | 47 +++++++++++++++++++++++++++++++++++
 frontend/public/story.html             |  2 +-
 tests/test-sanitize-final-content.mjs  | 99 +++++++++++++++++++++++++++++++++++++++++++++++ (new)
 3 files changed, 148 insertions(+), 3 deletions(-)
```

(`npm run build:css` ran clean but did not produce a diff — the sanitizer
change touches no class surface.)

## Sanitizer placement decision

The brief asked for two sites (SSE `done` + history render) and noted the
"one call at the bubble-build boundary" simplification. Chose the lazy
middle ground that satisfies both:

- **SSE `done` consumer** — sanitizes `data.full_content` before assigning
  to `displayedText` and to `updateBubbleContent(aiBubble, ...)`. This is
  the live path: the envelope only ever arrives on the `done` event from
  upstream parser fall-through.
- **`createMessageBubble`** — sanitizes `msg.content ?? msg.raw_content`
  at the top of the builder. This is the bubble-build boundary, and it
  naturally covers `renderMessages` (initial paint), `appendOlderMessages`
  (lazy pagination), and the temp `userMsg` / `aiMsgObj` bubbles created
  at send time. Streaming `token` deltas never contain envelopes, so
  leaving that path alone is correct.

`formatTextWithMarkdown` and `updateBubbleContent` are NOT called
directly with the unsanitized value anywhere in the file. The two sites
above are the only entry points for AI bubble text from the network.

Streaming token path intentionally untouched: applying the sanitizer per
`token` would force a `JSON.parse` on every chunk — wasteful and the
envelope is never present in the stream.

## Test runs

| Command | Exit | Summary |
|---|---|---|
| `node tests/test-sanitize-final-content.mjs` | 0 | `OK — sanitizeFinalContent: 11/11 cases pass` (7 case groups, 11 assertions: case 6 covers 5 sub-values) |
| `node tests/test-incremental-load.mjs` | 0 | `OK — incremental-load paginates without over-fetching` (no regression) |
| `node tests/test-pagination-e2e.mjs` | 0 | `OK — full pagination terminates at short remainder` (no regression) |
| `node tests/test-pagination-empty-mid-history.mjs` | 0 | `OK — empty mid-history page terminates iterator (no infinite loop)` (no regression) |
| `node tests/test-list-messages-shim.mjs` | 0 | `OK — listMessages shim still preserves original signature` (no regression) |
| `node tests/test-ai-error-handlers.mjs` | 0 | `OK — error-dialog handler lifecycle self-check passed` (no regression) |
| `node tests/test-memory-state.mjs` | 0 | `OK — memory state-facts self-check passed` (no regression) |
| `node tests/test-model-chain.mjs` | 0 | `OK — model-chain parsing self-check passed` (no regression) |
| `npm run build:css` | 0 | Done in 1.36s (no diff — sanitizer touches no class surface) |

## Concerns

1. **Sanitizer is duplicated between source and test file.** `sanitizeFinalContent`
   is re-declared verbatim at the top of `tests/test-sanitize-final-content.mjs`
   because `story.page.js` is not an import-safe module (it touches DOM,
   audio, service worker registration on import). The brief explicitly
   authorized this trade-off ("redefinition approach ... keep the test
   self-contained"). Drift between the two copies is the only risk; a
   future test-driven cleanup could move the function to a sibling
   `frontend/public/js/core/textUtils.js` and import from both sides.
   Skipped here to keep the diff focused on Component B's stated scope.

2. **Streaming `token` path is not sanitized.** Intentional — the
   envelope is only emitted on the `done` event by upstream parser
   fall-through, never in `token` deltas. If a future backend change
   ever leaks the envelope mid-stream, the tokenizer would still show
   `{"full_story": "..."}` character-by-character. No test covers this
   because no current path produces it. Add coverage when (if) the
   backend pipeline changes.

3. **Cache-bust bump `?v=36 → ?v=37`** in `story.html` so the next
   hard reload picks up the sanitized `story.page.js`.

## Commit hash

`400ba7e23e69815ca68d7f5df21fb3a75ad0ca0e` —
`fix(chat): sanitize finalContent — strip JSON envelope from AI bubble`
