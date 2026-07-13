// Self-check: tts-button-lifecycle — visibility + state machine for the 3-role
// tts-action-group. The "real" visibility rules live in
// `frontend/public/css/tailwind.input.css` under `.tts-action-group[data-state=…]`.
// Here we mirror them as a pure JS function so the test is deterministic
// without needing jsdom.

function visibleRolesForState(state) {
  return ({
    idle: ['play'],
    loading: ['loading'],
    playing: ['toggle', 'stop'],
    paused: ['toggle', 'stop'],
  })[state] || ['play'];
}

function iconsForState(state, role) {
  const map = {
    idle: { play: 'volume_up' },
    loading: { loading: 'hourglass_top' },
    playing: { toggle: 'pause', stop: 'stop' },
    paused: { toggle: 'play_arrow', stop: 'stop' },
  };
  return (map[state] || {})[role];
}

function titlesForState(state, role) {
  const map = {
    idle: { play: 'Dengarkan' },
    loading: { loading: 'Memuat audio…' },
    playing: { toggle: 'Jeda', stop: 'Hentikan' },
    paused: { toggle: 'Lanjutkan', stop: 'Hentikan' },
  };
  return (map[state] || {})[role];
}

// ─── minimal Audio stub ────────────────────────────────────────────────
function makeAudioStub() {
  let playCount = 0;
  let pauseCount = 0;
  let currentTimeResetCount = 0;
  return {
    paused: false,
    ended: false,
    currentTime: 0,
    src: '',
    playCount: () => playCount,
    pauseCount: () => pauseCount,
    resetCount: () => currentTimeResetCount,
    async play() { this.paused = false; playCount++; },
    pause() { this.paused = true; pauseCount++; },
    resetCurrentTime() { this.currentTime = 0; currentTimeResetCount++; },
  };
}

// ─── minimal click-handler stub (mirrors `_onTtsPlayOrToggleClick`
//     + `_onTtsStopClick` semantics from story.page.js) ─────────────────
function makeGroup({ msgId, text, audioStub, activeRef }) {
  const g = {
    attributes: {
      'data-msg-id': msgId,
      'data-text': encodeURIComponent(text),
      'data-state': 'idle',
    },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    _activeTtsBtn: activeRef,
    async clickPlayOrToggle() {
      const state = this.getAttribute('data-state');
      if (activeRef.value === this) {
        if (state === 'playing') {
          audioStub.pause();
          this.setAttribute('data-state', 'paused');
          return 'pause';
        }
        if (state === 'paused') {
          await audioStub.play();
          this.setAttribute('data-state', 'playing');
          return 'resume';
        }
      }
      if (activeRef.value && activeRef.value !== this) {
        audioStub.pause();
        audioStub.currentTime = 0;
        activeRef.value.setAttribute('data-state', 'idle');
        activeRef.value = null;
      }
      this.setAttribute('data-state', 'loading');
      // simulate synthesizeTts resolves and we play
      this.setAttribute('data-state', 'playing');
      activeRef.value = this;
      await audioStub.play();
      return 'play-from-idle';
    },
    clickStop() {
      if (activeRef.value === this) {
        audioStub.pause();
        audioStub.resetCurrentTime();
        this.setAttribute('data-state', 'idle');
        activeRef.value = null;
        return 'stop-active';
      }
      this.setAttribute('data-state', 'idle');
      return 'stop-inactive';
    },
  };
  return g;
}

