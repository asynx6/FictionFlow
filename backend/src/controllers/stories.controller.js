import { randomUUID } from 'node:crypto';
import db from '../db/database.js';
import {
  seedVoicePresetsForStory,
  validateLanguageStyle,
  normalizeAiGender,
  normalizeUserGender,
} from '../db/seed.js';
import { HttpError } from '../middlewares/errorHandler.js';
import { env } from '../config/env.js';
import { normalizeTimestamps, normalizeTimestampsInList } from '../util/time.js';

const insertStoryStmt = db.prepare(`
  INSERT INTO stories (
    id, title, user_name, user_persona, user_gender,
    ai_name, ai_gender, ai_personality,
    language_style, target_ending, active_model_id, short_term_window,
    avatar_url, avatar_enabled
  ) VALUES (
    @id, @title, @user_name, @user_persona, @user_gender,
    @ai_name, @ai_gender, @ai_personality,
    @language_style, @target_ending, @active_model_id, @short_term_window,
    @avatar_url, @avatar_enabled
  )
`);

const getStoryStmt = db.prepare(`
  SELECT * FROM stories WHERE id = ? AND is_archived = 0
`);

const listStoriesStmt = db.prepare(`
  SELECT id, title, ai_name, ai_gender, ai_personality, user_name, user_gender, language_style, updated_at, created_at, avatar_url, avatar_enabled
  FROM stories
  WHERE is_archived = 0
  ORDER BY updated_at DESC
`);

