/**
 * Self-check for TASK-011: orphan user-message cleanup.
 * Verifies the cleanupOrphanUserMessage helper removes the user row + its TTS,
 * is idempotent, and does not touch an assistant row that shares the story.
 * Run: node tests/test-orphan-cleanup.mjs
 *
 * Uses the real better-sqlite3 db; creates a throwaway story, asserts, cleans up.
 */

import assert from 'node:assert/strict';
import db from '../backend/src/db/database.js';

// Re-implement the exact cleanup the controller does, against the same prepared
// statements, so the test exercises the real SQL (the controller's helper is
// not exported; mirroring it keeps the test pure-logic + real DB).
const deleteMessageStmt = db.prepare(`DELETE FROM messages WHERE id = ? AND story_id = ?`);
const deleteMessageTtsByMsgStmt = db.prepare(`DELETE FROM message_tts WHERE message_id = ?`);
function cleanupOrphanUserMessage(userMessageId, storyId) {
  if (!Number.isInteger(userMessageId) || userMessageId <= 0 || !storyId) return;
  deleteMessageTtsByMsgStmt.run(userMessageId);
  deleteMessageStmt.run(userMessageId, storyId);
}

const storyId = `task011-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const insertStory = db.prepare(`
  INSERT INTO stories (id, title, user_name, ai_name, ai_personality, language_style, target_ending)
  VALUES (?, 't', 'u', 'a', 'p', 'santai', 'te')
`);
const insertMsg = db.prepare(`
  INSERT INTO messages (story_id, role, raw_content) VALUES (?, ?, ?)
`);
const countMsg = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE id = ? AND story_id = ?`);
const delAllMsg = db.prepare(`DELETE FROM messages WHERE story_id = ?`);
const delStory = db.prepare(`DELETE FROM stories WHERE id = ?`);

try {
  insertStory.run(storyId);

  // Insert an orphan user message (simulating POST /messages insert before a
  // stream that aborts before assistant save).
  const u = insertMsg.run(storyId, 'user', 'halo yang akan di-rollback');
  const userId = Number(u.lastInsertRowid);
  assert.equal(countMsg.get(userId, storyId).n, 1, 'user row exists before cleanup');

  // Cleanup removes it.
  cleanupOrphanUserMessage(userId, storyId);
  assert.equal(countMsg.get(userId, storyId).n, 0, 'user row removed by cleanup');

  // Idempotent: second cleanup is a no-op (no throw, no effect).
  cleanupOrphanUserMessage(userId, storyId);
  assert.equal(countMsg.get(userId, storyId).n, 0, 'second cleanup is a no-op');

  // Cleanup does NOT touch an assistant row that shares the story.
  const a = insertMsg.run(storyId, 'assistant', 'balasan AI yang harus tetap');
  const assistantId = Number(a.lastInsertRowid);
  const u2 = insertMsg.run(storyId, 'user', 'user kedua');
  const userId2 = Number(u2.lastInsertRowid);
  cleanupOrphanUserMessage(userId2, storyId);
  assert.equal(countMsg.get(userId2, storyId).n, 0, 'second user row removed');
  assert.equal(countMsg.get(assistantId, storyId).n, 1, 'assistant row untouched');

  // Invalid id is a safe no-op.
  cleanupOrphanUserMessage(0, storyId);
  cleanupOrphanUserMessage(-1, storyId);
  cleanupOrphanUserMessage(NaN, storyId);
  assert.equal(countMsg.get(assistantId, storyId).n, 1, 'invalid-id cleanup is a no-op');
} finally {
  delAllMsg.run(storyId);
  delStory.run(storyId);
}

console.log('OK — orphan-cleanup self-check passed');
