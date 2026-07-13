/**
 * Self-check for MEMORY REFACTOR — Tagged State Facts.
 * Run: node tests/test-memory-state.mjs
 *
 * Validates:
 *   1. Legacy `dynamic_memory` schema (array of {category,key,value})
 *      normalizes into new categorized-string-array form.
 *   2. New `{user,ai,world,relationship}` schema round-trips.
 *   3. mergeRelationshipFacts replaces tagged keys (latest wins), keeps
 *      narrative (case-insensitive dedup).
 *   4. mergeDynamicMemory dedup for user/ai/world is case-insensitive.
 *   5. parseRelationshipState extracts STATUS / AI_PANGGILAN / etc.
 *   6. buildCurrentContextBlock returns empty string when no tagged state,
 *      produces the KONTEKS SAAT INI block when state populates.
 *   7. Both renderSystemPrompt and renderCasualSystemPrompt include
 *      the KONTEKS block when available.
 */

import assert from 'node:assert/strict';
import {
  normalizeDynamicMemory,
  mergeRelationshipFacts,
  mergeDynamicMemory,
} from '../backend/src/services/memoryExtractor.service.js';
import {
  parseRelationshipState,
  buildCurrentContextBlock,
  renderSystemPrompt,
  renderCasualSystemPrompt,
} from '../backend/src/services/promptBuilder.service.js';

// ── 1. Legacy schema normalization ──
// Known tagged keys (here `status`) emit canonical `[KEY]: value` so legacy
// rows dedup with freshly extracted facts; non-tagged keys keep `KEY: value`.
{
  const legacy = [
    { category: 'user', key: 'nama', value: 'Beni' },
    { category: 'ai', key: 'panggilan', value: 'kak' },
    { category: 'relationship', key: 'status', value: 'teman' },
  ];
  const out = normalizeDynamicMemory(legacy);
  assert.deepEqual(out.user, ['nama: Beni']);
  assert.deepEqual(out.ai, ['panggilan: kak']);
  assert.deepEqual(out.relationship, ['[STATUS]: teman']);
  assert.deepEqual(out.world, []);
}

// ── 2. New schema round-trip ──
{
  const newSchema = {
    user: ['a', 'b'],
    ai: ['sesuatu'],
    world: [],
    relationship: ['[STATUS]: pacaran'],
  };
  const out = normalizeDynamicMemory(newSchema);
  assert.deepEqual(out, newSchema);
}

// ── 3. Tagged merge: replace-by-key, narrative dedup ──
{
  const existing = [
    '[STATUS]: teman',
    '[AI_PANGGILAN]: bro',
    'AI pernah cemburu',
  ];
  const incoming = [
    '[STATUS]: pacaran',          // replace [STATUS]: teman
    '[SEJAK]: setelah confess',   // add new tag
    '[AI_PANGGILAN]: sayang',     // replace [AI_PANGGILAN]: bro
    'AI pernah cemburu',           // duplicate narrative → skip
    'AI takut ditinggal',         // new narrative → add
  ];
  const out = mergeRelationshipFacts(existing, incoming);
  // Tagged facts must appear (latest values).
  const tagged = out.filter((f) => /^\[[A-Z_]+\]:/.test(f));
  const tags = tagged.map((f) => f.match(/^\[([A-Z_]+)\]:?/)?.[1]);
  assert.deepEqual(tags.sort(), ['AI_PANGGILAN', 'SEJAK', 'STATUS']);
  // STATUS is the newer 'pacaran', not 'teman'.
  const statusLine = tagged.find((f) => f.startsWith('[STATUS]:'));
  assert.match(statusLine, /pacaran/);
  // AI_PANGGILAN is now 'sayang'.
  const panggilan = tagged.find((f) => f.startsWith('[AI_PANGGILAN]:'));
  assert.match(panggilan, /sayang/);
  // Narrative: cemburu kept once, takut-tinggal added; no duplicate.
  const narrative = out.filter((f) => !/^\[[A-Z_]+\]:/.test(f));
  assert.equal(narrative.length, 2);
  assert.ok(narrative.some((n) => n.includes('cemburu')));
  assert.ok(narrative.some((n) => n.includes('takut ditinggal')));
}

// ── 3b. BUG-04 collapse: bracket-less + bracketed same key → one entry ──
{
  // (a) existing bare + incoming bracketed → single canonical entry.
  const a = mergeRelationshipFacts(['USER_PANGGILAN: kaishi'], ['[USER_PANGGILAN]: kaishi']);
  assert.deepEqual(a, ['[USER_PANGGILAN]: kaishi']);

  // (b) existing + incoming same key → latest wins.
  const b = mergeRelationshipFacts(['[STATUS]: teman'], ['[STATUS]: pacaran']);
  assert.deepEqual(b, ['[STATUS]: pacaran']);

  // (c) mixed-case existing + bare incoming → latest canonical wins.
  const c = mergeRelationshipFacts(['[user_panggilan]: x'], ['USER_PANGGILAN: y']);
  assert.deepEqual(c, ['[USER_PANGGILAN]: y']);

  // (d) narrative case-insensitive dedup of existing.
  const d = mergeRelationshipFacts(['AI cemburu', 'ai cemburu'], []);
  assert.deepEqual(d, ['AI cemburu']);

  // Spaced-colon drift collapses too.
  const e = mergeRelationshipFacts(['[STATUS] : teman'], ['status: pacaran']);
  assert.deepEqual(e, ['[STATUS]: pacaran']);
}


