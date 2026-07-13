import { Router } from 'express';
import db from '../db/database.js';
import { HttpError } from '../middlewares/errorHandler.js';
import { streamChat, generateFallbackMessage } from '../controllers/messages.controller.js';
import { normalizeDynamicMemory } from '../util/dynamicMemory.js';

const router = Router({ mergeParams: true });

const getStoryStmt = db.prepare(`
  SELECT * FROM stories WHERE id = ? AND is_archived = 0
`);

const listMessagesStmt = db.prepare(`
  SELECT id, role, raw_content, created_at, token_estimate
  FROM messages
  WHERE story_id = ? AND (raw_content IS NOT NULL AND TRIM(raw_content) != '')
  ORDER BY created_at DESC, id DESC
  LIMIT ? OFFSET ?
`);

const countMessagesStmt = db.prepare(`
  SELECT COUNT(*) AS total FROM messages WHERE story_id = ? AND (raw_content IS NOT NULL AND TRIM(raw_content) != '')
`);

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (story_id, role, raw_content, token_estimate)
  VALUES (?, ?, ?, ?)
`);

// Rollback support: hapus pesan by id + revert dynamic_memory ke snapshot
// sebelum extraction. Dipakai saat user klik Stop setelah pesan terlanjur
// tersimpan (SSE done sudah terkirim atau user message sudah di-insert).
const deleteMessageStmt = db.prepare(`
  DELETE FROM messages WHERE id = ? AND story_id = ?
`);
// Fallback lookup kalau frontend belum sempat capture user_message_id
// dari SSE meta event (e.g. abort sangat awal sebelum meta terkirim).
// Hapus user message terbaru by story_id + content match, scoped to the last
// 30s so a duplicate-content message from an earlier turn isn't wrongly
// deleted (TEMUAN-051).
const findLatestUserMessageByContentStmt = db.prepare(`
  SELECT id FROM messages
  WHERE story_id = ? AND role = 'user' AND raw_content = ?
    AND created_at >= datetime('now','-30 seconds')
  ORDER BY created_at DESC, id DESC
  LIMIT 1
`);
const deleteMessageTtsByMsgStmt = db.prepare(`
  DELETE FROM message_tts WHERE message_id = ?
`);
const getStoryMemoryStmt = db.prepare(`
  SELECT dynamic_memory FROM stories WHERE id = ?
`);
const getStoryMemoryPrevStmt = db.prepare(`
  SELECT memory_prev FROM stories WHERE id = ?
`);
const updateStoryMemoryStmt = db.prepare(`
  UPDATE stories SET dynamic_memory = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
`);

// TTS cache read untuk replay. Lookup by message_id + validasi milik story
// yang sama (jangan bocor antar-story atau antar-user kalau multi-user
// nanti). Kalau tidak ada → 404 agar frontend tahu synthesize fresh.
const getMessageTtsStmt = db.prepare(`
  SELECT segments_json, provider, synthesized_at
  FROM message_tts
  WHERE message_id = ? AND story_id = ?
`);

const getMessageOwnerStmt = db.prepare(`
  SELECT id FROM messages WHERE id = ? AND story_id = ?
`);

const MAX_MESSAGE_CONTENT = 20000;

// Daftar TTS cache untuk semua assistant messages di story. Frontend pakai
// ini untuk pre-populate currentAudioSegments saat load cerita — supaya
// replay klik tombol speaker tanpa re-synthesize.
const listTtsLatestStmt = db.prepare(`
  SELECT message_id, segments_json, provider, synthesized_at
  FROM message_tts
  WHERE story_id = ?
  ORDER BY synthesized_at DESC, id DESC
  LIMIT ?
