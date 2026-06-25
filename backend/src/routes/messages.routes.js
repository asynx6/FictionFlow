import { Router } from 'express';
import db from '../db/database.js';
import { HttpError } from '../middlewares/errorHandler.js';
import { streamChat, generateFallbackMessage } from '../controllers/messages.controller.js';
import { resolveModelId } from '../controllers/models.controller.js';
import { env } from '../config/env.js';

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

  if (!env.MODEL_PROVIDER_API_KEY) {
    return next(
      new HttpError(
        500,
        'MODEL_PROVIDER_API_KEY belum dikonfigurasi di backend/.env.'
      )
    );
  }

  const modelId = resolveModelId(req.body?.model_id ?? req.story.active_model_id);

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
      modelId,
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