// ── 4. mergeDynamicMemory dedup for non-relationship categories ──
{
  const existing = normalizeDynamicMemory({
    user: ['suka kopi'],
    ai: [],
    world: ['setting di Jakarta'],
    relationship: [],
  });
  const incoming = normalizeDynamicMemory({
    user: ['Suka Kopi'],           // dup, case-insensitive
    ai: [],
    world: ['cuaca hujan'],
    relationship: [],
  });
  const out = mergeDynamicMemory(existing, incoming);
  assert.equal(out.user.length, 1, 'case-insensitive dedup for user');
  assert.equal(out.world.length, 2);
}

// ── 5. parseRelationshipState extracts tagged keys ──
{
  const parsed = parseRelationshipState([
    '[STATUS]: pacaran',
    '[SEJAK]: setelah confess',
    '[AI_PANGGILAN]: sayang',
    '[USER_PANGGILAN]: sayang',
    '[KONTEKS_PERILAKU]: karakternya tsundere...',
    'fakta naratif biasa',
  ]);
  assert.equal(parsed.STATUS, 'pacaran');
  assert.equal(parsed.SEJAK, 'setelah confess');
  assert.equal(parsed.AI_PANGGILAN, 'sayang');
  assert.equal(parsed.USER_PANGGILAN, 'sayang');
  assert.match(parsed.KONTEKS_PERILAKU, /tsundere/);
}

// Empty relation array → empty state object.
{
  assert.deepEqual(parseRelationshipState([]), {});
}

// ── 6. buildCurrentContextBlock ──
{
  // No state → empty string.
  const story1 = { dynamic_memory: JSON.stringify({ user: ['x'], ai: [], world: [], relationship: [] }) };
  assert.equal(buildCurrentContextBlock(story1), '');

  // With state.
  const story2 = {
    dynamic_memory: JSON.stringify({
      user: [],
      ai: ['tsundere'],
      world: [],
      relationship: [
        '[STATUS]: pacaran',
        '[SEJAK]: setelah confess di taman',
        '[AI_PANGGILAN]: sayang',
        '[USER_PANGGILAN]: sayang',
        '[KONTEKS_PERILAKU]: Panggil user sayang dengan natural. Jangan pernah meragukan bahwa mereka berpacaran.',
      ],
    }),
  };
  const block = buildCurrentContextBlock(story2);
  assert.match(block, /## KONTEKS SAAT INI \[BACA INI SEBELUM MEMBALAS\]/);
  assert.match(block, /Status hubungan dengan user: pacaran/);
  assert.match(block, /setelah confess di taman/);
  assert.match(block, /Cara kamu memanggil user sekarang: "sayang"/);
  assert.match(block, /Cara user memanggil kamu sekarang: "sayang"/);
  assert.match(block, /Panggil user sayang dengan natural/);
  assert.match(block, /Perilakumu HARUS mencerminkan/);
}

// Legacy payload with a bare tagged key now surfaces as state (TASK-001 fix:
// tolerant read means bracket-less legacy `status: teman kerja` is read as
// [STATUS]). Previously the block stayed empty — the BUG-05 symptom.
{
  const legacyStory = {
    dynamic_memory: JSON.stringify([
      { category: 'relationship', key: 'status', value: 'teman kerja' },
    ]),
  };
  const block = buildCurrentContextBlock(legacyStory);
  assert.match(block, /Status hubungan dengan user: teman kerja/);
}

// ── 7. renderSystemPrompt includes KONTEKS block when present ──
{
  const story = {
    ai_name: 'Seika',
    user_name: 'Beni',
    user_persona: 'pemain',
    ai_personality: 'tsundere, cantik, kaya',
    user_gender: 'male',
    ai_gender: 'female',
    language_style: 'santai',
    target_ending: 'berteman dekat',
    dynamic_memory: JSON.stringify({
      user: [],
      ai: ['tsundere'],
      world: [],
      relationship: ['[AI_PANGGILAN]: sayang', '[KONTEKS_PERILAKU]: panggil sayang'],
    }),
  };
  const prompt = renderSystemPrompt(story);
  // KONTEKS block must appear BEFORE the DYNAMIC FACTS heading.
  const idxKonteks = prompt.indexOf('## KONTEKS SAAT INI');
  const idxDynamic = prompt.indexOf('=== DYNAMIC FACTS (auto-updated) ===');
  assert.ok(idxKonteks > 0, 'KONTEKS block must appear in prompt');
  assert.ok(idxDynamic > idxKonteks, 'KONTEKS must appear BEFORE DYNAMIC FACTS');
  assert.match(prompt, /"sayang"/);
}

// renderCasualSystemPrompt also includes the block.
{
  const story = {
    ai_name: 'A',
    user_name: 'B',
    user_persona: 'pemain',
    ai_personality: '...',
    user_gender: 'unspecified',
    ai_gender: 'female',
    language_style: 'santai',
    target_ending: 'teman',
    dynamic_memory: JSON.stringify({
      user: [], ai: [], world: [],
      relationship: ['[AI_PANGGILAN]: bro'],
    }),
    roleplay_mode: 'casual',
  };
  const prompt = renderCasualSystemPrompt(story);
  assert.match(prompt, /## KONTEKS SAAT INI/);
}

console.log('OK — memory state-facts self-check passed');
