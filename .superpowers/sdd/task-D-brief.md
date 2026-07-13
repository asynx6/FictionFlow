# Task D brief — 2-button TTS gate

## Goal

Replace the single per-bubble `.tts-play-btn` with a 3-element button
group whose composition matches the user's requested flow:

- **idle**: one button — `volume_up` icon, title "Dengarkan".
- **loading**: one button — `hourglass_top` icon (spinning), title "Memuat audio…".
- **playing**: TWO buttons — toggle (icon `pause`, title "Jeda") + stop (icon `stop`, title "Hentikan").
- **paused**: TWO buttons — toggle (icon `play_arrow`, title "Lanjutkan") + stop (icon `stop`, title "Hentikan"). The toggle's icon swaps between `pause` and `play_arrow` in place; we do NOT render two separate buttons.
- **stop clicked → idle**: pause audio + `currentTime = 0`. The action group reverts to a single `volume_up` button. No resume from the previous `currentTime`.
- **resume from paused**: same `_ttsAudio` element resumes from the last paused timestamp. We never reset `currentTime` on pause.

Only one bubble plays at a time. Switching bubbles mid-play: previous
bubble reverts to its idle single button, new bubble enters loading then
2-button state.

## Current state (before Task D)

The page currently renders ONE `<button class="tts-play-btn">` per AI
bubble with `data-state` on the button switching between `idle |
loading | playing | paused`. The same button carries different icons
and titles. The user wants this split into a group: idle/loading = 1
button, playing/paused = 2 buttons (toggle + stop).

Relevant code locations in `frontend/public/js/pages/story.page.js`:

- Lines 280–411: the `_ttsAudio`, `_activeTtsBtn`, `_ttsCache`, `_setTtsBtnState`,
  `_resetAllTtsBtns`, `_playBlobAsAudio` infrastructure.
- Lines 413–504: `_onTtsPlayBtnClick` — the single-button click handler.
- Lines 506–511: the document-level click delegate using
  `e.target.closest('.tts-play-btn')`.
- Lines 1181–1186: the existing single-button template in
  `createMessageBubble` (within `loadStoryAndMessages`).

State machine stays the same; only the DOM wiring changes.

## What to change

### 1. Template — `createMessageBubble` (around line 1181)

Replace the single button with a wrapper carrying three role-distinct
elements. Use `data-role` to avoid CSS coupling and to let the document
delegate distinguish them. Keep the existing `data-msg-id`,
`data-text`, and the underlying data-state on the wrapper itself
(so `_setTtsBtnState(state)` keeps its meaning).

```html
<div class="tts-action-group" data-msg-id="${msg.id}" data-text="${encodeURIComponent(messageContent)}" title="Dengarkan (${resolveTtsVoice(currentStory)})">
  <button class="tts-play-btn tts-role-idle p-1 rounded-full text-theme-muted hover:text-theme-text hover:bg-theme-hover transition-colors"
          data-role="play">
    <span class="material-icons-round text-[16px]">volume_up</span>
  </button>
  <button class="tts-play-btn tts-role-loading p-1 rounded-full text-theme-muted hidden" data-role="loading" disabled>
    <span class="material-icons-round text-[16px] animate-spin">hourglass_top</span>
  </button>
  <button class="tts-play-btn tts-role-toggle p-1 rounded-full text-theme-muted hover:text-theme-text hover:bg-theme-hover transition-colors hidden" data-role="toggle" title="Jeda">
    <span class="material-icons-round text-[16px]">pause</span>
  </button>
  <button class="tts-play-btn tts-role-stop p-1 rounded-full text-theme-muted hover:text-theme-text hover:bg-theme-hover transition-colors hidden" data-role="stop" title="Hentikan">
    <span class="material-icons-round text-[16px]">stop</span>
  </button>
</div>
```

Visibility is controlled by `.hidden` toggling. The default visible
button is `play`. The user spec said "opacity-0 group-hover:opacity-100
focus:opacity-100" but those classes belong to the wrapper, not the
individual buttons. Add them to the wrapper:

```html
<div class="tts-action-group opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity" ...>
```

### 2. CSS — `.tts-action-group` rules in `frontend/public/css/tailwind.input.css`

Add (or update) the rules so the idle/loading/playing/paused states
flip visibility correctly. Template uses Tailwind `hidden` on three
buttons; the visible button is whichever matches the current state.
Anchoring on the wrapper's `data-state`:

