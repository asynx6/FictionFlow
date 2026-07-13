import assert from 'node:assert/strict';
import { apiClient } from '../frontend/public/js/api/apiClient.js';
const { loadAllMessages } = apiClient;

// Regression: server returns [12, 24, 0, ...] — i.e. an empty page after
// one full history page. Pre-fix the iterator only terminated on a short
// remainder (batch.length < pageSize), so an empty batch in the middle
// of history paging produced an infinite loop.
// Mock fixture:
//   1. /messages?limit=12          → 12 (initial window, full)
//   2. /messages?limit=24&offset=12 → 24 (full history page)
//   3. /messages?limit=24&offset=36 → 0  (empty mid-history → must TERMINATE)
const calls = [];
let thirdCalled = false;
globalThis.fetch = async (url) => {
  calls.push(url);
  let count = 0;
  if (url.includes('offset=36')) {
    thirdCalled = true;
    count = 0;
  } else if (url.includes('offset=12')) {
    count = 24;
  } else {
    count = 12;
  }
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({ id: calls.length * 100 + i, role: 'assistant', content: `m${i}`, created_at: '2026-07-13' });
  }
  return new Response(JSON.stringify({ success: true, data: { messages } }), {
    headers: { 'content-type': 'application/json' },
  });
};

// 200ms ceiling — a regression that loops forever fails fast.
const RACE_MS = 200;
const racer = new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${RACE_MS}ms (likely infinite loop)`)), RACE_MS));

const out = await Promise.race([
  (async () => {
    const batches = [];
    for await (const batch of loadAllMessages('s1', { initialWindow: 12, pageSize: 24 })) {
      batches.push(batch.length);
    }
    return batches;
  })(),
  racer,
]);

assert.deepEqual(out, [12, 24, 0], 'expected 3 yields including empty mid-history');
assert.equal(thirdCalled, true, 'third fetch (empty page) must occur');
assert.equal(calls.length, 3, 'expected exactly 3 fetches; iterator must not loop forever');
assert.equal(calls[0], '/api/stories/s1/messages?limit=12');
assert.equal(calls[1], '/api/stories/s1/messages?limit=24&offset=12');
assert.equal(calls[2], '/api/stories/s1/messages?limit=24&offset=36');
console.log('OK — empty mid-history page terminates iterator (no infinite loop)');