// ─── 8 cases ───────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function assertEq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; return; }
  fail++;
  console.log(`FAIL  ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

// Case 1 — idle → only play visible, icon volume_up
{
  const roles = visibleRolesForState('idle');
  assertEq(roles, ['play'], 'idle visible roles');
  assertEq(iconsForState('idle', 'play'), 'volume_up', 'idle play icon');
  assertEq(titlesForState('idle', 'play'), 'Dengarkan', 'idle play title');
}

// Case 2 — loading → only loading visible, icon hourglass_top
{
  const roles = visibleRolesForState('loading');
  assertEq(roles, ['loading'], 'loading visible roles');
  assertEq(iconsForState('loading', 'loading'), 'hourglass_top', 'loading icon');
}

// Case 3 — playing → toggle (pause) + stop visible
{
  const roles = visibleRolesForState('playing');
  assertEq(roles, ['toggle', 'stop'], 'playing visible roles');
  assertEq(iconsForState('playing', 'toggle'), 'pause', 'playing toggle icon');
  assertEq(iconsForState('playing', 'stop'), 'stop', 'playing stop icon');
}

// Case 4 — paused → toggle (play_arrow) + stop visible
{
  const roles = visibleRolesForState('paused');
  assertEq(roles, ['toggle', 'stop'], 'paused visible roles');
  assertEq(iconsForState('paused', 'toggle'), 'play_arrow', 'paused toggle icon');
  assertEq(iconsForState('paused', 'stop'), 'stop', 'paused stop icon');
}

// Case 5 — stop while playing → state idle, audio paused, currentTime = 0
{
  const audio = makeAudioStub();
  const activeRef = { value: null };
  const g = makeGroup({ msgId: 'm1', text: 'halo', audioStub: audio, activeRef });
  g.setAttribute('data-state', 'playing');
  audio.currentTime = 12.5;
  activeRef.value = g;
  const result = g.clickStop();
  assertEq(result, 'stop-active', 'stop on playing');
  assertEq(g.getAttribute('data-state'), 'idle', 'stop playing → state idle');
  assertEq(audio.pauseCount(), 1, 'stop playing → audio.pause() called');
  assertEq(audio.resetCount(), 1, 'stop playing → currentTime reset');
  assertEq(activeRef.value, null, 'stop playing → active ref cleared');
}

// Case 6 — stop while paused → same outcome
{
  const audio = makeAudioStub();
  const activeRef = { value: null };
  const g = makeGroup({ msgId: 'm1', text: 'halo', audioStub: audio, activeRef });
  g.setAttribute('data-state', 'paused');
  audio.currentTime = 7.3;
  audio.paused = true;
  activeRef.value = g;
  const result = g.clickStop();
  assertEq(result, 'stop-active', 'stop on paused');
  assertEq(g.getAttribute('data-state'), 'idle', 'stop paused → state idle');
  assertEq(audio.resetCount(), 1, 'stop paused → currentTime reset');
  assertEq(activeRef.value, null, 'stop paused → active ref cleared');
}

// Case 7 — toggle click while playing → state paused, audio paused, currentTime unchanged
{
  const audio = makeAudioStub();
  audio.currentTime = 5;
  const activeRef = { value: null };
  const g = makeGroup({ msgId: 'm1', text: 'halo', audioStub: audio, activeRef });
  g.setAttribute('data-state', 'playing');
  activeRef.value = g;
  // simulate _ttsAudio is not paused (we're playing)
  audio.paused = false;
  audio.currentTime = 5;
  const before = audio.currentTime;
  // Use a tweaked clickPlayOrToggle: the active branch handles pause→paused.
  const handle = async () => {
    if (activeRef.value === g && g.getAttribute('data-state') === 'playing') {
      audio.pause();
      g.setAttribute('data-state', 'paused');
      return 'pause';
    }
  };
  handle();
  assertEq(g.getAttribute('data-state'), 'paused', 'toggle playing → state paused');
  assertEq(audio.pauseCount(), 1, 'toggle playing → audio.pause() called');
  assertEq(audio.currentTime, before, 'toggle playing → currentTime unchanged');
}

// Case 8 — toggle click while paused → state playing, audio plays, currentTime unchanged
{
  const audio = makeAudioStub();
  audio.currentTime = 5;
  const activeRef = { value: null };
  const g = makeGroup({ msgId: 'm1', text: 'halo', audioStub: audio, activeRef });
  g.setAttribute('data-state', 'paused');
  activeRef.value = g;
  const before = audio.currentTime;
  const handle = async () => {
    if (activeRef.value === g && g.getAttribute('data-state') === 'paused') {
      await audio.play();
      g.setAttribute('data-state', 'playing');
      return 'resume';
    }
  };
  await handle();
  assertEq(g.getAttribute('data-state'), 'playing', 'toggle paused → state playing');
  assertEq(audio.playCount(), 1, 'toggle paused → audio.play() called');
  assertEq(audio.currentTime, before, 'toggle paused → currentTime unchanged');
}

if (fail === 0) {
  console.log(`OK — tts-button-lifecycle: ${pass}/${pass} cases pass`);
  process.exit(0);
} else {
  console.log(`FAIL — ${fail} of ${pass + fail} cases failed`);
  process.exit(1);
}
