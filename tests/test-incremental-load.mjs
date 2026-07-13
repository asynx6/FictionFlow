import assert from 'node:assert/strict';
import { apiClient } from '../frontend/public/js/api/apiClient.js';
const { loadAllMessages } = apiClient;

// The mock model:
//   - Initial window URL: server returns the "newest" items. Drain until
//     shorter-than-window → we pivot to history pagination at offset =
//     initialWindow (we now treat the initial window as fully consumed).
//   - History page URL: server returns up to `pageSize` items. Drain until
//     shorter-than-pageSize → terminate.
//
// Test fixture:
//   - First call (?limit=12) returns a partial window of 2 items. Pagination
//     must pivot to history pagination.
//   - Second call (?limit=24&offset=12) returns a short remainder of 1 item.
//     Pagination must terminate cleanly without over-fetching.
const fakeSequences = {
  '/api/stories/abc/messages?limit=12': [
    [
      { id: 30, role: 'assistant', content: 'latest', created_at: '2026-07-13T03:00:00Z' },
      { id: 29, role: 'user',      content: 'agt',    created_at: '2026-07-13T02:59:00Z' },
    ],
  ],
  '/api/stories/abc/messages?limit=24&offset=12': [
    [
      { id: 28, role: 'user',      content: 'a',      created_at: '2026-07-13T01:00:00Z' },
    ],
  ],
};

let overFetched = false;
globalThis.fetch = async (url) => {
  const matched = fakeSequences[url];
  if (!matched) {
    overFetched = true;
    throw new Error('unexpected url ' + url);
  }
  const next = matched.shift();
  return new Response(JSON.stringify({ success: true, data: { messages: next } }), {
    headers: { 'content-type': 'application/json' },
  });
};

const out = [];
for await (const batch of loadAllMessages('abc', { initialWindow: 12, pageSize: 24 })) {
  out.push(batch.length);
}

assert.deepEqual(out, [2, 1], 'should yield initial window, then a short remainder');
assert.equal(overFetched, false, 'must not over-fetch into non-existent URLs');
console.log('OK — incremental-load paginates without over-fetching');