`);

function requireStory(req, _res, next) {
  const story = getStoryStmt.get(req.params.id);
  if (!story) return next(new HttpError(404, 'Story tidak ditemukan.'));
  req.story = story;
  next();
}

router.use(requireStory);

router.get('/', (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200);
  const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10) || 0, 0);
  const desc = listMessagesStmt.all(req.story.id, limit, offset);
  const messages = desc.slice().reverse();
  const total = countMessagesStmt.get(req.story.id).total;
  res.json({
    success: true,
    data: { messages, total, limit, offset },
    message: 'OK',
    meta: { timestamp: new Date().toISOString() },
  });
});

router.post('/', async (req, res, next) => {
  const content = (req.body?.content ?? '').toString().trim();
  if (!content) return next(new HttpError(400, 'Pesan user kosong.'));
  if (content.length > MAX_MESSAGE_CONTENT) {
    return next(new HttpError(413, `Pesan melebihi ${MAX_MESSAGE_CONTENT} karakter.`));
  }

  // Provider config (.env) is checked at boot by config/env.js — backend
  // refuses to start if MODEL_PROVIDER_BASE_URL/API_KEY/DEFAULT_MODEL_ID
  // are missing. No per-request env check needed here.

  const userMessage = insertMessageStmt.run(
    req.story.id,
    'user',
    content,
    Math.ceil(content.length / 4)
  );

  try {
    await streamChat({
      req,
      res,
      story: req.story,
      userMessageId: userMessage.lastInsertRowid,
      userContent: content,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/fallback', async (req, res, next) => {
  const userContent = (req.body?.user_content ?? '').toString().trim();
  const errorMessage = (req.body?.error_message ?? '').toString();
  if (!userContent) return next(new HttpError(400, 'user_content diperlukan.'));

  try {
    await generateFallbackMessage({
      req,
      res,
      story: req.story,
      userContent,
      errorMessage,
    });
  } catch (err) {
    next(err);
  }
});

// Rollback: hapus pesan user + AI yang sudah terlanjur tersimpan, dan
// kembalikan dynamic_memory ke snapshot sebelum extraction. Frontend pakai
// ini saat user klik Stop setelah SSE done terlanjur terkirim.
// Body: { user_message_id?, ai_message_id?, memory_snapshot?, content? }
// - user_message_id: id pesan user (kalau sudah diketahui dari SSE meta)
// - ai_message_id: id pesan AI yang harus dihapus (kalau sudah tersimpan)
// - memory_snapshot: string JSON dynamic_memory sebelum extract (kalau ada)
// - content: fallback kalau user_message_id belum sempat ter-capture (abort
//   sangat awal sebelum meta event terkirim). Backend cari user message
//   terbaru by story_id + content match.
router.delete('/rollback', async (req, res, next) => {
  let userMessageId = Number.parseInt(req.body?.user_message_id ?? '0', 10);
  const aiMessageId = Number.parseInt(req.body?.ai_message_id ?? '0', 10);
  const memorySnapshot = req.body?.memory_snapshot;
  const contentFallback = (req.body?.content ?? '').toString().trim();

  const storyId = req.story.id;

  // Kalau user_message_id tidak ada (abort sebelum meta), coba cari by content.
  // Frontend selalu kirim content sebagai fallback supaya rollback selalu
  // bisa hapus user message yang sudah di-insert di route handler POST /.
  if ((!Number.isInteger(userMessageId) || userMessageId <= 0) && contentFallback) {
    const found = findLatestUserMessageByContentStmt.get(storyId, contentFallback);
    if (found?.id) {
      userMessageId = found.id;
    }
  }

  if (!Number.isInteger(userMessageId) || userMessageId <= 0) {
    return next(new HttpError(400, 'user_message_id diperlukan (atau content untuk fallback lookup).'));
  }

  // Resolve the memory value to restore, BEFORE the transaction so a bad
  // client snapshot is rejected (400) without partially deleting messages.
  // Priority: validated client snapshot → server-side memory_prev → none.
  let restoreMemory = null;
  if (typeof memorySnapshot === 'string' && memorySnapshot.length > 0) {
    // Validate: must JSON.parse + normalize to the 4-category shape, else a
    // buggy/truncated/garbage payload would silently wipe long-term memory
    // (TEMUAN-024). Only the normalized form is persisted.
    let parsed;
    try { parsed = JSON.parse(memorySnapshot); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      return next(new HttpError(400, 'memory_snapshot bukan JSON valid.'));
    }
    const normalized = normalizeDynamicMemory(parsed);
    restoreMemory = JSON.stringify(normalized);
  } else {
    // No client snapshot — fall back to the server-side pre-update snapshot
    // captured by the extractor (TEMUAN-019/030).
    const prev = getStoryMemoryPrevStmt.pluck().get(storyId);
    if (typeof prev === 'string' && prev.length > 0) {
      restoreMemory = prev;
    }
  }

  const tx = db.transaction(() => {
    // Hapus AI message + TTS cache-nya kalau ada
    if (Number.isInteger(aiMessageId) && aiMessageId > 0) {
      deleteMessageTtsByMsgStmt.run(aiMessageId);
      deleteMessageStmt.run(aiMessageId, storyId);
    }
    // Hapus user message + TTS cache-nya (TTS untuk user message jarang ada)
    deleteMessageTtsByMsgStmt.run(userMessageId);
    deleteMessageStmt.run(userMessageId, storyId);
    // Restore memory ke snapshot (validated client snapshot atau server-side
    // memory_prev). Kalau keduanya tidak ada, memory dibiarkan apa adanya.
    if (restoreMemory) {
      updateStoryMemoryStmt.run(restoreMemory, storyId);
    }
  });
  tx();

  res.json({
    success: true,
    data: { rolled_back: { user_message_id: userMessageId, ai_message_id: aiMessageId || null } },
    message: 'Rollback berhasil.',
    meta: { timestamp: new Date().toISOString() },
  });
});

router.get('/tts-latest', (req, res) => {
  // Join ke messages untuk pastikan hanya assistant message yang punya TTS
  // yang dikembalikan. Kalau tidak ada cache sama sekali, return { items: [] }
  // dengan 200 — bukan 404 — supaya frontend bisa skip tanpa try/catch.
  const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200);
  const rows = listTtsLatestStmt.all(req.story.id, limit);
  const items = rows.map((row) => {
    let segments = null;
    try {
      segments = JSON.parse(row.segments_json);
    } catch {
      segments = null;
    }
    return {
      message_id: row.message_id,
      segments,
      provider: row.provider,
      synthesized_at: row.synthesized_at,
    };
  }).filter((it) => Array.isArray(it.segments));
  res.json({
    success: true,
    data: { items },
    message: 'OK',
    meta: { timestamp: new Date().toISOString() },
  });
});

router.get('/:messageId/tts-cache', (req, res, next) => {
  const messageId = Number.parseInt(req.params.messageId, 10);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return next(new HttpError(400, 'messageId tidak valid.'));
  }
  // Verify message belongs to this story — cegah cross-story cache leak.
  if (!getMessageOwnerStmt.get(messageId, req.story.id)) {
    return next(new HttpError(404, 'Message tidak ditemukan di story ini.'));
  }
  const row = getMessageTtsStmt.get(messageId, req.story.id);
  if (!row) return next(new HttpError(404, 'TTS cache belum tersedia untuk message ini.'));
  let segments;
  try {
    segments = JSON.parse(row.segments_json);
  } catch (err) {
    console.warn('[messages] corrupt tts_cache JSON:', err.message);
    return next(new HttpError(500, 'TTS cache rusak, perlu synthesize ulang.'));
  }
  res.json({
    success: true,
    data: {
      segments,
      provider: row.provider,
      synthesized_at: row.synthesized_at,
    },
    message: 'OK',
    meta: { timestamp: new Date().toISOString() },
  });
});

export default router;
