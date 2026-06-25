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
  const narration = `⚠️ AI provider sedang tidak tersedia. ${aiName} memberikan balasan sementara agar percakapan tetap berjalan.\n\nHai ${userName}! ${aiName} di sini. Maaf ya kalau balasannya terbatas hari ini. Ada yang bisa ${aiName} bantu?${errorInfo}`;
  return {
    raw_text: narration,
    parsed: buildSimpleFallbackSegments(narration, aiName),
    used_fallback: true,
  };
}

/** Build audio_segments sederhana untuk narasi teks (LLM tidak dipanggil). */
function buildSimpleFallbackSegments(narration, aiName) {
  const segments = [{
    text: narration,
    gender: 'male',
    type: 'narration',
    voice_config: { locale: 'id-ID', voice_name: 'id-ID-ArdiNeural' },
  }];
  return { full_story: narration, audio_segments: segments };
}

/**
 * Robust JSON parser dari streaming chunks LLM.
 * LLM kadang:
 *   - mulai dengan ```json (di-strip manual via escapeCodeFences).
 *   - ada reasoning prefix  <think>...</think>.
 *   - output prefix/teks lain sebelum '{'.
 * Pendekatan: cari '{' pertama dan '}' terakhir, extract substring, parse.
 * Kalau gagal: return null → caller pakai raw_text sebagai fallback.
 */
function escapeCodeFences(text) {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/g, '')
    .trim();
}

function tryParseStoryJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = stripReasoningContent(escapeCodeFences(rawText));
  // Cari kurung kurawal平衡 pertama
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const slice = cleaned.slice(first, last + 1);
  try {
    const obj = JSON.parse(slice);
    if (typeof obj.full_story !== 'string') return null;
    const segmentsIn = Array.isArray(obj.audio_segments) ? obj.audio_segments : [];
    const audio_segments = segmentsIn
      .filter((s) => s && typeof s.text === 'string' && s.text.trim().length > 0)
      .map((s) => {
        const rawGender = s.gender === 'female' ? 'female' : 'male';
        const rawLocale = typeof s.voice_config?.locale === 'string' ? s.voice_config.locale : 'id-ID';
        const isEnglish = rawLocale.toLowerCase().startsWith('en');
        const voice_name = isEnglish
          ? (rawGender === 'female' ? 'en-US-JennyNeural' : 'en-US-GuyNeural')
          : (rawGender === 'female' ? 'id-ID-GadisNeural' : 'id-ID-ArdiNeural');
        // Normalisasi hint non-Neural dari LLM (-Male / -Female suffix) supaya pass-through valid.
        let llmHint = (typeof s.voice_config?.voice_name === 'string') ? s.voice_config.voice_name : null;
        if (llmHint) {
          llmHint = llmHint.replace(/-Male$/i, 'Neural').replace(/-Female$/i, 'Neural');
        }
        return {
          text: s.text,
          gender: rawGender,
          type: s.type === 'dialogue' ? 'dialogue' : 'narration',
          voice_config: {
            locale: rawLocale,
            voice_name: llmHint || voice_name,
          },
        };
      });
    return {
      full_story: obj.full_story.trim(),
      audio_segments,
    };
  } catch {
    return null;
  }
}

/**
 * Build fallback audio_segments dari teks narasi polos (split per kalimat).
 * Dipakai kalau LLM output bukan JSON valid atau stream putus.
 * Dialog (text dalam tanda kutip ganda) → 'dialogue' type, gender default female
 * (LLM tidak dipanggil, fallback konservatif ke karakter AI kalau ada konteks).
 * Narasi → 'narration' type, gender male.
 */
function buildFallbackSegmentsFromText(rawText) {
  if (!rawText || !rawText.trim()) {
    return { full_story: rawText || '', audio_segments: [] };
  }
  const paragraphList = rawText
    .split(/\n{2,}/g)
    .map((p) => p.trim())
    .filter(Boolean);
  const segments = [];
  for (const para of paragraphList) {
    if (!para) continue;
    // Paragraph punya dialog (ada tanda kutip ganda)?
    if (/"[^"]+"/.test(para)) {
      // Pecah: bagian sebelum/antar/dialog. Bagian dengan kutip → dialogue.
      const parts = para.split(/(?="[^"]+")/g).map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        const isDialogue = /^"[^"]+"$/.test(part);
        segments.push({
          text: part,
          gender: isDialogue ? 'female' : 'male',
          type: isDialogue ? 'dialogue' : 'narration',
          voice_config: {
            locale: 'id-ID',
            voice_name: isDialogue ? 'id-ID-GadisNeural' : 'id-ID-ArdiNeural',
          },
        });
      }
    } else {
      segments.push({
        text: para,
        gender: 'male',
        type: 'narration',
        voice_config: { locale: 'id-ID', voice_name: 'id-ID-ArdiNeural' },
      });
    }
  }
  return { full_story: rawText.trim(), audio_segments: segments };
}

