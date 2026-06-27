import db from '../db/database.js';
import { buildContextPayload, estimateTokens } from '../services/memoryManager.service.js';
import {
  streamChatCompletion,
  chatCompletionOnce,
  resolveModelId,
} from '../services/modelProvider.service.js';
import { extractAndMergeFacts } from '../services/memoryExtractor.service.js';
import { HttpError } from '../middlewares/errorHandler.js';
import { stripReasoningContent } from '../util/text.js';

/**
 * Resolve gender untuk sebuah segment audio.
 * Aturan:
 *   - Normalisasi (lowercase trim) rawGender dan aiGender.
 *   - Kalau rawGender ada di whitelist ['male','female'] → pakai itu.
 *   - Kalau tidak, fallback ke aiGender (kalau masuk whitelist).
 *   - Else default 'male' (preserves legacy fallback).
 */
function resolveSegmentGender(rawGender, aiGender) {
  const normalize = (v) => (typeof v === 'string' ? v.toLowerCase().trim() : '');
  const raw = normalize(rawGender);
  if (raw === 'male' || raw === 'female') return raw;
  const ai = normalize(aiGender);
  if (ai === 'male' || ai === 'female') return ai;
  return 'male';
}

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (story_id, role, raw_content, token_estimate)
  VALUES (?, ?, ?, ?)
`);

// TTS cache write per assistant message (replay-safe). Provider diset 'azure'
// kalau semua segment server-synthesized (Neural), 'browser' kalau semua
// fallback (non-Neural), 'mixed' kalau kombinasi.
// message_tts.message_id tidak punya UNIQUE constraint (cuma INDEX), jadi
// upsert pakai transaction delete+insert idempotent — toleran untuk resend/
// upstream retry tanpa menambah migration invasive.
const deleteMessageTtsStmt = db.prepare(`
  DELETE FROM message_tts WHERE message_id = ?
`);
const insertMessageTtsStmt = db.prepare(`
  INSERT INTO message_tts (message_id, story_id, segments_json, provider)
  VALUES (?, ?, ?, ?)
`);
function upsertMessageTts(messageId, storyId, segmentsJson, provider) {
  const tx = db.transaction(() => {
    deleteMessageTtsStmt.run(messageId);
    insertMessageTtsStmt.run(messageId, storyId, segmentsJson, provider);
  });
  tx();
}

function classifyProvider(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 'azure';
  const hasAzure = segments.some((s) => s?.voice_config?.voice_name?.endsWith('Neural'));
  const hasBrowser = segments.some((s) => !s?.voice_config?.voice_name?.endsWith('Neural'));
  if (hasAzure && hasBrowser) return 'mixed';
  return hasBrowser ? 'browser' : 'azure';
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildLocalFallbackResponse(story, userContent, errorMessage) {
  const aiName = story.ai_name ?? 'AI';
  const userName = story.user_name ?? 'Kamu';
  const errorInfo = errorMessage ? `\n\n_(Error provider: ${errorMessage})_` : '';
  const narration = `⚠️ AI provider sedang tidak tersedia. ${aiName} memberikan balasan sementara agar percakapan tetap berjalan.\n\nHai ${userName}! ${aiName} di sini. Maaf ya kalau balasannya terbatas hari ini. Ada yang bisa ${aiName} bantu?${errorInfo}`;
  return {
    raw_text: narration,
    parsed: buildSimpleFallbackSegments(narration, aiName, story.ai_gender),
    used_fallback: true,
  };
}

/** Build audio_segments sederhana untuk narasi teks (LLM tidak dipanggil). */
function buildSimpleFallbackSegments(narration, aiName, aiGender) {
  const segments = [{
    text: narration,
    gender: resolveSegmentGender(null, aiGender),
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

function tryParseStoryJson(rawText, aiGender) {
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
        const rawGender = resolveSegmentGender(s.gender, aiGender);
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
function buildFallbackSegmentsFromText(rawText, aiGender = 'male') {
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
          gender: isDialogue ? resolveSegmentGender(null, aiGender) : 'male',
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
function safeParseFromBuffer(buffer, aiGender) {
  return tryParseStoryJson(buffer, aiGender);
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
  const heartbeat = setInterval(() => {
    res.write(':\n\n');
  }, 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    abortCtrl.abort();
  });

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
      clearInterval(heartbeat);
      res.end();
      return;
    }
  }

  if (accumulator.trim().length === 0 && !providerFailed) {
    sendSse(res, 'error', {
      message: 'AI tidak mengembalikan balasan (respons kosong).',
      code: 'EMPTY_RESPONSE',
    });
    clearInterval(heartbeat);
    res.end();
    return;
  }

  // Parse JSON output → {full_story, audio_segments}. Fallback raw text kalau gagal.
  const parsed = safeParseFromBuffer(accumulator, story.ai_gender);
  let fullStoryText;
  let audioSegments;
  let usedFallbackParse = false;

  if (parsed && Array.isArray(parsed.audio_segments)) {
    fullStoryText = parsed.full_story;
    audioSegments = parsed.audio_segments;
  } else {
    usedFallbackParse = true;
    const legacyText = finalizeResponse(accumulator);
    const fb = buildFallbackSegmentsFromText(legacyText, story.ai_gender);
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

  // TTS cache write (replay-safe). Transaction delete+insert untuk
  // toleran retry tanpa UNIQUE constraint di schema.
  try {
    upsertMessageTts(
      assistantMessageId,
      story.id,
      JSON.stringify(ttsEntries),
      classifyProvider(ttsEntries)
    );
  } catch (err) {
    // Cache failure tidak boleh block SSE done — log dan lanjut.
    console.warn('[messages] message_tts cache write failed:', err.message);
  }

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

  clearInterval(heartbeat);
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

  // TTS cache write (idempotent untuk fallback path juga)
  try {
    upsertMessageTts(
      assistantMessageId,
      story.id,
      JSON.stringify(ttsEntries),
      classifyProvider(ttsEntries)
    );
  } catch (err) {
    console.warn('[messages] message_tts cache write failed:', err.message);
  }

  res.json({
    success: true,
    message_id: assistantMessageId,
    content: finalText,
    audio_segments: ttsEntries,
  });
}