```css
.tts-action-group { display: inline-flex; align-items: center; gap: 4px; }
.tts-action-group[data-state="idle"] .tts-role-play { display: inline-flex; }
.tts-action-group[data-state="idle"] .tts-role-loading,
.tts-action-group[data-state="idle"] .tts-role-toggle,
.tts-action-group[data-state="idle"] .tts-role-stop { display: none; }

.tts-action-group[data-state="loading"] .tts-role-loading { display: inline-flex; }
.tts-action-group[data-state="loading"] .tts-role-play,
.tts-action-group[data-state="loading"] .tts-role-toggle,
.tts-action-group[data-state="loading"] .tts-role-stop { display: none; }

.tts-action-group[data-state="playing"] .tts-role-toggle,
.tts-action-group[data-state="playing"] .tts-role-stop { display: inline-flex; }
.tts-action-group[data-state="playing"] .tts-role-play,
.tts-action-group[data-state="playing"] .tts-role-loading { display: none; }

.tts-action-group[data-state="paused"] .tts-role-toggle,
.tts-action-group[data-state="paused"] .tts-role-stop { display: inline-flex; }
.tts-action-group[data-state="paused"] .tts-role-play,
.tts-action-group[data-state="paused"] .tts-role-loading { display: none; }
```

`@media (prefers-reduced-motion: reduce)` should still kill the spin
animation on the loading hourglass — keep that rule.

The existing `.tts-toolbar` / `.msg-ai-block:hover .tts-toolbar` styles
targetting `.tts-toolbar` can stay. We are switching class names
because the user's spec uses "action group" not "toolbar". Either
delete the old `.tts-toolbar` rules OR keep them harmlessly. Pick the
simpler path: delete the unused `.tts-toolbar` rules since no markup
emits that class anymore. Verify before deleting.

### 3. `_setTtsBtnState` — change to operate on the wrapper

Currently `_setTtsBtnState(btn, state)` takes a button and sets
`data-state` on it. With the wrapper, the function should take the
WRAPPER (the `.tts-action-group` element) and toggle the wrapper's
`data-state`. The icon swap that previously lived inside this function
now becomes local to the toggle button — see step 4.

Rename to `_setTtsBtnState(group, state)` so existing call sites
continue to compile. Inside the function:

```javascript
function _setTtsBtnState(groupOrBtn, state) {
  if (!groupOrBtn) return;
  const group = groupOrBtn.classList?.contains('tts-action-group')
    ? groupOrBtn
    : groupOrBtn.closest('.tts-action-group');
  if (!group) return;
  group.setAttribute('data-state', state);
  // Toggle button icon swap (pause <-> play_arrow).
  const toggleIcon = group.querySelector('.tts-role-toggle .material-icons-round');
  if (toggleIcon) {
    if (state === 'playing') toggleIcon.textContent = 'pause';
    else if (state === 'paused') toggleIcon.textContent = 'play_arrow';
  }
}
```

### 4. Document-level click delegate — split by role

Currently one delegate catches `.tts-play-btn`. With 3 roles, the
delegate routes based on the clicked button's `data-role`:

```javascript
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.tts-play-btn');
  if (!btn) return;
  e.stopPropagation();
  const role = btn.getAttribute('data-role');
  const group = btn.closest('.tts-action-group');
  if (!group) return;
  if (role === 'play' || role === 'toggle' || role === 'loading') {
    void _onTtsPlayOrToggleClick(group);
  } else if (role === 'stop') {
    void _onTtsStopClick(group);
  }
});
```

`_onTtsPlayOrToggleClick(group)` is the renamed `_onTtsPlayBtnClick`,
operating on the group instead of the button. It reads
`data-msg-id="..."` and `data-text="..."` from the group, and reads
the state from the group's `data-state`.

`_onTtsStopClick(group)` is new:

```javascript
function _onTtsStopClick(group) {
  if (group !== _activeTtsBtn && !_activeTtsBtn?.contains?.(group) && !group.contains(_activeTtsBtn)) {
    // Stop on a non-active bubble — stop audio + reset that bubble's state.
    _setTtsBtnState(group, 'idle');
    return;
  }
  try { _ttsAudio.pause(); } catch {}
  _ttsAudio.currentTime = 0;
  _setTtsBtnState(group, 'idle');
  _resetAllTtsBtns();
}
```

(`_activeTtsBtn` now stores the GROUP, not the button. Update the
assignment in `_playBlobAsAudio`.)

### 5. `_refreshActiveButton` — read state from group's data-state

