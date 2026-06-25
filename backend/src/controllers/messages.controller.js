import db from '../db/database.js';
import { buildContextPayload, estimateTokens } from '../services/memoryManager.service.js';
import {
  streamChatCompletion,
  chatCompletionOnce,
  resolveModelId,
} from '../services/modelProvider.service.js';
import { extractAndMergeFacts } from '../services/memoryExtractor.service.js';
import { HttpError } from '../middlewares/errorHandler.js';

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (story_id, role, raw_content, token_estimate)
  VALUES (?, ?, ?, ?)
`);

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function stripReasoningContent(text) {
  if (typeof text !== 'string') return text;
  const tags = ['ctrl32', 'think', 'reasoning', 'thought', 'analysis'];
  let cleaned = text;
  for (const tag of tags) {
    cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`<\\/${tag}>`, 'gi'), '');
  }
  cleaned = cleaned.replace(/<ctrl32>.*?<\/ctrl32>/gi, '');
  cleaned = cleaned.replace(/<ctrl32>/gi, '');
  return cleaned;
}

function buildLocalFallbackResponse(story, userContent, errorMessage) {
  const aiName = story.ai_name ?? 'AI';
  const userName = story.user_name ?? 'Kamu';
  const errorInfo = errorMessage ? `\n\n_(Error provider: ${errorMessage})_` : '';
  return `⚠️ AI provider sedang tidak tersedia. ${aiName} memberikan balasan sementara agar percakapan tetap berjalan.\n\nHai ${userName}! ${aiName} di sini. Maaf ya kalau balasannya terbatas hari ini. Ada yang bisa ${aiName} bantu?${errorInfo}`;
}

function finalizeResponse(text) {
  let cleaned = stripReasoningContent(text);
  // Remove role tags and normalize line breaks
  cleaned = cleaned.replace(/\[(MIKA|NARASI|AI|KARAKTER)\]\s*/gi, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

async function generateLocalFallback({ story, userContent }) {
  return buildLocalFallbackResponse(story, userContent);
}

/**
 * Melakukan streaming balasan AI lewat Server-Sent Events ke frontend.
 * Sequence: meta -> token* -> done (beserta message_id & full_content) -> end.
 *
 * Jika provider AI gagal (kuota habis, error), sistem akan fallback ke
 * respons lokal yang sopan agar UI tidak terlihat kosong dan user tetap
 * bisa melanjutkan chat nanti.
 */
export async function streamChat({
  req,
  res,
  story,
  userMessageId,
  userContent,
  modelId,
}) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const messages = buildContextPayload(story, userContent);
  const finalModel = resolveModelId(modelId);

  sendSse(res, 'meta', {
    model: finalModel,
    user_message_id: userMessageId,
  });

  let accumulator = '';
  let providerFailed = false;
  const abortCtrl = new AbortController();
  res.on('close', () => abortCtrl.abort());

  try {
    const stream = streamChatCompletion({
      model: finalModel,
      messages,
      signal: abortCtrl.signal,
    });

    for await (const chunk of stream) {
      console.log('[messages] chunk:', chunk);
      if (chunk.type === 'token' && chunk.text) {
        accumulator += chunk.text;
        sendSse(res, 'token', { text: chunk.text });
      } else if (chunk.type === 'done') {
        break;
      }
    }
    console.log('[messages] stream ended, accumulator len:', accumulator.length);
  } catch (err) {
    if (err.name === 'AbortError') {
      // Client terputus, simpan partial kalau ada.
      accumulator = accumulator.trim();
    } else {
      console.warn('[messages] Provider error:', err.message);
      sendSse(res, 'error', {
        message: err.message || 'AI provider mengalami gangguan.',
        code: err.code || 'PROVIDER_ERROR',
      });
      res.end();
      return;
    }
  }

  if (accumulator.trim().length === 0 && !providerFailed) {
    // Model mengembalikan respons kosong; anggap sebagai error.
    sendSse(res, 'error', {
      message: 'AI tidak mengembalikan balasan (respons kosong).',
      code: 'EMPTY_RESPONSE',
    });
    res.end();
    return;
  }

  accumulator = finalizeResponse(accumulator);

  let assistantMessageId = null;
  const ins = insertMessageStmt.run(
    story.id,
    'assistant',
    accumulator,
    estimateTokens(accumulator)
  );
  assistantMessageId = Number(ins.lastInsertRowid);

  sendSse(res, 'done', {
    message_id: assistantMessageId,
    full_content: accumulator,
  });

  if (assistantMessageId !== null && accumulator.trim().length > 0) {
    extractAndMergeFacts({
      story,
      userMessage: userContent,
      assistantMessage: accumulator,
    }).catch((err) =>
      console.warn('[messages] Memory extractor crash:', err.message)
    );
  }

  res.end();
}

export async function generateFallbackMessage({ req, res, story, userContent, errorMessage }) {
  const fallbackText = buildLocalFallbackResponse(story, userContent, errorMessage);
  const finalText = finalizeResponse(fallbackText);

  const ins = insertMessageStmt.run(
    story.id,
    'assistant',
    finalText,
    estimateTokens(finalText)
  );
  const assistantMessageId = Number(ins.lastInsertRowid);

  res.json({
    success: true,
    message_id: assistantMessageId,
    content: finalText,
  });
}
