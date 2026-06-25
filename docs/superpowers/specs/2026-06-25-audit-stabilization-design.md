# Audit-Driven Stabilization Design

**Goal:** Land fixes for the 2 High + 6 Medium findings from the 2026-06-25 read-only audit (`a4e616747966033fe`), plus the uncommitted `@lixen/edge-tts` ESM/CJS import fix in `backend/src/services/edgeTts.service.js`.

**Architecture:** Read-only audit already validated there is no SQLi, no path traversal, no `.env` leak, no auth bypass. This stabilization pass tightens runtime hygiene (event-listener leak, unbounded timers, prompt-bomb surface) and codifies intent for latent risks (XSS via JSON-in-attribute, prompt injection framing, ESM/CJS interop).

**Tech Stack:** Express 4 + better-sqlite3 + Node ESM, vanilla JS ESM frontend. No new deps.

---

## In-scope findings (8 fix + 1 carry-over commit)

| # | Sev | File:line | Category | One-sentence fix |
|---|---|---|---|---|
| EdgeTTS | (carry) | `backend/src/services/edgeTts.service.js:12` | ESM/CJS interop | Replace `import { EdgeTTS }` with `import pkg → const { EdgeTTS } = pkg` (already in working tree, awaiting commit). |
| F1 | High | `frontend/public/js/pages/story.page.js:921–922` | Listener accumulation | Move `continueErrorBtn`/`cancelErrorBtn` clicks to module-scoped handlers stored once; add explicit `removeEventListener` on dialog close + finish paths. |
| F2 | High | `frontend/public/js/pages/story.page.js:994–1013` | Unbounded timers | Track `_lastFactPollTimerId` module-scope; `clearTimeout` before scheduling new one; cap max 1 timer alive. |
| F3 | Medium | `backend/src/controllers/stories.controller.js:35–47` (`buildUpdate` + `updateStory`) | Input length cap | Per-field max-length on `STORY_EDITABLE` (user_persona 1000, ai_personality 500, language_style 80, title 200, target_ending 1000) — reject 413. |
| F4 | Medium | `backend/src/routes/messages.routes.js:54–88` (`POST /messages`) | Input length cap | Hard-cap `req.body.content.length` ≤ 20 000 chars; reject 413. |
| F5 | Medium | `frontend/public/js/pages/story.page.js:793` | Latent XSS | Replace `ttsBtn.setAttribute('data-segments', JSON.stringify(segs))` with manual escape (`<→&lt;` etc. or store parse via Blob). Simpler: change `data-segments` to be set via `setAttribute` AND read via `getAttribute` only (current safe pattern, but add explicit guard comment + never expose to innerHTML). |
| F6 | Medium | `backend/src/services/memoryExtractor.service.js:124–139 + 153–171` | Silent error | Add structured `console.error("[memory-extractor]", { stage, error })` and bump `process.env.DEBUG_EXTRACTOR` log gate; no telemetry, just visibility. |
| F7 | Medium | `frontend/public/js/pages/dashboard.page.js:201–247` | Event delegation | Replace per-render `querySelectorAll(...).forEach(addEventListener)` with single delegated listener on `storiesList` parent. |
| F8 | Medium | `frontend/public/js/core/eventBus.js` | API surface | Add `off(event, listener)` method; no consumer refactor (single full-reload SPA, but API surface for future). |

## Out-of-scope (defer)

- 5 Low (prompt-injection framing, voice allowlist, model_id whitelist, dashboard XSS, markdown CDN SRI) — all flagged single-user trust, no immediate exploit.
- 4 Info (Bearer warn noise, dead `lang === 'id-ID'` ternary, `PRAGMA table_info` string concat, hard-exit `unhandledRejection`) — after F1+F2 are closed, server-restart severity drops to cosmetic.

## Architecture rules

1. **Each fix is one concern.** No bundled "while we're here" refactor.
2. **No new tests.** Existing infra only e2e (real DB). Each backend fix gets `node --check` pass; each frontend fix gets a syntax pass (`node --check` works for ESM only — requires `node --input-type=module`; alternative = `npx tsc --noEmit --allowJs --noImplicitAny=false`). Simplest gate: `node -e "import('./path/to/file.js').catch(e=>{console.error(e);process.exit(1)})"` for ESM.
3. **Frequent commits.** One file = one commit body unless trivially coupled (F5+F6 different files = 2 commits).
4. **No regression scope creep.** Don't add fields to `STORY_EDITABLE` whitelist; don't add new error codes other than 413; don't introduce logger abstraction.

## Affected files (8 + 1 carry-over)

| File | Fix |
|---|---|
| `backend/src/services/edgeTts.service.js` | EdgeTTS carry |
| `frontend/public/js/pages/story.page.js` | F1, F2, F5 |
| `backend/src/controllers/stories.controller.js` | F3 |
| `backend/src/routes/messages.routes.js` | F4 |
| `backend/src/services/memoryExtractor.service.js` | F6 |
| `frontend/public/js/pages/dashboard.page.js` | F7 |
| `frontend/public/js/core/eventBus.js` | F8 |

## Spec self-review

- ✓ All 8 fixes covered.
- ✓ No "TBD"/"todo later"/"appropriate handling" placeholders fixed inline (F6 specifies exact log line).
- ✓ Type/identifier consistency: `_lastFactPollTimerId` used consistently across F2.
- ✓ Scope: focused on audit, single plan.
