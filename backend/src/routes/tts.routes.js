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
import { synthesizeText, warmup, warmupVoice, DEFAULT_VOICE_MALE, DEFAULT_VOICE_FEMALE } from '../services/edgeTts.service.js';
import { HttpError } from '../middlewares/errorHandler.js';
import { env } from '../config/env.js';

const router = Router();

function resolveVoice(body) {
  const explicit = (body?.voice ?? '').toString().trim();
  if (explicit) return explicit;
  const gender = (body?.gender ?? '').toString().toLowerCase();
  if (gender === 'female') return DEFAULT_VOICE_FEMALE;
  return DEFAULT_VOICE_MALE;
}

// Voice allowlist per 2-pack hybrid TTS spec (Phase-2.4 deferred → promoted
// after audit). Voice di luar whitelist ditolak 400 agar upstream EdgeTTS
// tidak terima string sembarang (mencegah log spam 500 untuk typo atau
// probing). 4 suara: 2 Indonesian + 2 English US.
const ALLOWED_VOICES = new Set([
  DEFAULT_VOICE_MALE,
  DEFAULT_VOICE_FEMALE,
  'en-US-GuyNeural',
  'en-US-JennyNeural',
]);

function validateVoiceOrThrow(voice) {
  if (!ALLOWED_VOICES.has(voice)) {
    throw new HttpError(
      400,
      `Voice "${voice}" tidak dikenal. Pilih salah satu dari allowlist.`
    );
  }
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
    validateVoiceOrThrow(voice);

    const t0 = Date.now();
    const buffer = await synthesizeText(text, voice);
    const elapsed = Date.now() - t0;

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Tts-Voice', voice);
    res.setHeader('X-Tts-Elapsed-Ms', String(elapsed));
    res.setHeader('X-Tts-Cache', elapsed < 50 ? 'hit' : 'miss');
    if (env.NODE_ENV !== 'production') {
      console.log(`[tts] ${voice} len=${buffer.length}b ${elapsed}ms`);
    }
    res.end(buffer);
  } catch (err) {
    if (err.statusCode) return next(err);
    console.warn('[tts] Synthesize gagal:', err.message);
    next(new HttpError(500, `TTS synthesis gagal: ${err.message}`));
  }
});

/**
 * POST /api/tts/warmup
 * Body: { voice?: string } — kalau specified, warm single voice saja.
 * Kalau kosong, warm semua 4 default voices.
 *
 * Fire-and-forget. Response 202 Accepted immediately. Backend populate
 * memory cache di background; subsequent /api/tts calls akan hit cache
 * (< 50ms). Frontend panggil ini saat page load untuk消除 first-hit cold-
 * start latency (Edge TTS WebSocket auth + DNS + chunk assembly).
 */
router.post('/warmup', async (req, res, next) => {
  try {
    const voiceExplicit = (req.body?.voice ?? '').toString().trim();
    const wait = req.query.wait === 'true' || req.body?.wait === true;
    if (voiceExplicit) {
      validateVoiceOrThrow(voiceExplicit);
    }
    if (env.NODE_ENV !== 'production') {
      console.log(`[tts] warmup start: voice=${voiceExplicit || 'all'}${wait ? ' (sync)' : ''}`);
    }
    if (wait) {
      // Synchronous block — frontend bisa await ini untuk memastikan cache
      // populated sebelum menampilkan chat. Max wait = 25s (3 attempts × ~8s)
      // supaya UX tidak pernah hang.
      const warmPromise = voiceExplicit
        ? warmupVoice(voiceExplicit)
        : warmup();
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve('timeout'), 25000);
      });
      const status = await Promise.race([warmPromise, timeoutPromise]);
      res.json({
        success: true,
        data: { voice: voiceExplicit || 'all', ready: status !== 'timeout' },
        message: status === 'timeout' ? 'Warmup timeout (cache mungkin belum siap).' : 'Warmup selesai.',
      });
    } else {
      // Async fire-and-forget.
      if (voiceExplicit) {
        warmupVoice(voiceExplicit).catch(() => {});
      } else {
        warmup().catch(() => {});
      }
      res.status(202).json({
        success: true,
        data: { voice: voiceExplicit || 'all' },
        message: 'Warmup dimulai di background.',
      });
    }
  } catch (err) {
    if (err.statusCode) return next(err);
    console.warn('[tts] warmup gagal:', err.message);
    res.status(202).json({
      success: true,
      data: { ready: false },
      message: 'Warmup dimulai; check terpisah untuk status.',
    });
  }
});

export default router;
