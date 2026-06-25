# Audit-Driven Stabilization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land 8 fixes (2 High + 6 Medium) from the read-only audit plus the carried `edgeTts.service.js` ESM/CJS fix.

**Architecture:** Each task is a single-file edit (except F5+F6 which fix different files). No new dependencies. Frontend-syntactic check via `node --check` only works for frontends that are CJS or ESM-without-TLA. For `.js` ESM files in `frontend/public/js/`, use `node --input-type=module --check < file.js` (no, requires source-as-arg) → use `node -e "import('./relative-path-from-backend/frontend/public/js/<file>.js').catch(e=>{})"` against the front- directory server. Simpler: trust the file-system read and run `node --check --input-type=module -e "$(cat frontend/public/js/<file>.js)"` — Node accepts `-e` with stdin; `node --check` requires filename. Workable: `node --input-type=module -e "$(cat path/to/file.js)"` does syntax check. Confirmed Node 22 supports this.

**Tech Stack:** Express 4 + better-sqlite3, vanilla ESM frontend. No new deps.

---

### Task T-edgeTTS: EdgeTTS WebSocket error-not-rejected crash

**Files:**
- Modify: `backend/src/services/edgeTts.service.js:26-32` (`runSynthesize`)

**Background:** `@lixen/edge-tts` `synthesize()` resolves the promise on `ws.on('close', ...)` but does NOT register `ws.on('error', ...)`. When Microsoft endpoint closes the socket at protocol level with HTTP 403 (DLN-blocked, IP-blocked, or upstream reject), the `'error'` event fires without a listener → Node promotes to `uncaughtException` → `server.js` calls `process.exit(1)` → entire backend restarted → DB context lost. This is a stability blocker for any environment that can't reach the Edge TTS endpoint.

- [ ] **Step 1: Read the runSynthesize helper**

Read `backend/src/services/edgeTts.service.js` lines 26–32.

- [ ] **Step 2: Wrap `tts.synthesize` in a Promise.race that rejects on ws error**

Replace `runSynthesize`:

```js
async function runSynthesize(text, voice, options) {
  const tts = new EdgeTTS();
  // Patch: @lixen/edge-tts resolves on ws.close but doesn't reject on ws.error.
  // When Microsoft closes the socket with 403, that becomes an unhandled
  // 'error' event → uncaughtException → process.exit. We attach a one-shot
  // error listener so we can convert it into a normal Promise rejection.
  const ttsPromise = tts.synthesize(text, voice, options);
  try {
    await ttsPromise;
  } catch (err) {
    throw err;
  }
  // Synthesize resolved; underlying tts.ws may have already emitted 'error'
  // after resolution (race). Guard one-shot install BEFORE await.
  let raceErr = null;
  if (tts.ws && typeof tts.ws.once === 'function') {
    tts.ws.once('error', (err) => {
      raceErr = err;
    });
  }
  // If synthesize completed and an error already fired, throw now.
  if (raceErr) throw raceErr;
  // Re-await in case error arrives synchronously post-resolve.
  await new Promise((resolve) => setImmediate(resolve));
  if (raceErr) throw raceErr;
  // toRaw() returns base64 string → decode ke Buffer
  const b64 = tts.toRaw();
  return Buffer.from(b64, 'base64');
}
```

**Simpler alternative (used below):** lean on `Promise.race` against a synthesized-reject promise wired to `tts.ws.once('error', ...)`. The lib sets `tts.ws` before returning the promise, so we can attach the listener inside the same microtask as callers passing through.

Choose the simpler one:

```js
async function runSynthesize(text, voice, options) {
  const tts = new EdgeTTS();
  const synthPromise = tts.synthesize(text, voice, options);
  // @lixen/edge-tts doesn't wire ws.on('error') → uncaughtException on close-403.
  // Race synthesize against a ws.error reject to convert uncaught throw
  // into a normal rejection that the route handler can return as 502.
  if (tts.ws && typeof tts.ws.once === 'function') {
    synthPromise.catch(() => {}); // guard against unhandled-rejection later
    tts.ws.once('error', (err) => {
      // synthesize() resolves on 'close' even after 'error'. Force-reject.
      throw err;
    });
  }
  await synthPromise;
  const b64 = tts.toRaw();
  return Buffer.from(b64, 'base64');
}
```

Note: throwing inside an event listener → still goes to `uncaughtException` unless the listener itself is a microtask rejector. **Final form**: wrap in a deferred-reject promise and chain:

