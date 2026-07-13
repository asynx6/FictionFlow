/**
 * Self-check for TASK-012: caller-abort short-circuits the model chain.
 * When the caller's AbortSignal is already aborted (user Stop / disconnect),
 * streamChatCompletion must throw an AbortError (name === 'AbortError') so
 * shouldTryNextModel stops the chain — NOT a generic 'Provider error' that
 * retries the next slot (TEMUAN-008).
 * Run: node tests/test-abort-shortcircuit.mjs
 */

import assert from 'node:assert/strict';
import { env } from '../backend/src/config/env.js';

// Save + restore global fetch and the chain.
const origFetch = globalThis.fetch;
const origChain = env.MODEL_CHAIN.slice();

let fetchCallCount = 0;
// Simulate the real behavior: when the (already-aborted) caller signal is
// forwarded, fetch throws an AbortError.
globalThis.fetch = async () => {
  fetchCallCount += 1;
  const err = new Error('The user aborted a request');
  err.name = 'AbortError';
  throw err;
};

// Force a 2-slot chain so we can detect an erroneous advance to slot 2.
env.MODEL_CHAIN.length = 0;
env.MODEL_CHAIN.push({ slot: 0, key: 'K0', value: 'model-0' });
env.MODEL_CHAIN.push({ slot: 1, key: 'K1', value: 'model-1' });

const { streamChatCompletion } = await import('../backend/src/services/modelProvider.service.js');

try {
  const ctl = new AbortController();
  ctl.abort(); // caller already cancelled (Stop / disconnect)
  let thrown = null;
  try {
    // Drain the generator so the throw actually surfaces.
    for await (const _chunk of streamChatCompletion({ messages: [], signal: ctl.signal })) {
      // no tokens expected
    }
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'streamChatCompletion should throw on caller abort');
  assert.equal(thrown.name, 'AbortError', `expected AbortError, got ${thrown.name}: ${thrown.message}`);
  // Only the FIRST slot should have been attempted — no chain advance on abort.
  assert.equal(fetchCallCount, 1, `chain must not advance on caller abort; fetch calls=${fetchCallCount}`);
} finally {
  globalThis.fetch = origFetch;
  env.MODEL_CHAIN.length = 0;
  for (const e of origChain) env.MODEL_CHAIN.push(e);
}

console.log('OK — abort-shortcircuit self-check passed (AbortError, no chain advance)');
