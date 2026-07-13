# Task B brief — sanitize finalContent

## Goal

Eliminate the JSON-wrapper leak in chat bubbles. When the LLM emits a
response whose body is a JSON envelope (`{"full_story": "..."}` or
`{"audio_segments": [...]}`), the bubble currently renders the raw
envelope. We add a small client-side sanitizer and apply it at the two
sites where AI bubble text crosses from server data into DOM.

## Spec contract (from `docs/superpowers/specs/2026-07-13-chat-stability-design.md` Component B)

The sanitizer function lives in module scope in `story.page.js`:

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

Apply at two sites in `story.page.js`:

1. **SSE `done` handler** — before assigning `displayedText = finalContent`
   (or equivalent sink) and before bubble rendering for the in-flight
   response.
2. **History render** in `renderMessages` (the helper introduced by Task A
   in `loadStoryAndMessages`) — before passing `m.content` / `m.raw_content`
   into the bubble builder / `formatTextWithMarkdown`.

`appendOlderMessages` must apply the sanitizer too, since it can render
historical rows that contain the raw envelope.

## Files to touch

- Modify: `frontend/public/js/pages/story.page.js`
  - Add module-scope `sanitizeFinalContent(text)`.
  - Call it in the SSE `done` consumer (search for `event === 'done'` /
    `data.full_content` — the value comes from the SSE payload; sanitize
    it before assigning to the bubble's text sink).
  - Call it in `renderMessages` before `createMessageBubble(m)`.
  - Call it in `appendOlderMessages` before `createMessageBubble(messages[i])`.
  - Prefer **one sanitizer call at the bubble-build boundary** (`createMessageBubble`)
    instead of every consumer if that's mechanically simpler. Document
    the choice with a one-line comment.
- Create: `tests/test-sanitize-final-content.mjs` — pure-Node test file
  with 7 cases (see "Self-check tests" below).

## Self-check tests (7 cases, all in `tests/test-sanitize-final-content.mjs`)

Each case asserts `sanitizeFinalContent(input) === expected`:

1. **JSON envelope with `full_story`.**
   Input: `'{"full_story": "halo dunia", "audio_segments": []}'`
   Expected: `'halo dunia'`
2. **JSON envelope with `audio_segments` array (no `full_story`).**
   Input: `'{"audio_segments": [{"text": "bagian 1"}, {"text": "bagian 2"}]}'`
   Expected: `'bagian 1\nbagian 2'`
3. **JSON envelope with neither — fallback to `story` / `text` / `narration`.**
   Input: `'{"story": "narasi panjang"}'`
   Expected: `'narasi panjang'`
   (Use this exact case; the other two candidates (`text`, `narration`)
   are covered implicitly — the order is `story ?? text ?? narration`.)
4. **Plain prose (no transformation).**
   Input: `'halo dunia\nini prosa biasa'`
   Expected: `'halo dunia\nini prosa biasa'`
5. **Mixed: starts with `{` then legitimate prose.**
   Input: `'{ini JSON yang tidak valid\nhalo dunia\nbaris prosa'`
   Expected: `'halo dunia\nbaris prosa'`
   (First line opens `{`, has no `}` → dropped.)
6. **Null / empty / non-string inputs.**
   Inputs: `null`, `''`, `undefined`, `42`, `{}`.
   Expected: `''` for all five.
7. **Malformed truncated JSON.**
   Input: `'{"full_story":'`
   Expected: `''` (the empty join after the dropped line).

The test file must:
- Import `sanitizeFinalContent` from the source file via a thin shim.
  Since `sanitizeFinalContent` will live in `story.page.js` which is not
  a pure module, **export the function via a small re-export file** OR
  redefine the function at the top of the test file (preferred for
  simplicity — keep it as a self-contained test). Pick the redefinition
  approach unless extracting to a sibling module makes the source
  cleaner. Document the choice with a one-line comment in the test.
- Exit 0 with all 7 cases passing.
- Print: `OK — sanitizeFinalContent: 7/7 cases pass`.

## Test runner

```
node tests/test-sanitize-final-content.mjs
```

## Verify

After implementation:

```
node tests/test-sanitize-final-content.mjs   # new
node tests/test-incremental-load.mjs          # no regression
node tests/test-pagination-e2e.mjs
node tests/test-pagination-empty-mid-history.mjs
node tests/test-list-messages-shim.mjs
node tests/test-ai-error-handlers.mjs
node tests/test-memory-state.mjs
node tests/test-model-chain.mjs
npm run build:css
```

All must exit 0.

## Constraints

- Vanilla JS, no new deps, exact-match edits.
- One sanitizer definition, applied at the right boundary. Don't sprinkle
  calls everywhere.
- Indonesian user-facing strings (if any) stay Indonesian.

## Commit

Single commit: `fix(chat): sanitize finalContent — strip JSON envelope from AI bubble`

## Report

Write to `.superpowers/sdd/task-B-report.md`. Include:
- Status (DONE | DONE_WITH_CONCERNS | BLOCKED).
- Files modified (line counts diff).
- Test runs (the table, exit code + one-line summary).
- Concerns (e.g. sanitizer placement decision).
- Commit hash.

Return only status + commit hash + one-line test summary + concerns.