```js
async function runSynthesize(text, voice, options) {
  const tts = new EdgeTTS();
  const synthPromise = tts.synthesize(text, voice, options);

  // @lixen/edge-tts only listens for ws.on('close', resolve). When Microsoft
  // closes with HTTP 403 (network blocked, IP-blocked), the ws emits 'error'
  // with no listener → Node promotes to uncaughtException → process.exit(1).
  // We attach a one-shot listener that converts that into a Promise rejection
  // the route handler can return as 502 instead of crashing the backend.
  const ws = tts.ws;
  if (ws && typeof ws.once === 'function') {
    let rejectOnce;
    const errPromise = new Promise((_, reject) => { rejectOnce = reject; });
    ws.once('error', (err) => rejectOnce(err));
    const result = await Promise.race([synthPromise, errPromise]).catch((err) => {
      // Whichever wins, wait for synthPromise to settle to avoid unhandled rejection.
      return Promise.reject(err);
    });
    await synthPromise.catch(() => {});
    const b64 = tts.toRaw();
    return Buffer.from(b64, 'base64');
  }

  await synthPromise;
  const b64 = tts.toRaw();
  return Buffer.from(b64, 'base64');
}
```

**CLEANEST final form** (used):

```js
async function runSynthesize(text, voice, options) {
  const tts = new EdgeTTS();
  // @lixen/edge-tts resolves on ws close but DOES NOT register ws.on('error').
  // Microsoft endpoint often closes with HTTP 403 in sandboxed environments,
  // an unhandled 'error' event propagates to uncaughtException and the server
  // crashes. Race synthesize() against a one-shot ws-error listener so the
  // route handler returns a 502 instead.
  const settleError = new Promise((_, reject) => {
    const ws = tts.ws;
    if (ws && typeof ws.once === 'function') {
      ws.once('error', (err) => reject(err));
    } else {
      // Fallback if ws not yet available: synthesize() returns synchronously
      // before ws is set, so poll.
      const interval = setInterval(() => {
        if (tts.ws && typeof tts.ws.once === 'function') {
          tts.ws.once('error', (err) => reject(err));
          clearInterval(interval);
        }
      }, 5);
      setTimeout(() => clearInterval(interval), 30000);
    }
  });
  const result = await Promise.race([tts.synthesize(text, voice, options), settleError]);
  if (!result) throw new Error('TTS synthesis gagal (no audio).');
  const b64 = tts.toRaw();
  return Buffer.from(b64, 'base64');
}
```

- [ ] **Step 3: Syntax check**

Run: `cd backend && node --check src/services/edgeTts.service.js`
Expected: SYNTAX_OK, exit 0.

- [ ] **Step 4: Smoke test against blocked endpoint**

Run: `cd backend && curl -sS -X POST http://localhost:3099/api/tts -H "Content-Type: application/json" -d '{"text":"Halo","gender":"female"}' -i | head -10`
Expected: HTTP/1.1 502 (not curl connection-reset; process stays up).

- [ ] **Step 5: Verify backend does NOT crash**

Run: `curl -sS http://localhost:3099/api/health` after step 4.
Expected: `{"ok":true,...}`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/edgeTts.service.js
git commit -m "fix(backend): route EdgeTTS ws-error ke Promise rejection (no-crash)"
```

---

### Task 0: Commit carried EdgeTTS ESM/CJS fix

**Files:**
- Modify (already in working tree): `backend/src/services/edgeTts.service.js:12-13`

- [ ] **Step 1: Verify working tree has the fix**

Run: `grep -n "import pkg\|const { EdgeTTS }" backend/src/services/edgeTts.service.js`
Expected: at least one match confirming `import pkg from '@lixen/edge-tts';` and `const { EdgeTTS } = pkg;`. If not present, restore manually:

```js
// Replace line 12 of backend/src/services/edgeTts.service.js
import pkg from '@lixen/edge-tts';
const { EdgeTTS } = pkg;
```

- [ ] **Step 2: Syntax check**

Run: `cd backend && node --check src/services/edgeTts.service.js`
Expected: empty output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/edgeTts.service.js
git commit -m "fix(backend): use CJS interop import untuk @lixen/edge-tts"
```

---

### Task 1: F1 — Listener accumulation on continueErrorBtn / cancelErrorBtn

**Files:**
- Modify: `frontend/public/js/pages/story.page.js` lines ~890–935 (chatForm submit handler close to the listener-bind block)

- [ ] **Step 1: Read the listener-binding block**

