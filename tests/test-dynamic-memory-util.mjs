/**
 * Self-check for the shared dynamicMemory util (TASK-001).
 * Run: node tests/test-dynamic-memory-util.mjs
 */

import assert from 'node:assert/strict';
import {
  TAGGED_KEYS,
  canonicalizeRelationshipFact,
  isTaggedFact,
  taggedKeyOf,
  normalizeDynamicMemory,
} from '../backend/src/util/dynamicMemory.js';

// canonicalizeRelationshipFact — tolerant detection, canonical rewrite.
assert.equal(canonicalizeRelationshipFact('USER_PANGGILAN: kaishi'), '[USER_PANGGILAN]: kaishi');
assert.equal(canonicalizeRelationshipFact('[user_panggilan] : kaishi'), '[USER_PANGGILAN]: kaishi');
assert.equal(canonicalizeRelationshipFact('[User_Panggilan]: kaishi'), '[USER_PANGGILAN]: kaishi');
assert.equal(canonicalizeRelationshipFact('[USER_PANGGILAN] - kaishi'), '[USER_PANGGILAN]: kaishi');
assert.equal(canonicalizeRelationshipFact('status: pacaran'), '[STATUS]: pacaran');
assert.equal(canonicalizeRelationshipFact('[STATUS]: pacaran'), '[STATUS]: pacaran');
assert.equal(canonicalizeRelationshipFact('[STATUS]:  pacaran '), '[STATUS]: pacaran');
// Narrative untouched.
assert.equal(canonicalizeRelationshipFact('AI cemburu'), 'AI cemburu');
assert.equal(canonicalizeRelationshipFact(''), '');
assert.equal(canonicalizeRelationshipFact('status-quo report'), 'status-quo report'); // key STATUS_QUO not known
// Non-string passthrough.
assert.equal(canonicalizeRelationshipFact(null), null);

// isTaggedFact
assert.equal(isTaggedFact('USER_PANGGILAN: x'), true);
assert.equal(isTaggedFact('[user_panggilan]: x'), true);
assert.equal(isTaggedFact('AI cemburu'), false);
assert.equal(isTaggedFact('unknown_key: x'), false);

// taggedKeyOf
assert.equal(taggedKeyOf('[STATUS]: pacaran'), 'STATUS');
assert.equal(taggedKeyOf('status: pacaran'), 'STATUS');
assert.equal(taggedKeyOf('AI cemburu'), null);
assert.equal(taggedKeyOf('UNKNOWN: x'), null);

// normalizeDynamicMemory — legacy canonical bracketed emit for known tagged keys.
{
  const legacy = [{ category: 'relationship', key: 'USER_PANGGILAN', value: 'kaishi' }];
  const out = normalizeDynamicMemory(legacy);
  assert.deepEqual(out.relationship, ['[USER_PANGGILAN]: kaishi']);
}
// legacy non-tagged relationship keeps human-readable KEY: value.
{
  const legacy = [{ category: 'relationship', key: 'nicknames', value: 'sahabat' }];
  const out = normalizeDynamicMemory(legacy);
  assert.deepEqual(out.relationship, ['nicknames: sahabat']);
}
// legacy non-relationship keeps KEY: value.
{
  const legacy = [{ category: 'user', key: 'nama', value: 'Beni' }];
  const out = normalizeDynamicMemory(legacy);
  assert.deepEqual(out.user, ['nama: Beni']);
}
// new-schema relationship canonicalized.
{
  const raw = { user: [], ai: [], world: [], relationship: ['USER_PANGGILAN: kaishi', '[status]: pacaran'] };
  const out = normalizeDynamicMemory(raw);
  assert.deepEqual(out.relationship, ['[USER_PANGGILAN]: kaishi', '[STATUS]: pacaran']);
}
// string input round-trips through JSON.parse.
{
  const raw = JSON.stringify({ user: ['a'], ai: [], world: [], relationship: ['[STATUS]: teman'] });
  const out = normalizeDynamicMemory(raw);
  assert.deepEqual(out, { user: ['a'], ai: [], world: [], relationship: ['[STATUS]: teman'] });
}
// empty/garbage safe.
assert.deepEqual(normalizeDynamicMemory(null), { user: [], ai: [], world: [], relationship: [] });
assert.deepEqual(normalizeDynamicMemory('garbage{'), { user: [], ai: [], world: [], relationship: [] });

// TAGGED_KEYS exact set.
assert.deepEqual(TAGGED_KEYS, ['STATUS', 'AI_PANGGILAN', 'USER_PANGGILAN', 'SEJAK', 'KONTEKS_PERILAKU']);

console.log('OK — dynamicMemory util self-check passed');
