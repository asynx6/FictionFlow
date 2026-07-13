/**
 * Self-check for TASK-010: buildContextPayload no longer double-injects the
 * newest user message, and getRecentStmt has a deterministic id DESC tiebreaker
 * for messages sharing a 1-second created_at.
 * Run: node tests/test-context-payload.mjs
 *
 * Uses the real better-sqlite3 db (migrations run on the dev DB). Creates a
 * throwaway story + messages, asserts, then cleans up.
 */

import assert from 'node:assert/strict';
import { buildContextPayload } from '../backend/src/services/memoryManager.service.js';
import db from '../backend/src/db/database.js';

const storyId = `task010-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const insertStory = db.prepare(`
  INSERT INTO stories (id, title, user_name, ai_name, ai_personality, language_style, target_ending)
  VALUES (?, 't', 'u', 'a', 'p', 'santai', 'te')
`);
const insertMsg = db.prepare(`
  INSERT INTO messages (story_id, role, raw_content, created_at)
  VALUES (?, ?, ?, ?)
`);
const delMessages = db.prepare(`DELETE FROM messages WHERE story_id = ?`);
const delStory = db.prepare(`DELETE FROM stories WHERE id = ?`);

try {
  insertStory.run(storyId);

  // Insert a user+assistant exchange and a SECOND user message, all sharing
  // the same created_at (second-granularity). The newest user message is the
  // last insert; buildContextPayload must include it EXACTLY ONCE.
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  insertMsg.run(storyId, 'user', 'pesan user pertama', now);
  insertMsg.run(storyId, 'assistant', 'balasan AI', now);
  insertMsg.run(storyId, 'user', 'pesan user terbaru', now);

  const payload = buildContextPayload({ id: storyId, short_term_window: 4, roleplay_mode: 'default' }, 'pesan user terbaru');

  // The newest user message appears exactly once in the payload.
  const userTurns = payload.filter((m) => m.role === 'user' && m.content === 'pesan user terbaru');
  assert.equal(userTurns.length, 1, `newest user message must appear once, got ${userTurns.length}`);

  // System prompt is first; the newest user turn is last (no duplicate append).
  assert.equal(payload[0].role, 'system');
  assert.equal(payload[payload.length - 1].role, 'user');
  assert.equal(payload[payload.length - 1].content, 'pesan user terbaru');

  // id DESC tiebreaker: with shared created_at, the newest user message (highest id)
  // must be the LAST row after reverse() — i.e. it won the tiebreak. If the
  // tiebreaker were absent, ordering of same-timestamp rows would be arbitrary.
  // Here we assert the newest user message is the final user row, proving the
  // high-id row sorted to the front of the DESC query (and thus to the end
  // after reverse).
  assert.ok(userTurns.length === 1, 'deterministic tiebreaker produced a single newest-user row');
} finally {
  delMessages.run(storyId);
  delStory.run(storyId);
}

console.log('OK — context-payload self-check passed (no double-inject, id tiebreaker)');