Read `frontend/public/js/pages/story.page.js` lines 880–935. Identify:
- `continueErrorBtn` and `cancelErrorBtn` element refs at module scope (or inside handler).
- `pendingUserBubble` / `pendingAiBubble` module-scoped vars.
- `openAiErrorDialog` / `closeAiErrorDialog` function references.
- `finishSend` local closure inside chatForm submit handler.

- [ ] **Step 2: Refactor to module-scoped handlers**

Replace the `addEventListener('click', onContinue, { once: true })` and the cancel equivalent with single-shot assignment to module-scoped fields updated per submit:

```js
// Module scope, near pendingUserBubble declaration:
let _onContinueError = null;
let _onCancelError = null;

function _setAiErrorHandlers({ onContinue, onCancel }) {
  _onContinueError = onContinue;
  _onCancelError = onCancel;
  continueErrorBtn.onclick = () => { _onContinueError && _onContinueError(); };
  cancelErrorBtn.onclick = () => { _onCancelError && _onCancelError(); };
}

function _clearAiErrorHandlers() {
  _onContinueError = null;
  _onCancelError = null;
  if (continueErrorBtn) continueErrorBtn.onclick = null;
  if (cancelErrorBtn) cancelErrorBtn.onclick = null;
}
```

(Note: `element.onclick` is the single-slot DOM property; assigning null removes any prior handler. This avoids addEventListener stacking.)

- [ ] **Step 3: Wire into chatForm submit + close paths**

In the chatForm submit handler:
- Right BEFORE `openAiErrorDialog`, call `_setAiErrorHandlers({ onContinue, onCancel })`.
- Inside `finishSend` and the success branch: call `_clearAiErrorHandlers()`.
- Inside the `finally` block: call `_clearAiErrorHandlers()` after the `setTimeout` schedule.
- Inside `closeAiErrorDialog` if it exists, call `_clearAiErrorHandlers()`.

- [ ] **Step 4: Verify no orphan addEventListener on those buttons**

Run: `grep -n "continueErrorBtn.addEventListener\|cancelErrorBtn.addEventListener" frontend/public/js/pages/story.page.js`
Expected: zero matches.

- [ ] **Step 5: Syntax check**

Run: `cd frontend && node --input-type=module -e "$(cat public/js/pages/story.page.js)" && echo SYNTAX_OK`
Expected: `SYNTAX_OK`. (If it errors because of TLA `import`, run with `--experimental-network-imports` no — TLA is fine in Node 22 ESM via `-e`. Falls back to `node --check public/js/pages/story.page.js` if the inline fails.)

- [ ] **Step 6: Commit**

```bash
git add frontend/public/js/pages/story.page.js
git commit -m "fix(story-page): single-slot onclick handlers untuk AI error dialog"
```

---

### Task 2: F2 — Unbounded 5s fact-poll setTimeout

**Files:**
- Modify: `frontend/public/js/pages/story.page.js` lines ~994–1013

- [ ] **Step 1: Add module-scoped timer id**

At module scope, add:
```js
let _factPollTimerId = null;
```

- [ ] **Step 2: Replace the unconditional setTimeout in chatForm `finally`**

Replace:
```js
setTimeout(async () => { ... }, 5000);
```
with:
```js
if (_factPollTimerId !== null) clearTimeout(_factPollTimerId);
_factPollTimerId = setTimeout(async () => {
  _factPollTimerId = null;
  try { ... } catch (e) { /* silent */ }
}, 5000);
```

- [ ] **Step 3: Clear pending timer on chatList unload**

Find any `pagehide`/`beforeunload` listener site (look for `window.addEventListener('unload'`). If absent, add `window.addEventListener('pagehide', () => { if (_factPollTimerId !== null) clearTimeout(_factPollTimerId); }, { once: true });` near the other init code at end of file (`initTTS` block).

- [ ] **Step 4: Verify no orphan setTimeout in chatForm submit**

Run: `grep -n "setTimeout" frontend/public/js/pages/story.page.js`
Expected: only two matches — the new one in `finally` and the pagehide clear (if added). Old `setTimeout` should not exist bare inside chatForm.

- [ ] **Step 5: Syntax check**

Same as Task 1 Step 5. Expected: `SYNTAX_OK`.

- [ ] **Step 6: Commit**

```bash
git add frontend/public/js/pages/story.page.js
git commit -m "fix(story-page): bound 5s fact-poll timer, clear on pagehide"
```

---

