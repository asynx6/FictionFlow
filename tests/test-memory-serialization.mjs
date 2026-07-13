/**
 * Self-check for TASK-005: per-story memory mutex + rollback snapshot validation.
 * Run: node tests/test-memory-serialization.mjs
 */

import assert from 'node:assert/strict';
import { __testing__ } from '../backend/src/services/memoryExtractor.service.js';
import { normalizeDynamicMemory } from '../backend/src/util/dynamicMemory.js';

const { withMemoryLock } = __testing__;

// ── 1. Per-story mutex serializes critical sections ──
// Two concurrent withMemoryLock calls on the SAME story must not overlap: the
// second's fn only starts after the first releases. Different stories run in
// parallel (not asserted here, but the lock map is keyed by storyId).
{
  const log = [];
  const makeTask = (id, holdMs) => () => new Promise((resolve) => {
    log.push(`start-${id}`);
    setTimeout(() => {
      log.push(`end-${id}`);
      resolve(id);
    }, holdMs);
  });

  // Fire both concurrently on the same story; expect serialized execution.
  const p1 = withMemoryLock('story-A', makeTask(1, 30));
  const p2 = withMemoryLock('story-A', makeTask(2, 10));
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1, 1);
  assert.equal(r2, 2);
  // start-2 must come AFTER end-1 (no overlap).
  const idxEnd1 = log.indexOf('end-1');
  const idxStart2 = log.indexOf('start-2');
  assert.ok(idxEnd1 >= 0 && idxStart2 >= 0, 'both tasks ran');
  assert.ok(idxStart2 > idxEnd1, `second task started only after first released: ${JSON.stringify(log)}`);
}

// ── 2. Mutex is per-story (different stories don't block each other) ──
{
  const log = [];
  const makeTask = (id, holdMs) => () => new Promise((resolve) => {
    log.push(`start-${id}`);
    setTimeout(() => { log.push(`end-${id}`); resolve(id); }, holdMs);
  });
  const p1 = withMemoryLock('story-X', makeTask(1, 30));
  const p2 = withMemoryLock('story-Y', makeTask(2, 30));
  await Promise.all([p1, p2]);
  // start-2 should appear before end-1 (parallel across stories).
  const idxStart2 = log.indexOf('start-2');
  const idxEnd1 = log.indexOf('end-1');
  assert.ok(idxStart2 < idxEnd1, `different stories run in parallel: ${JSON.stringify(log)}`);
}

// ── 3. Mutex releases on throw (no deadlock) ──
{
  await withMemoryLock('story-throw', async () => { throw new Error('boom'); }).catch(() => {});
  // If the lock leaked, this would hang forever.
  const r = await withMemoryLock('story-throw', async () => 'ok-after-throw');
  assert.equal(r, 'ok-after-throw');
}

// ── 4. Rollback snapshot validation logic (mirrors messages.routes) ──
// A client snapshot must JSON.parse + normalize to the 4-category shape; only
// the normalized form is persisted. Garbage is rejected.
function validateSnapshot(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'absent' };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: 'invalid-json' }; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not-object' };
  return { ok: true, normalized: JSON.stringify(normalizeDynamicMemory(parsed)) };
}

assert.equal(validateSnapshot('garbage{').ok, false);
assert.equal(validateSnapshot('garbage{').reason, 'invalid-json');
assert.equal(validateSnapshot('123').ok, false);
assert.equal(validateSnapshot('123').reason, 'not-object');
assert.equal(validateSnapshot('').ok, false);
assert.equal(validateSnapshot('').reason, 'absent');
{
  const v = validateSnapshot(JSON.stringify({ user: ['a'], ai: [], world: [], relationship: ['[STATUS]: pacaran'] }));
  assert.equal(v.ok, true);
  assert.deepEqual(JSON.parse(v.normalized), { user: ['a'], ai: [], world: [], relationship: ['[STATUS]: pacaran'] });
}
// Garbage-but-parseable object with wrong shape normalizes to empty 4-cat (not a wipe of unrelated data, but rejected as no-op restore).
{
  const v = validateSnapshot(JSON.stringify({ unrelated: 1 }));
  assert.equal(v.ok, true);
  assert.deepEqual(JSON.parse(v.normalized), { user: [], ai: [], world: [], relationship: [] });
}

console.log('OK — memory serialization self-check passed');
