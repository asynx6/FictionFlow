import { buildApp } from '../backend/src/app.js';
import { setTimeout as wait } from 'node:timers/promises';

const app = buildApp();
const server = app.listen(0);
await wait(300);
const { port } = server.address();

const BASE = `http://127.0.0.1:${port}`;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text: text.slice(0, 400) };
}

const tests = {};
tests.health = await call('GET', '/api/health');
tests.listStories = await call('GET', '/api/stories');
tests.create = await call('POST', '/api/stories', {
  ai_name: 'Tika',
  ai_personality: 'Ceria, usil, sedikit tsundere',
  user_name: 'Raka',
  language_style: 'santai',
  target_ending: 'Bertemu kembali setelah 10 tahun di stasiun',
});
const storyId = tests.create.json?.data?.story_id;
tests.getStory = storyId ? await call('GET', `/api/stories/${storyId}`) : null;
tests.getPresets = storyId ? await call('GET', `/api/stories/${storyId}/voice-presets`) : null;
tests.getMessages = storyId ? await call('GET', `/api/stories/${storyId}/messages`) : null;
tests.updateStory = storyId
  ? await call('PUT', `/api/stories/${storyId}`, { target_ending: 'Updated ending' })
  : null;
tests.updatePreset = storyId
  ? await call('PUT', `/api/stories/${storyId}/voice-presets/NARASI`, { pitch: 0.9, rate: 1.0 })
  : null;
tests.staticIndex = await call('GET', '/');
tests.staticStory = await call('GET', '/story.html');
tests.models = await call('GET', '/api/models');
tests.notFound = await call('GET', '/api/nonexistent');
tests.badCreate = await call('POST', '/api/stories', { ai_name: 'x' });

let pass = 0, fail = 0;
for (const [name, r] of Object.entries(tests)) {
  if (!r) continue;
  const expected = {
    health: 200, listStories: 200, create: 201, getStory: 200,
    getPresets: 200, getMessages: 200, updateStory: 200, updatePreset: 200,
    staticIndex: 200, staticStory: 200, models: 200,
    notFound: 404, badCreate: 400,
  }[name];
  if (r.status === expected) { pass++; console.log(`PASS [${name}] ${r.status}`); }
  else { fail++; console.log(`FAIL [${name}] expected ${expected} got ${r.status}: ${r.text.slice(0, 150)}`); }
}
console.log(`\n=== ${pass} pass / ${fail} fail ===`);

server.close();
process.exit(fail > 0 ? 1 : 0);
