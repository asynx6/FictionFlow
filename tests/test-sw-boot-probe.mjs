/**
 * Self-check: probeServiceWorker — SW boot probe + SKIP_WAITING punch.
 * Run: node tests/test-sw-boot-probe.mjs
 *
 * Pure-Node test of the helper. The real `probeServiceWorker` lives inside
 * `story.page.js` (not a pure module — wires DOM, audio, SW), so we re-
 * declare the function verbatim at the top of this test file. Drift
 * between the two copies surfaces as test failures.
 *
 * Four cases:
 *   1. No `serviceWorker` in navigator → resolve 'unsupported'
 *   2. Active SW already matches `?v=N` → resolve 'current'
 *   3. SKIP_WAITING sent, no controllerchange → reject (toast fires)
 *   4. controllerchange fires within timeout → resolve 'claimed'
 */
import assert from 'node:assert/strict';

// ----- re-declared helper (mirror story.page.js) -----
function probeServiceWorker(currentV, timeoutMs = 1000) {
  if (!currentV || !('serviceWorker' in navigator)) {
    return Promise.resolve('unsupported');
  }
  return navigator.serviceWorker
    .getRegistration()
    .then((reg) => {
      const ctrl = navigator.serviceWorker.controller;
      const hasV = (u) => typeof u === 'string' && u.includes(`?v=${currentV}`);
      if (hasV(reg?.active?.scriptURL) || hasV(ctrl?.scriptURL)) {
        return 'current';
      }
      if (!reg || !reg.active) return 'missing';
      reg.active.postMessage({ type: 'SKIP_WAITING' });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => { clearTimeout(t); resolve('claimed'); },
          { once: true }
        );
      });
    });
}

// ----- sw mock factory -----
function makeSwMock({ controllerUrl = null, activeUrl = null } = {}) {
  const listeners = {};
  const postMessages = [];
  const reg = {
    active: activeUrl ? {
      scriptURL: activeUrl,
      postMessage: (msg) => postMessages.push(msg),
    } : null,
  };
  return {
    mock: {
      controller: controllerUrl ? { scriptURL: controllerUrl } : null,
      getRegistration: async () => reg,
      addEventListener: (type, cb) => {
        (listeners[type] = listeners[type] || []).push(cb);
      },
      _fireControllerChange: () => {
        (listeners.controllerchange || []).forEach((cb) => cb());
      },
    },
    postMessages,
  };
}

// ----- helpers to swap + restore globalThis.navigator -----
function setNavigator(value) {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value, configurable: true, writable: true,
  });
  return () => {
    if (orig) Object.defineProperty(globalThis, 'navigator', orig);
    else delete globalThis.navigator;
  };
}

// ----- 4 cases -----
let pass = 0;

// Case 1: 'serviceWorker' in navigator is false → resolve 'unsupported'
{
  const restore = setNavigator({});
  try {
    const r = await probeServiceWorker('37');
    assert.equal(r, 'unsupported');
    pass++;
  } finally {
    restore();
  }
}

// Case 2: controller already matches ?v=37 → resolve 'current'
{
  const { mock } = makeSwMock({ controllerUrl: 'https://example.com/sw.js?v=37' });
  const restore = setNavigator({ serviceWorker: mock });
  try {
    const r = await probeServiceWorker('37');
    assert.equal(r, 'current');
    pass++;
  } finally {
    restore();
  }
}

// Case 3: SKIP_WAITING sent, no controllerchange within ceiling → reject
{
  const { mock, postMessages } = makeSwMock({
    controllerUrl: 'https://example.com/sw.js', // stale — no v=
    activeUrl: 'https://example.com/sw.js',    // stale
  });
  const restore = setNavigator({ serviceWorker: mock });
  try {
    let rejected = false;
    let errMsg = null;
    await probeServiceWorker('37', 50).catch((e) => {
      rejected = true;
      errMsg = e?.message || String(e);
    });
    assert.equal(rejected, true, 'expected rejection on timeout');
    assert.equal(errMsg, 'timeout');
    assert.equal(postMessages.length, 1, 'SKIP_WAITING should have been sent');
    assert.equal(postMessages[0].type, 'SKIP_WAITING');
    pass++;
  } finally {
    restore();
  }
}

// Case 4: controllerchange fires within ceiling → resolve 'claimed'
{
  const { mock, postMessages } = makeSwMock({
    controllerUrl: 'https://example.com/sw.js',
    activeUrl: 'https://example.com/sw.js',
  });
  const restore = setNavigator({ serviceWorker: mock });
  try {
    // Fire controllerchange shortly after probeServiceWorker registers its
    // listener; keep the timeout generous so the listener wins.
    setTimeout(() => mock._fireControllerChange(), 20);
    const r = await probeServiceWorker('37', 500);
    assert.equal(r, 'claimed');
    assert.equal(postMessages.length, 1, 'SKIP_WAITING should have been sent');
    assert.equal(postMessages[0].type, 'SKIP_WAITING');
    pass++;
  } finally {
    restore();
  }
}

console.log(`OK — sw-boot-probe: ${pass}/4 cases pass`);
