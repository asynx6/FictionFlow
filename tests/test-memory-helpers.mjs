/**
 * Self-check for TASK-014 memory helpers: memoryEqual, parseMemoryJson,
 * headTail, normalizeForMatch.
 * Run: node tests/test-memory-helpers.mjs
 */
import assert from 'node:assert/strict';
import { __testing__ } from '../backend/src/services/memoryExtractor.service.js';

const { memoryEqual, parseMemoryJson, headTail, normalizeForMatch } = __testing__;
const E = { user: [], ai: [], world: [], relationship: [] };

// memoryEqual: order-insensitive, case-insensitive, per-category set equality.
assert.equal(memoryEqual({ ...E, user: ['a', 'b'] }, { ...E, user: ['b', 'a'] }), true, 'order-insensitive');
assert.equal(memoryEqual({ ...E, user: ['a'] }, { ...E, user: ['a', 'b'] }), false, 'length diff');
assert.equal(memoryEqual({ ...E, user: ['A'] }, { ...E, user: ['a'] }), true, 'case-insensitive');
assert.equal(memoryEqual({ ...E, relationship: ['[STATUS]: x'] }, { ...E, relationship: ['[STATUS]: y'] }), false, 'value diff');

// parseMemoryJson: direct + balanced-brace fallback (TEMUAN-043).
assert.deepEqual(parseMemoryJson('{"user":["a"],"ai":[],"world":[],"relationship":[]}'), { user: ['a'], ai: [], world: [], relationship: [] });
assert.deepEqual(parseMemoryJson('```json\n{"user":["a"]}\n```'), { user: ['a'] });
// Prose-prefixed JSON salvaged via balanced-brace extraction.
assert.deepEqual(parseMemoryJson('Berikut memori: {"user":["a"]} sekian.'), { user: ['a'] });
assert.equal(parseMemoryJson('no json here'), null);
assert.equal(parseMemoryJson('garbage{'), null);

// headTail: fits budget verbatim; over budget keeps head + tail with marker.
assert.equal(headTail('short', 2000), 'short');
const long = '0123456789'.repeat(300); // 3000 chars
const ht = headTail(long, 2000);
assert.ok(ht.length <= 2000, 'headTail respects budget');
assert.ok(ht.includes('[...]'), 'headTail inserts marker');
assert.ok(ht.startsWith('0123456789'), 'head preserved');
assert.ok(ht.endsWith('0123456789'), 'tail preserved');
// Tail captures the end of a long AI reply where status changes often live.
assert.ok(headTail('X'.repeat(3000) + 'STATUS_PACARAN', 2000).includes('STATUS_PACARAN'), 'tail includes end');

// normalizeForMatch: lowercase + trim + collapse whitespace (TEMUAN-045).
assert.equal(normalizeForMatch('  AI   cemburu '), 'ai cemburu');
assert.equal(normalizeForMatch('AI\tcemburu\nsaat'), 'ai cemburu saat');
assert.equal(normalizeForMatch('[STATUS]:  pacaran'), '[status]: pacaran');

console.log('OK — memory-helpers self-check passed');
