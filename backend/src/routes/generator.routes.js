import { Router } from 'express';
import { HttpError } from '../middlewares/errorHandler.js';
import { chatCompletionOnce } from '../services/modelProvider.service.js';
import { stripReasoningContent } from '../util/text.js';

const router = Router();

// Mirror dengan MAX_MESSAGE_CONTENT di messages.routes.js. Generator
// cukup 2000 chars karena input user = ide konsep singkat, bukan teks
// panjang. Mencegah user mengirim beberapa MB ke upstream LLM yang
// bisa memicu 413/500 atau menghitamkan log provider dengan error
// generic.
const MAX_GENERATOR_PROMPT = 2000;

const GENERATOR_PROMPT = `Kamu adalah generator karakter roleplay untuk aplikasi FictionFlow.
User akan memberikan satu prompt singkat berisi ide atau konsep karakter.
Tugasmu: ubah prompt itu menjadi JSON dengan field-field di bawah.

Field yang wajib dihasilkan:
{
  "user_name": "nama user yang masuk akal dari prompt, default 'Beni' jika tidak disebutkan",
  "user_gender": "male | female | neutral",
  "user_persona": "deskripsi singkat user yang pas dengan roleplay",
  "ai_name": "nama karakter AI",
  "ai_gender": "female | male | neutral",
  "ai_personality": "sifat karakter AI, pake 3-5 kata kunci",
  "language_style": "santai | profesional | ceplas_ceplos | absurd | kasar_imut | atau deskripsi custom",
  "target_ending": "target akhir cerita yang menarik"
}

Aturan:
1. Output HARUS JSON valid murni, tanpa markdown, tanpa teks lain.
2. Gunakan bahasa Indonesia.
3. Jika user tidak menyebutkan gender, default AI perempuan dan user laki-laki.
4. Buat karakter yang menarik dan koheren dengan prompt user.
5. Jangan mengarang fakta di luar prompt yang tidak masuk akal.`;

function extractJsonBlock(text) {
  // Look for a JSON object between fences or as standalone
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }
  return text.trim();
}

function parseGenerated(raw) {
  let cleaned = stripReasoningContent(raw);
  cleaned = extractJsonBlock(cleaned);
  return JSON.parse(cleaned);
}

router.post('/character', async (req, res, next) => {
  const prompt = (req.body?.prompt ?? '').toString().trim();
  if (!prompt) {
    return next(new HttpError(400, 'Prompt tidak boleh kosong.'));
  }
  if (prompt.length > MAX_GENERATOR_PROMPT) {
    return next(
      new HttpError(
        413,
        `Prompt melebihi ${MAX_GENERATOR_PROMPT} karakter. Sederhanakan dulu ide karakternya.`
      )
    );
  }

  // Provider config (.env) verified at boot by config/env.js — fail-fast.
  // No per-request key check needed.

  try {
    const raw = await chatCompletionOnce({
      messages: [
        { role: 'system', content: GENERATOR_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
    });

    let generated;
    try {
      generated = parseGenerated(raw);
    } catch (parseErr) {
      console.warn('[generator] Parse error:', parseErr.message, 'raw:', raw.slice(0, 200));
      return next(
        new HttpError(500, 'Gagal parse hasil generate karakter dari model.')
      );
    }

    res.json({
      success: true,
      data: normalizeGenerated(generated, prompt),
      message: 'Karakter berhasil digenerate.',
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    // No silent fallback: provider error → 5xx so user knows. Use:
    //   curl /api/health   to confirm env config
    //   edit .env          to fix provider
    console.warn('[generator] Provider error:', err.message);
    return next(
      new HttpError(
        502,
        `Generator gagal: provider tidak merespons. Cek .env (${err.message}).`
      )
    );
  }
});

function normalizeGenerated(raw, prompt) {
  const aiGender = ['female', 'male', 'neutral'].includes(raw.ai_gender) ? raw.ai_gender : 'female';
  const userGender = ['female', 'male', 'neutral'].includes(raw.user_gender) ? raw.user_gender : 'male';
  return {
    user_name: raw.user_name?.toString().trim() || 'Beni',
    user_gender: userGender,
    user_persona: raw.user_persona?.toString().trim() || `User biasa yang ingin roleplay dengan konsep ${prompt}.`,
    ai_name: raw.ai_name?.toString().trim() || 'Mika',
    ai_gender: aiGender,
    ai_personality: raw.ai_personality?.toString().trim() || 'baik hati, perhatian, santai',
    language_style: raw.language_style?.toString().trim() || 'santai',
    target_ending: raw.target_ending?.toString().trim() || 'berteman dekat',
  };
}

export default router;