const archiveStoryStmt = db.prepare(`
  UPDATE stories SET is_archived = 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const deleteStoryStmt = db.prepare(`
  DELETE FROM stories WHERE id = ?
`);

const deleteMessagesStmt = db.prepare(`
  DELETE FROM messages WHERE story_id = ?
`);

// 4 Edge TTS voices allowed per-story. Match dengan frontend dropdown.
const ALLOWED_TTS_VOICES = new Set([
  'id-ID-ArdiNeural',   // Indonesian male (default)
  'id-ID-GadisNeural',  // Indonesian female
  'en-US-GuyNeural',    // English (US) male
  'en-US-JennyNeural',  // English (US) female
]);
const DEFAULT_TTS_VOICE = 'id-ID-ArdiNeural';

function validateTtsVoiceOrThrow(voice) {
  if (!ALLOWED_TTS_VOICES.has(voice)) {
    throw new HttpError(
      400,
      `tts_voice "${voice}" tidak dikenal. Pilih salah satu: ${[...ALLOWED_TTS_VOICES].join(', ')}.`
    );
  }
}

const STORY_EDITABLE = [
  'title',
  'user_name',
  'user_persona',
  'user_gender',
  'ai_name',
  'ai_gender',
  'ai_personality',
  'language_style',
  'target_ending',
  'active_model_id',
  'short_term_window',
  'tts_voice',
  'avatar_url',
  'avatar_enabled',
];

const STORY_FIELD_MAX_LENGTH = {
  title: 200,
  user_name: 80,
  user_persona: 1000,
  ai_name: 80,
  ai_personality: 500,
  language_style: 80,
  target_ending: 1000,
  avatar_url: 2048,
};

function clampWindow(value) {
  const n = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(n)) return env.DEFAULT_SHORT_TERM_WINDOW;
  return Math.min(5, Math.max(3, n));
}

// Avatar URL: harus http/https, max 2048 char, tidak boleh ada karakter
// kontrol. Kalau tidak valid → null. Caller (update payload handler) yang
// memutuskan auto-disable saat url kosong.
function sanitizeAvatarUrl(value) {
  if (value == null) return null;
  const trimmed = value.toString().trim();
  if (!trimmed) return null;
  if (trimmed.length > 2048) {
    throw new HttpError(413, 'Field "avatar_url" melebihi panjang maksimum (2048 karakter).');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(400, 'Field "avatar_url" harus berupa URL valid (http/https).');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'Field "avatar_url" harus protokol http atau https.');
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HttpError(400, 'Field "avatar_url" mengandung karakter tidak valid.');
  }
  return parsed.toString();
}

function coerceBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.toLowerCase().trim();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }
  return false;
}

function validateCreatePayload(body) {
  const required = [
    'user_name',
    'ai_name',
    'ai_personality',
    'language_style',
  ];
  for (const key of required) {
    if (!body?.[key] || typeof body[key] !== 'string' || !body[key].trim()) {
      throw new HttpError(400, `Field "${key}" wajib diisi.`);
    }
  }
  if (!validateLanguageStyle(body.language_style)) {
    throw new HttpError(400, 'language_style tidak dikenal.');
  }
}

export function createStory(req, res) {
  validateCreatePayload(req.body);
  const createRaw = {
    title: req.body.title?.toString(),
    user_name: req.body.user_name?.toString(),
    user_persona: req.body.user_persona?.toString(),
    ai_name: req.body.ai_name?.toString(),
    ai_personality: req.body.ai_personality?.toString(),
    target_ending: req.body.target_ending?.toString(),
  };
  for (const [key, raw] of Object.entries(createRaw)) {
    if (raw === undefined) continue;
    const cap = STORY_FIELD_MAX_LENGTH[key];
    if (raw.length > cap) {
      throw new HttpError(413, `Field "${key}" melebihi panjang maksimum (${cap} karakter).`);
    }
  }
  const id = randomUUID();
  const aiName = req.body.ai_name.trim();
  const aiGender = normalizeAiGender(req.body.ai_gender);
  const userGender = normalizeUserGender(req.body.user_gender);
  const title = (req.body.title?.toString().trim()) || `Cerita dengan ${aiName}`;

  const avatarEnabled = body.avatar_enabled === true || body.avatar_enabled === 1 ||
    (typeof body.avatar_enabled === 'string' && ['1','true','yes','on'].includes(body.avatar_enabled.toLowerCase()));
  const avatarUrl = avatarEnabled ? sanitizeAvatarUrl(body.avatar_url) : null;

  const row = {
    id,
    title,
    user_name: req.body.user_name.trim(),
    user_persona: req.body.user_persona?.toString().trim() || null,
    user_gender: userGender,
    ai_name: aiName,
    ai_gender: aiGender,
    ai_personality: req.body.ai_personality.trim(),
    language_style: req.body.language_style,
    target_ending: req.body.target_ending?.toString().trim() || null,
    active_model_id: req.body.active_model_id?.toString().trim() || env.DEFAULT_MODEL_ID,
    short_term_window: clampWindow(req.body.short_term_window ?? env.DEFAULT_SHORT_TERM_WINDOW),
    avatar_url: avatarUrl,
    avatar_enabled: avatarEnabled && avatarUrl ? 1 : 0,
  };

  insertStoryStmt.run(row);
  seedVoicePresetsForStory(id, aiName, aiGender);

  const story = getStoryStmt.get(id);
  res.status(201).json({
    success: true,
    data: { story_id: id, story: normalizeTimestamps(story) },
    message: 'Story berhasil dibuat.',
    meta: { timestamp: new Date().toISOString() },
  });
}

export function listStories(_req, res) {
  const rawStories = listStoriesStmt.all();
  // Serialize `updated_at`/`created_at` ke ISO UTC (suffix 'Z'). SQLite
  // CURRENT_TIMESTAMP tidak menulis zona sehingga frontend parser.Date()
  // treat sebagai lokal → drift sampai 24 jam tergantung TZ. Fix di sini.
  const stories = normalizeTimestampsInList(rawStories);
  res.json({
    success: true,
    data: { stories },
    message: 'OK',
    meta: { count: stories.length, timestamp: new Date().toISOString() },
  });
}

export function getStory(req, res) {
  const story = getStoryStmt.get(req.params.id);
  if (!story) throw new HttpError(404, 'Story tidak ditemukan.');
  res.json({
    success: true,
    data: { story: normalizeTimestamps(story) },
    message: 'OK',
    meta: { timestamp: new Date().toISOString() },
  });
}

function buildUpdate(fields) {
  const sets = [];
  const params = { id: fields.id };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'id') continue;
    sets.push(`${key} = @${key}`);
    params[key] = value;
  }
  if (sets.length === 0) return null;
  const sql = `UPDATE stories SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND is_archived = 0`;
  return { stmt: db.prepare(sql), params };
}

export function updateStory(req, res) {
  const existing = getStoryStmt.get(req.params.id);
  if (!existing) throw new HttpError(404, 'Story tidak ditemukan.');

  const provided = {};
  for (const key of STORY_EDITABLE) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      provided[key] = req.body[key];
    }
  }

  if (Object.keys(provided).length === 0) {
    throw new HttpError(400, 'Tidak ada field yang dikirim untuk diperbarui.');
  }

  if (provided.language_style !== undefined && !validateLanguageStyle(provided.language_style)) {
    throw new HttpError(400, 'language_style tidak dikenal.');
  }
  if (provided.ai_gender !== undefined) {
    provided.ai_gender = normalizeAiGender(provided.ai_gender);
  }
  if (provided.user_gender !== undefined) {
    provided.user_gender = normalizeUserGender(provided.user_gender);
  }
  if (provided.short_term_window !== undefined) {
    provided.short_term_window = clampWindow(provided.short_term_window);
  }
  if (provided.tts_voice !== undefined) {
    if (typeof provided.tts_voice !== 'string') {
      throw new HttpError(400, 'Field "tts_voice" harus berupa string.');
    }
    const trimmedVoice = provided.tts_voice.trim();
    validateTtsVoiceOrThrow(trimmedVoice);
    provided.tts_voice = trimmedVoice;
  }
  // Avatar pipeline: kalau payload membawa avatar_url, sanitize dulu. Kalau
  // user enable toggle tapi URL kosong/invalid → auto-disable supaya tidak
  // ada state gabungan (enabled=1 tanpa url) yang bikin frontend render
  // broken image.
  let sanitizedAvatarUrl = undefined;
  if (provided.avatar_url !== undefined) {
    sanitizedAvatarUrl = sanitizeAvatarUrl(provided.avatar_url);
    provided.avatar_url = sanitizedAvatarUrl;
  }
  let incomingEnabled;
  if (provided.avatar_enabled !== undefined) {
    incomingEnabled = coerceBool(provided.avatar_enabled);
    provided.avatar_enabled = incomingEnabled ? 1 : 0;
  }

  for (const [key, raw] of Object.entries(provided)) {
    if (key === 'short_term_window' || key === 'ai_gender' || key === 'user_gender') continue;
    if (key === 'tts_voice') continue; // sudah divalidasi whitelist di atas
    if (key === 'avatar_enabled') continue; // sudah dicoerce di atas
    if (key === 'avatar_url') continue; // sudah disanitize di atas
    if (typeof raw !== 'string') {
      throw new HttpError(400, `Field "${key}" harus berupa string.`);
    }
    const cap = STORY_FIELD_MAX_LENGTH[key];
    if (cap && raw.length > cap) {
      throw new HttpError(413, `Field "${key}" melebihi panjang maksimum (${cap} karakter).`);
    }
    provided[key] = raw.trim();
  }

  // Invariant: avatar_enabled=1 hanya boleh jika avatar_url ada. Kalau user
  // mengirim enabled=true tapi url tidak dikirim atau kosong → paksa off.
  // Akibatnya di frontend: UI tidak boleh menyimpan kombinasi ini, dan di
  // backend kita tetap enforces supaya konsisten.
  const finalEnabled = provided.avatar_enabled ?? existing.avatar_enabled ?? 0;
  const finalUrl = provided.avatar_url !== undefined ? provided.avatar_url : (existing.avatar_url ?? null);
  if (finalEnabled === 1 && !finalUrl) {
    provided.avatar_enabled = 0;
    if (provided.avatar_url === undefined) {
      // existing.avatar_url kosong juga — clear any pending undefined.
      provided.avatar_url = null;
    }
  }

  const built = buildUpdate({ id: req.params.id, ...provided });
  if (built) {
    built.stmt.run(built.params);
  }

  const story = getStoryStmt.get(req.params.id);
  res.json({
    success: true,
    data: { story: normalizeTimestamps(story) },
    message: 'Story diperbarui.',
    meta: { timestamp: new Date().toISOString() },
  });
}

export function deleteStory(req, res) {
  const id = req.params.id;
  const result = archiveStoryStmt.run(id);
  if (result.changes === 0) throw new HttpError(404, 'Story tidak ditemukan.');
  res.json({
    success: true,
    data: { id },
    message: 'Story diarsipkan.',
    meta: { timestamp: new Date().toISOString() },
  });
}

export function hardDeleteStory(req, res) {
  const id = req.params.id;
  // Delete messages first, then story, to maintain FK cleanliness if FK added later.
  deleteMessagesStmt.run(id);
  const result = deleteStoryStmt.run(id);
  if (result.changes === 0) throw new HttpError(404, 'Story tidak ditemukan.');
  res.json({
    success: true,
    data: { id },
    message: 'Story dan semua pesannya dihapus permanen.',
    meta: { timestamp: new Date().toISOString() },
  });
}
