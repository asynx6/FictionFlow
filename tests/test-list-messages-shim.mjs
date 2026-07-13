import assert from 'node:assert/strict';
import { apiClient } from '../frontend/public/js/api/apiClient.js';
const { listMessages } = apiClient;

globalThis.fetch = async (url) => {
  assert.equal(url, '/api/stories/x/messages?limit=50&offset=0');
  return new Response(JSON.stringify({ success: true, data: { messages: [{ id: 1 }] } }), {
    headers: { 'content-type': 'application/json' },
  });
};

const res = await listMessages('x');
assert.equal(res.success, true);
assert.deepEqual(res.data.messages, [{ id: 1 }]);

// Also exercise limit/offset override.
globalThis.fetch = async (url) => {
  assert.equal(url, '/api/stories/x/messages?limit=10&offset=20');
  return new Response(JSON.stringify({ success: true, data: { messages: [] } }), {
    headers: { 'content-type': 'application/json' },
  });
};
const res2 = await listMessages('x', { limit: 10, offset: 20 });
assert.deepEqual(res2.data.messages, []);
console.log('OK — listMessages shim still preserves original signature');
