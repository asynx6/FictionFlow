import { apiClient } from '../frontend/public/js/api/apiClient.js';

let fetchCalls = 0;
const urls = [];

globalThis.fetch = async (url) => {
  fetchCalls++;
  urls.push(url);
  const messages = [];
  let count = 0;
  if (url.includes('offset=12')) count = 24;
  else if (url.includes('offset=36')) count = 4;
  else count = 12;
  for (let i = 0; i < count; i++) {
    messages.push({ id: i + 1, role: 'assistant', content: `m${i}`, created_at: '2026-07-13' });
  }
  return new Response(JSON.stringify({ success: true, data: { messages } }), {
    headers: { 'content-type': 'application/json' },
  });
};

const out = [];
for await (const batch of apiClient.loadAllMessages('s1', { initialWindow: 12, pageSize: 24 })) {
  out.push({ len: batch.length, lastId: batch[batch.length - 1]?.id });
}

console.log('fetch urls:', urls);
console.log('yields:', out);
console.log('total fetch calls:', fetchCalls);

import assert from 'node:assert/strict';
assert.equal(out.length, 3, 'expected 3 yields');
assert.deepEqual([out[0].len, out[1].len, out[2].len], [12, 24, 4], 'bad lengths');
assert.equal(fetchCalls, 3, 'expected 3 fetches');
assert.equal(urls[0], '/api/stories/s1/messages?limit=12', 'first url wrong');
assert.equal(urls[1], '/api/stories/s1/messages?limit=24&offset=12', 'second url wrong');
assert.equal(urls[2], '/api/stories/s1/messages?limit=24&offset=36', 'third url wrong');

console.log('OK — full pagination terminates at short remainder');
