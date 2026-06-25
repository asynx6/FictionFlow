/**
 * POST /api/tts
 * Body: { text: string, voice?: string, gender?: 'male'|'female' }
 *   - text   : teks yang akan disintesis (wajib, non-empty)
 *   - voice  : nama voice Edge TTS (opsional, default id-ID-ArdiNeural)
 *   - gender : 'male' | 'female' untuk auto-pick voice kalau voice kosong
 * Response: audio/mpeg (MP3 Buffer)
 *
 * Frontend pakai: fetch → blob → new Audio(blob:url).play()
 * Voice mapping: male → "id-ID-ArdiNeural", female → "id-ID-GadisNeural"
 */

import { Router } from 'express';
import { synthesizeText, DEFAULT_VOICE_MALE, DEFAULT_VOICE_FEMALE } from '../services/edgeTts.service.js';
import { HttpError } from '../middlewares/errorHandler.js';

const router = Router();

function resolveVoice(body) {
  const explicit = (body?.voice ?? '').toString().trim();
  if (explicit) return explicit;
  const gender = (body?.gender ?? '').toString().toLowerCase();
  if (gender === 'female') return DEFAULT_VOICE_FEMALE;
  return DEFAULT_VOICE_MALE;
}

router.post('/', async (req, res, next) => {
  try {
    const text = (req.body?.text ?? '').toString().trim();
    if (!text) {
      return next(new HttpError(400, 'Field "text" wajib diisi.'));
    }
    if (text.length > 5000) {
      return next(new HttpError(413, 'Text terlalu panjang (max 5000 karakter).'));
    }

    const voice = resolveVoice(req.body);

    const buffer = await synthesizeText(text, voice);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Tts-Voice', voice);
    res.end(buffer);
  } catch (err) {
    console.warn('[tts] Synthesize gagal:', err.message);
    next(new HttpError(500, `TTS synthesis gagal: ${err.message}`));
  }
});

export default router;
