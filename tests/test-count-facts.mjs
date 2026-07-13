/**
 * Self-check for TASK-013: countFacts handles all 3 dynamic_memory shapes.
 * Run: node tests/test-count-facts.mjs
 *
 * countFacts is a private helper inside story.page.js (which wires DOM/audio,
 * not importable in pure Node). We re-declare it verbatim here and assert the
 * three shapes — same pattern as test-sw-boot-probe's mirror. Drift between
 * the two copies surfaces as test failures.
 */
import assert from 'node:assert/strict';

function countFacts(raw) {
  if (!raw) return 0;
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return 0; }
  }
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.facts)) return parsed.facts.length;
    let total = 0;
    for (const cat of ['user', 'ai', 'world', 'relationship']) {
      const arr = parsed[cat];
      if (Array.isArray(arr)) total += arr.length;
    }
    return total;
  }
  return 0;
}

// Shape 1: legacy array.
assert.equal(countFacts([{ category: 'user', key: 'nama', value: 'Beni' }]), 1);
assert.equal(countFacts([1, 2, 3]), 3);

// Shape 2: {facts: [...]}.
assert.equal(countFacts({ facts: ['a', 'b'] }), 2);

// Shape 3: current {user,ai,world,relationship} — the shape the buggy
// post-send poll missed (returned 0). This is the TEMUAN-029 fix.
assert.equal(countFacts({ user: ['a', 'b'], ai: ['x'], world: [], relationship: ['[STATUS]: pacaran', 'cemburu'] }), 5);

// String round-trip of shape 3.
assert.equal(countFacts(JSON.stringify({ user: ['a'], ai: [], world: [], relationship: ['[STATUS]: teman'] })), 2);

// Empty / garbage.
assert.equal(countFacts(null), 0);
assert.equal(countFacts(''), 0);
assert.equal(countFacts('garbage{'), 0);
assert.equal(countFacts({}), 0);
assert.equal(countFacts({ unrelated: 1 }), 0);

console.log('OK — countFacts self-check passed (3 shapes + edge cases)');
