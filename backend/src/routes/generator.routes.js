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

const GENERATOR_PROMPT = `Kamu adalah generator karakter roleplay SUPER JAGO untuk aplikasi FictionFlow.
User memberikan satu prompt singkat berisi ide/konsep karakter. Tugasmu: ubah
prompt itu menjadi JSON lengkap yang langsung bisa dipakai untuk membuat sesi
roleplay yang berkualitas tinggi. Pikirkan karakter sedalam-dalamnya: latar
belakang, dinamika psikologis, chemistry dengan user, dan potensi berkembang.

Field yang wajib dihasilkan (SEMUA menu story):
{
  "user_name": "nama user yang masuk akal dari prompt, default 'Beni' jika tidak disebut",
  "user_gender": "male | female | neutral",
  "user_persona": "deskripsi user 1-2 kalimat yang pas dengan roleplay (latar, sifat, posisi)",
  "ai_name": "nama karakter AI yang cocok dan mudah diingat",
  "ai_gender": "female | male | neutral",
  "ai_personality": "sifat karakter AI, 4-7 kata kunci dipisah koma. Buat SPESIFIK dan kontras (mis: 'tsundere, kakak kelas, jutek, sebenarnya perhatian, ambisius'). Hindari generik seperti 'baik hati'.",
  "language_style": "santai | profesional | ceplas_ceplos | absurd | kasar_imut | atau deskripsi custom yang pas",
  "target_ending": "target akhir cerita yang menarik dan emotionally satisfying",
  "roleplay_mode": "default | casual. default=dalang/narasi panjang, casual=AI ngobrol langsung kayak chat WA. Pilih yang paling cocok dengan vibe prompt.",
  "tts_voice": "id-ID-ArdiNeural (male ID) | id-ID-GadisNeural (female ID) | en-US-GuyNeural (male EN) | en-US-JennyNeural (female EN). Pilih sesuai gender AI + bahasa prompt.",
  "short_term_window": "integer 3-5, default 4. Berapa pertukaran terakhir yang AI ingat. 5 kalau roleplay kompleks.",
  "font_family": "serif | lora | slab | nunito | sans | system. Pilih mood baca yang pas (serif=klasik novel, sans=modern casual, dll).",
  "font_size": "integer 14-22, default 16. Sesuaikan kenyamanan baca."
}

Aturan MUTLAK:
1. Output HARUS JSON valid murni, tanpa markdown fence, tanpa teks lain.
2. Gunakan bahasa Indonesia untuk semua field deskriptif.
3. Jika user tidak sebut gender, default AI perempuan + user laki-laki.
4. ai_personality WAJIB spesifik dan kontras — itulah yang bikin karakter hidup.
  Pikirkan: apa yang membuat karakter ini unik? Kelemahan? Kontradiksi menarik?
5. ai_name: nama yang authentic untuk setting prompt (Jepang kalau setting anime,
  Barat kalau setting fantasy barat, dst). Bukan generik.
6. target_ending: bukan generic 'bahagia', tapi emotional payoff spesifik cerita ini.
7. Pilih tts_voice sesuai gender AI (male voice kalau AI male, female kalau female).
8. Pilih roleplay_mode: casual kalau prompt implies chat/relasi dekat, default kalau
  narasi panjang/adventure/dunia cerita kompleks.
9. Koheren SEMUA field: gender, voice, personality, mode, font harus saling reinforce.
10. Jangan mengarang fakta di luar prompt yang tidak masuk akal.

Contoh input: "cewek tsundere kakak kelas di sekolah elite"
Contoh output:
{"user_name":"Beni","user_gender":"male","user_persona":"Murid pindahan kelas 1 yang pendiam tapi observan, sering di-bully ringan karena beda.","ai_name":"Reina","ai_gender":"female","ai_personality":"tsundere, kakak kelas, ketua OSIS, jutek tapi overprotective, perfeksionis, sebenarnya canggung soal perasaan","language_style":"kasar_imut","target_ending":"Reina akhirnya jujur soal perasaannya di hari kelulusan, di bawah pohon sakura","roleplay_mode":"default","tts_voice":"id-ID-GadisNeural","short_term_window":5,"font_family":"serif","font_size":16}`;

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

// ponytail: no auth/rate-limit on this provider-invoking endpoint — assumes
// self-hosted localhost-only binding (single-user). If the port is ever exposed
// externally, add a shared-secret header or localhost-only bind + throttle to
// prevent unbounded paid provider LLM calls (TEMUAN-054).
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

const ALLOWED_TTS_VOICES = new Set(['id-ID-ArdiNeural', 'id-ID-GadisNeural', 'en-US-GuyNeural', 'en-US-JennyNeural']);
const ALLOWED_FONT_FAMILIES = new Set(['serif', 'lora', 'slab', 'nunito', 'sans', 'system']);

function normalizeGenerated(raw, prompt) {
  const aiGender = ['female', 'male', 'neutral'].includes(raw.ai_gender) ? raw.ai_gender : 'female';
  const userGender = ['female', 'male', 'neutral'].includes(raw.user_gender) ? raw.user_gender : 'male';
  const roleplayMode = ['default', 'casual'].includes(raw.roleplay_mode) ? raw.roleplay_mode : 'default';
  // Default voice from AI gender; validate if model supplied one.
  const defaultVoice = aiGender === 'male' ? 'id-ID-ArdiNeural' : 'id-ID-GadisNeural';
  const ttsVoice = ALLOWED_TTS_VOICES.has(raw.tts_voice) ? raw.tts_voice : defaultVoice;
  const fontFamily = ALLOWED_FONT_FAMILIES.has(raw.font_family) ? raw.font_family : 'serif';
  const fontSizeRaw = Number.parseInt(raw.font_size, 10);
  const fontSize = Number.isFinite(fontSizeRaw) && fontSizeRaw >= 14 && fontSizeRaw <= 22 ? fontSizeRaw : 16;
  const windowRaw = Number.parseInt(raw.short_term_window, 10);
  const shortTermWindow = Number.isFinite(windowRaw) && windowRaw >= 3 && windowRaw <= 5 ? windowRaw : 4;
  return {
    user_name: raw.user_name?.toString().trim() || 'Beni',
    user_gender: userGender,
    user_persona: raw.user_persona?.toString().trim() || `User biasa yang ingin roleplay dengan konsep ${prompt}.`,
    ai_name: raw.ai_name?.toString().trim() || 'Mika',
    ai_gender: aiGender,
    ai_personality: raw.ai_personality?.toString().trim() || 'baik hati, perhatian, santai',
    language_style: raw.language_style?.toString().trim() || 'santai',
    target_ending: raw.target_ending?.toString().trim() || 'berteman dekat',
    roleplay_mode: roleplayMode,
    tts_voice: ttsVoice,
    short_term_window: shortTermWindow,
    font_family: fontFamily,
    font_size: fontSize,
  };
}

export default router;
