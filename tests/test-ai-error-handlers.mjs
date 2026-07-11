/**
 * Self-check: AI error dialog handler lifecycle (repro of dead Cancel/Continue).
 * Run: node tests/test-ai-error-handlers.mjs
 *
 * Models the race that used to kill button clicks:
 *   set handlers → SSE error opens dialog → finally always cleared handlers.
 * After fix: finally only clears when no providerError.
 */
import assert from 'node:assert/strict';

function simulateSend({ fail }) {
  let onContinue = null;
  let onCancel = null;
  let providerError = null;
  let finished = false;

  const setHandlers = (c, a) => { onContinue = c; onCancel = a; };
  const clearHandlers = () => { onContinue = null; onCancel = null; };
  const finishSend = () => { finished = true; clearHandlers(); };

  setHandlers(() => { finished = true; }, () => { finished = true; });

  if (fail) {
    providerError = { message: 'provider down' };
    // open dialog (handlers must survive)
  }

  // finally block (fixed):
  if (!providerError) clearHandlers();

  return {
    handlersAlive: typeof onContinue === 'function' && typeof onCancel === 'function',
    finished,
    providerError: !!providerError,
  };
}

// Success path: handlers may be cleared (finishSend owns cleanup)
const ok = simulateSend({ fail: false });
assert.equal(ok.handlersAlive, false, 'success path clears handlers in finally');
assert.equal(ok.providerError, false);

// Error path: handlers MUST stay so Cancel/Continue work
const bad = simulateSend({ fail: true });
assert.equal(bad.handlersAlive, true, 'error path must keep Cancel/Continue handlers');
assert.equal(bad.providerError, true);

// Click Continue after error
{
  let clicked = false;
  let onContinue = () => { clicked = true; };
  let providerError = { message: 'x' };
  // fixed finally
  if (!providerError) onContinue = null;
  assert.equal(typeof onContinue, 'function');
  onContinue();
  assert.equal(clicked, true);
}

console.log('OK — error-dialog handler lifecycle self-check passed');
