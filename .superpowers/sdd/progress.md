# Chat session stability — progress ledger

Tracked here by controller so context-loss recovery can resume. Each
task line records commit + review status.

## Pre-flight findings

- Plan text references "3-button gate" in two top-line summaries (line 5 and 7). This is from the first draft; task D body correctly builds the 2-button gate. Flag for Task D reviewer.
- Task A does not explicitly say "Task A's `appendOlderMessages` shares the same `makeBubble` helper that Task B will introduce." Resolve: present Task A's brief with the rule that history render must apply sanitizer. Since Task B introduces `sanitizeFinalContent` and the `makeBubble` wrapper, Worker A should just call `createMessageBubble(m)` (no wrapping yet); Task B will wrap it. Resolve via Task B dispatch.

## Tasks

- **A (incremental chat load)**: complete (commits `f49ed59` + `708ea01`, review clean).
- B (sanitize finalContent): complete (commit `400ba7e`, review clean)
- C (SW prewarm): complete (commit `6f4411b`, review clean) — Minor polish pending: register SW with `?v=N` to enable probe fast-path
- D (2-button TTS gate): complete (commit `c431bb7`, self-check 26/26)
- Stragglers committed (`b6e5dc3`): tests/test-list-messages-shim.mjs + tests/test-pagination-e2e.mjs
- Whole-branch review: APPROVED (no Critical/Important findings; compose/sanitize/no-loop/backcompat/cache-bust verified)