When `_ttsAudio.onended` or `_ttsAudio.onerror` fires, the wrapper
must reset. `_refreshActiveButton` and `_resetAllTtsBtns` already call
`_setTtsBtnState(...)` — keep them as-is, only the inner function
changes.

### 6. `_playBlobAsAudio` — store the group as `_activeTtsBtn`

Replace `_activeTtsBtn = btn;` with `_activeTtsBtn = group;` where
`group = btn.closest('.tts-action-group')`. Same change applies to
the cache-hit branch (~line 457).

### 7. `_resetAllTtsBtns` — selector

Currently selects `.tts-play-btn`. Switch to `.tts-action-group` and
call `_setTtsBtnState(group, 'idle')`.

### 8. Update doc comment at line 264

Refresh the JSDoc above the TTS state machine to reflect the
3-element group. Replace the ASCII states table with the new flow.

## Files to touch

- Modify: `frontend/public/js/pages/story.page.js`
  - Update doc comment.
  - Update `_setTtsBtnState` body.
  - Update `_refreshActiveButton` (single-line — reads from group).
  - Update `_resetAllTtsBtns` (selector change).
  - Update `_playBlobAsAudio` (assign group as `_activeTtsBtn`).
  - Update cache-hit branch in `_onTtsPlayBtnClick` likewise.
  - Rename `_onTtsPlayBtnClick` to `_onTtsPlayOrToggleClick`.
  - Add `_onTtsStopClick`.
  - Update document-level click delegate.
  - Update `createMessageBubble` template (replace single button with
    3-element wrapper).
- Modify: `frontend/public/css/tailwind.input.css`
  - Add `.tts-action-group` visibility rules.
  - Delete the now-unused `.tts-toolbar` block IF nothing else emits
    that class (verify by grep).

## Self-check tests

Add `tests/test-tts-button-lifecycle.mjs` covering visibility rules
on the wrapper's `data-state`. The visibility logic is pure CSS so the
test runs the DOM in pure-Node via a JSDOM stub OR — simpler — exports
a small JS function that mirrors the visibility mapping (which roles
are visible per state) and the test asserts the mapping.

Recommended shape (preferred for determinism + speed):

```javascript
// tts-button-lifecycle.js (or top of test file)
function visibleRolesForState(state) {
  return ({
    idle: ['play'],
    loading: ['loading'],
    playing: ['toggle', 'stop'],
    paused: ['toggle', 'stop'],
  })[state] || ['play'];
}
function iconsForState(state) {
  return ({
    idle: { play: 'volume_up' },
    loading: { loading: 'hourglass_top' },
    playing: { toggle: 'pause', stop: 'stop' },
    paused: { toggle: 'play_arrow', stop: 'stop' },
  })[state] || {};
}
```

Test cases (8):
1. idle → only `play` visible, icon `volume_up`.
2. loading → only `loading` visible, icon `hourglass_top`.
3. playing → `toggle` (icon `pause`) + `stop` (icon `stop`) visible.
4. paused → `toggle` (icon `play_arrow`) + `stop` (icon `stop`) visible.
5. stop click while playing → state becomes idle, audio paused,
   `currentTime = 0` (assert via Audio stub).
6. stop click while paused → same as case 5 (we still reset to idle).
7. toggle click while playing → state becomes paused, audio paused,
   `currentTime` unchanged.
8. toggle click while paused → state becomes playing, audio plays,
   `currentTime` unchanged.

Stub `Audio` via `globalThis` for cases 5–8 with a tiny in-test mock
holding a `paused`, `currentTime`, and `play()`, `pause()`.

Run: `node tests/test-tts-button-lifecycle.mjs`. Exit 0, print:
`OK — tts-button-lifecycle: 8/8 cases pass`.

## Verify

```
node tests/test-tts-button-lifecycle.mjs   # new
node tests/test-sw-boot-probe.mjs
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

## Constraints

- Vanilla JS, no new deps, exact-match edits.
- State machine unchanged. Only DOM wiring changes.
- One Audio element — never reset `currentTime` on pause, only on stop.
- Single stop per group. Stopping a non-active bubble's group just
  resets that button to idle without disturbing active playback.
- The click is delegated — do NOT add a per-element listener.

## Commit

Single commit: `feat(chat): 2-button TTS gate (toggle pause/resume + stop)`

## Report

Write to `.superpowers\\sdd\\task-D-report.md`. Include status, files
modified, test runs, concerns, commit hash.

Return only status + commit hash + one-line test summary + concerns.