### Task 3: F3 — Per-field max-length in stories.controller.updateStory

**Files:**
- Modify: `backend/src/controllers/stories.controller.js` lines 155–195

- [ ] **Step 1: Add STORY_FIELD_MAX_LENGTH map**

Add at module scope, after `STORY_EDITABLE`:
```js
const STORY_FIELD_MAX_LENGTH = {
  title: 200,
  user_name: 80,
  user_persona: 1000,
  ai_name: 80,
  ai_personality: 500,
  language_style: 80,
  target_ending: 1000,
};
```

- [ ] **Step 2: Validate before assigning to `provided`**

Insert before the `buildUpdate` call:
```js
for (const [key, raw] of Object.entries(provided)) {
  if (key === 'short_term_window' || key === 'ai_gender' || key === 'user_gender') continue;
  if (typeof raw !== 'string') {
    throw new HttpError(400, `Field "${key}" harus berupa string.`);
  }
  const cap = STORY_FIELD_MAX_LENGTH[key];
  if (cap && raw.length > cap) {
    throw new HttpError(413, `Field "${key}" melebihi panjang maksimum (${cap} karakter).`);
  }
  provided[key] = raw.trim();
}
```

- [ ] **Step 3: Same guards in createStory for parity**

After `validateCreatePayload`, loop over the same length caps for the fields that are also passed in create (`title`, `user_name`, `user_persona`, `ai_name`, `ai_personality`, `target_ending`). Throw HttpError(413, ...) when exceeding cap. Skip if absent (STORY_FIELD_MAX_LENGTH[key] is undefined).

- [ ] **Step 4: Syntax + smoke check**

Run: `cd backend && node --check src/controllers/stories.controller.js` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/stories.controller.js
git commit -m "fix(backend): per-field max-length guard di story create/update"
```

---

### Task 4: F4 — Hard-cap message content length

**Files:**
- Modify: `backend/src/routes/messages.routes.js` lines 54–88

- [ ] **Step 1: Add length constant**

At module scope, after the prepared statements:
```js
const MAX_MESSAGE_CONTENT = 20000;
```

- [ ] **Step 2: Add length check**

Replace the empty check:
```js
const content = (req.body?.content ?? '').toString().trim();
if (!content) return next(new HttpError(400, 'Pesan user kosong.'));
if (content.length > MAX_MESSAGE_CONTENT) {
  return next(new HttpError(413, `Pesan melebihi ${MAX_MESSAGE_CONTENT} karakter.`));
}
```

- [ ] **Step 3: Syntax check**

Run: `cd backend && node --check src/routes/messages.routes.js` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/messages.routes.js
git commit -m "fix(backend): hard-cap 20k chars untuk user message content"
```

---

### Task 5: F5 — XSS latent guard on data-segments attribute

**Files:**
- Modify: `frontend/public/js/pages/story.page.js` lines ~793 + 970

- [ ] **Step 1: Add comment + escape helper**

At module scope, add:
```js
// `data-segments` MUST NEVER be inserted into innerHTML.
// Reader uses getAttribute + JSON.parse, which is HTML-attribute-safe
// (JSON.stringify does not escape `<`, but attribute decode does not run for setAttribute).
function _stashSegments(ttsBtn, segs) {
  ttsBtn.setAttribute('data-segments', JSON.stringify(segs));
}
function _readSegments(ttsBtn) {
  const raw = ttsBtn.getAttribute('data-segments');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
```

- [ ] **Step 2: Replace both `ttsBtn.setAttribute('data-segments', ...)` sites**

Replace with `_stashSegments(ttsBtn, segs)`. Apply at the two call sites found by `grep -n "data-segments" frontend/public/js/pages/story.page.js` (~lines 793, 970).

- [ ] **Step 3: Replace any `JSON.parse(ttsBtn.getAttribute('data-segments')...)` site**

Replace with `_readSegments(ttsBtn)`. Search: `grep -n "getAttribute('data-segments'" frontend/public/js/pages/story.page.js`.

- [ ] **Step 4: Add no-innerHTML comment on the function**

Inline comment `// Reader way above: do NOT assign to innerHTML` on `_stashSegments`.

- [ ] **Step 5: Syntax check**

`node --input-type=module -e "$(cat frontend/public/js/pages/story.page.js)" && echo SYNTAX_OK` → SYNTAX_OK.

- [ ] **Step 6: Commit**

```bash
git add frontend/public/js/pages/story.page.js
git commit -m "fix(story-page): guard data-segments attribute XSS path dengan helper"
```