function finalizeResponse(text) {
  // Legacy cleanup (dipakai oleh endpoint fallback).
  let cleaned = stripReasoningContent(text);
  cleaned = cleaned.replace(/\[(MIKA|NARASI|AI|KARAKTER)\]\s*/gi, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

/**
 * Parse streaming buffer sepanjang chunks diterima.
 * Trigger parse setiap kali ada kurung kurawal tutup di akhir (candidates).
 * Batas parse berulang=1 setiap chunks + 1 final saat stream_done.
 */
function safeParseFromBuffer(buffer) {
  return tryParseStoryJson(buffer);
}

/**
 * Stream backlog yang dikirim ke frontend selama LLM menulis JSON.
 * Kita tidak bisa pakai incremental JSON parse (overkill), jadi:
 *   - Kirim token chars ke SSE `token` event sehingga UI chat muncul real-time
 *     (frontend bisa render JSON chars apa adanya dalam bubble).
 *   - Setelah `done`: parse final buffer jadi {full_story, audio_segments}.
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
      if (chunk.type === 'token' && chunk.text) {
        accumulator += chunk.text;
        // Real-time preview: kirim token apa adanya (frontend bisa hide saat
        // JSON dan reveal full_story setelah parsing selesai).
        sendSse(res, 'token', { text: chunk.text });
      } else if (chunk.type === 'done') {
        break;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
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
    sendSse(res, 'error', {
      message: 'AI tidak mengembalikan balasan (respons kosong).',
      code: 'EMPTY_RESPONSE',
    });
    res.end();
    return;
  }

  // Parse JSON output → {full_story, audio_segments}. Fallback raw text kalau gagal.
  const parsed = safeParseFromBuffer(accumulator);
  let fullStoryText;
  let audioSegments;
  let usedFallbackParse = false;

  if (parsed && Array.isArray(parsed.audio_segments)) {
    fullStoryText = parsed.full_story;
    audioSegments = parsed.audio_segments;
  } else {
    usedFallbackParse = true;
    const legacyText = finalizeResponse(accumulator);
    const fb = buildFallbackSegmentsFromText(legacyText);
    fullStoryText = fb.full_story;
    audioSegments = fb.audio_segments;
  }

  // Simpan prosa ke DB (raw_content column).
  let assistantMessageId = null;
  const ins = insertMessageStmt.run(
    story.id,
    'assistant',
    fullStoryText,
    estimateTokens(fullStoryText)
  );
  assistantMessageId = Number(ins.lastInsertRowid);

  // Audio segments: tidak ada URL MP3 pre-baked.
  // Frontend yang fetch sendiri ke POST /api/tts per segment saat user play.
  const ttsEntries = audioSegments.map((seg, i) => ({
    index: i,
    text: seg.text,
    gender: seg.gender,
    type: seg.type,
    voice_config: seg.voice_config,
  }));

  sendSse(res, 'done', {
    message_id: assistantMessageId,
    full_content: fullStoryText,
    audio_segments: ttsEntries,
    used_fallback_parse: usedFallbackParse,
  });

  // Memory extractor: kirim prosa yang sudah di-parse, bukan JSON mentah.
  if (assistantMessageId !== null && fullStoryText.trim().length > 0) {
    extractAndMergeFacts({
      story,
      userMessage: userContent,
      assistantMessage: fullStoryText,
    }).catch((err) =>
      console.warn('[messages] Memory extractor crash:', err.message)
    );
  }

  res.end();
}

export async function generateFallbackMessage({ req, res, story, userContent, errorMessage }) {
  const fallback = buildLocalFallbackResponse(story, userContent, errorMessage);
  const finalText = finalizeResponse(fallback.raw_text);

  const ins = insertMessageStmt.run(
    story.id,
    'assistant',
    finalText,
    estimateTokens(finalText)
  );
  const assistantMessageId = Number(ins.lastInsertRowid);

  const ttsEntries = fallback.parsed.audio_segments.map((seg, i) => ({
    index: i,
    text: seg.text,
    gender: seg.gender,
    type: seg.type,
    voice_config: seg.voice_config,
  }));

  res.json({
    success: true,
    message_id: assistantMessageId,
    content: finalText,
    audio_segments: ttsEntries,
  });
}
