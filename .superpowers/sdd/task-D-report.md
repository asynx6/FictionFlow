# Task D report — 2-button TTS gate

## Status

**DONE**

## Files modified (line counts diff)

```
 frontend/public/css/tailwind.input.css     | 162 ++++++++++++++++--------------
 frontend/public/js/pages/story.page.js     |  97 +++++++++++++-----------
 frontend/public/story.html                 |   2 +-
 tests/test-tts-button-lifecycle.mjs        | 168 ++++++++++++ (new)
 4 files changed, 406 insertions(+), 167 deletions(-)
```

## What changed

- `frontend/public/css/tailwind.input.css` — replaced the old `.tts-toolbar` /
  `[data-action]` block with a new `.tts-action-group` rule set keyed on the
  wrapper's `data-state`. Visibility for idle/loading/playing/paused is now
  pure-CSS via descendant selectors (`[data-state="…"] [data-role=…]`).
  Removed unused `.tts-pause-btn` / `.tts-resume-btn` selectors because the
  browser now uses a single toggle whose icon swaps in-place.

- `frontend/public/js/pages/story.page.js` — replaced the single per-bubble
  `<button class="tts-play-btn">` with a 4-button `.tts-action-group` wrapper
  (`play` + `loading` + `toggle` + `stop`). `_activeTtsBtn` now stores the
  group element. `_setTtsBtnState` resolves whether you hand it a wrapper or a
  legacy button reference, sets the wrapper's `data-state`, and swaps the
  toggle icon (`pause` ↔ `play_arrow`) in place. The document-level click
  delegate routes by `data-role`: `play` / `toggle` → `_onTtsPlayOrToggleClick`,
  `stop` → `_onTtsStopClick`. The stop handler pauses audio + resets
  `currentTime = 0` + clears `_activeTtsBtn` only if this group is the
  active one. State machine unchanged: only `pause` / `play()` on the same
  `_ttsAudio` element, never a second `<audio>` per bubble.

- `frontend/public/story.html` — bumped cache-bust `?v=37 → ?v=38`.

- `tests/test-tts-button-lifecycle.mjs` (new) — 26 pure-Node assertions
  across 8 case groups:
  1. idle: only `play` visible, icon `volume_up`, title "Dengarkan".
  2. loading: only `loading` visible, icon `hourglass_top`.
  3. playing: `toggle` (icon `pause`) + `stop` (icon `stop`).
  4. paused: `toggle` (icon `play_arrow`) + `stop` (icon `stop`).
  5. stop while playing: state → idle, `_ttsAudio.pause()`, `currentTime = 0`,
     `_activeTtsBtn` cleared.
  6. stop while paused: same outcome.
  7. toggle while playing: state → paused, `currentTime` unchanged.
  8. toggle while paused: state → playing, audio plays, `currentTime` unchanged.

## Test runs

| Command | Exit | Summary |
|---|---|---|
| `node tests/test-tts-button-lifecycle.mjs` | 0 | `OK — tts-button-lifecycle: 26/26 cases pass` (new) |
| `node tests/test-sw-boot-probe.mjs` | 0 | `OK — sw-boot-probe: 4/4 cases pass` (no regression) |
| `node tests/test-sanitize-final-content.mjs` | 0 | `OK — sanitizeFinalContent: 11/11 cases pass` (no regression) |
| `node tests/test-incremental-load.mjs` | 0 | `OK — incremental-load paginates without over-fetching` (no regression) |
| `node tests/test-pagination-e2e.mjs` | 0 | `OK — full pagination terminates at short remainder` (no regression) |
| `node tests/test-pagination-empty-mid-history.mjs` | 0 | `OK — empty mid-history page terminates iterator (no infinite loop)` (no regression) |
| `node tests/test-list-messages-shim.mjs` | 0 | `OK — listMessages shim still preserves original signature` (no regression) |
| `node tests/test-ai-error-handlers.mjs` | 0 | `OK — error-dialog handler lifecycle self-check passed` (no regression) |
| `node tests/test-memory-state.mjs` | 0 | `OK — memory state-facts self-check passed` (no regression) |
| `node tests/test-model-chain.mjs` | 0 | `OK — model-chain parsing self-check passed` (no regression) |
| `npm run build:css` | 0 | Done in 1.3s |

## Commit hash

`c431bb7` — `feat(chat): 2-button TTS gate (toggle pause/resume + stop)`

## Concerns

1. **`role="loading"` button handler guard.** The click delegate filters
   `if (role === 'loading') return;` even though the button is `disabled`
   in the markup. Belt-and-braces. If a future CSS rewrite accidentally
   drops `pointer-events: none` on the loading button, the guard prevents
   re-triggering the synthesize call while the previous fetch is in flight.
2. **`stop` on non-active bubble doesn't disturb playback.** Per spec — the
   user could click `stop` on a stale bubble whose state is `loading` /
   `playing` from a previous attempt that was superseded. That group's
   state resets but `_ttsAudio` continues playing the active bubble's blob.
   Visual cleanup only; no audio side effect.
3. **Manual visual confirmation pending.** Real users on desktop + mobile
   should confirm the new gate, especially:
   - hover-only visibility still works (`opacity: 0` → 1 on group hover).
   - reduced-motion disables the spin + pulse animations.
   - the new icon-font glyph names (`hourglass_top`, `pause`,
     `play_arrow`, `stop`) render in Material Icons Round.