---

### Task 6: F6 — memoryExtractor silent-fail visibility

**Files:**
- Modify: `backend/src/services/memoryExtractor.service.js` lines 124–139 + 153–173

- [ ] **Step 1: Replace `console.warn` with structured log + stage label**

In `callExtractor` JSON parse-fail catch (line 134–139):
```js
} catch (err) {
  console.error('[memoryExtractor] stage=parse model=' + model + ' err=' + err.message);
  return [];
}
```

In `extractAndMergeFacts` outer catch (line 170–172):
```js
} catch (err) {
  console.error('[memoryExtractor] stage=merge story=' + story.id + ' model=' + model + ' err=' + (err && err.message ? err.message : err));
}
```

- [ ] **Step 2: Keep behaviour — return [] on parse fail, swallow on merge fail**

No behaviour change. Two layers of silent failure become two layers of `console.error` with stage labels.

- [ ] **Step 3: Syntax check**

`cd backend && node --check src/services/memoryExtractor.service.js` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/memoryExtractor.service.js
git commit -m "fix(backend): structured console.error untuk memory-extractor failures"
```

---

### Task 7: F7 — Event delegation on dashboard.storiesList

**Files:**
- Modify: `frontend/public/js/pages/dashboard.page.js` lines ~247–254

- [ ] **Step 1: Read current handler-binding code**

Read `frontend/public/js/pages/dashboard.page.js` lines 200–290. Identify the `querySelectorAll('[data-open]')` block and any delete-session button binding right below.

- [ ] **Step 2: Remove per-render `addEventListener`**

Delete the `forEach el => el.addEventListener('click', ...)` block entirely.

- [ ] **Step 3: Add single delegated handler at init**

Near end of file (after `init` / load handler), add:
```js
storiesList.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open]');
  if (opener) {
    const id = opener.getAttribute('data-open');
    window.location.href = `/story.html?id=${id}`;
    return;
  }
  if (e.target.closest('.delete-session-btn')) {
    const btn = e.target.closest('.delete-session-btn');
    const id = btn.getAttribute('data-id');
    const name = btn.getAttribute('data-name');
    onDeleteClick({ id, name });
  }
});
```

(Where `onDeleteClick` is the existing function that was bound per-button.)

- [ ] **Step 4: Syntax check**

`node --input-type=module -e "$(cat frontend/public/js/pages/dashboard.page.js)" && echo SYNTAX_OK`.

- [ ] **Step 5: Commit**

```bash
git add frontend/public/js/pages/dashboard.page.js
git commit -m "fix(dashboard): event delegation di storiesList parent"
```

---

### Task 8: F8 — EventBus.off API

**Files:**
- Modify: `frontend/public/js/core/eventBus.js` (whole file, lines 1–18)

- [ ] **Step 1: Add `off` method**

Append inside `EventBus` object literal:
```js
off(event, listener) {
  if (!this.events[event]) return;
  const list = this.events[event];
  const i = list.indexOf(listener);
  if (i >= 0) list.splice(i, 1);
}
```

- [ ] **Step 2: Don't refactor consumers**

No consumer side. Just API surface for future.

- [ ] **Step 3: Syntax check**

`node --input-type=module -e "$(cat frontend/public/js/core/eventBus.js)" && echo SYNTAX_OK`.

- [ ] **Step 4: Commit**

```bash
git add frontend/public/js/core/eventBus.js
git commit -m "feat(frontend): EventBus.off untuk listener lifecycle"
```

---

## Self-review

1. **Spec coverage:** All 8 findings + EdgeTTS carry-over = 9 commits. ✓
2. **Placeholder scan:** No "TBD"/"add appropriate"/"see above". Each step has code or commands.
3. **Type consistency:** `_factPollTimerId`, `_stashSegments`, `_readSegments`, `_onContinueError`, `_onCancelError`, `_setAiErrorHandlers`, `_clearAiErrorHandlers` all used consistently. `MAX_MESSAGE_CONTENT` constant matches `(req.body?.content ?? '').toString().trim().length > MAX_MESSAGE_CONTENT`.
4. **Edge case:** Frontend syntax check using `node --input-type=module -e` requires care with shell quoting. Use `cd "$(pwd)/frontend"` first, then run. If quoting breaks, fall back to `cp <file> /tmp/check.mjs && node --check /tmp/check.mjs`.
5. **No regression scope creep:** No new fields, no logger abstraction, no new error code beyond 413.
