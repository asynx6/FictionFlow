import { Router } from 'express';
import db from '../db/database.js';
import { HttpError } from '../middlewares/errorHandler.js';
import { validateGenderHint } from '../db/seed.js';

const router = Router({ mergeParams: true });

const getStoryStmt = db.prepare(`
  SELECT * FROM stories WHERE id = ? AND is_archived = 0
`);

const listPresetsStmt = db.prepare(`
  SELECT id, story_id, tag_name, voice_uri_hint, pitch, rate, gender_hint
  FROM voice_presets
  WHERE story_id = ?
  ORDER BY id ASC
`);

const getPresetStmt = db.prepare(`
  SELECT id, story_id, tag_name, voice_uri_hint, pitch, rate, gender_hint
  FROM voice_presets
  WHERE story_id = ? AND tag_name = ?
`);

const updatePresetStmt = db.prepare(`
  UPDATE voice_presets SET
    voice_uri_hint = COALESCE(@voice_uri_hint, voice_uri_hint),
    pitch          = COALESCE(@pitch, pitch),
    rate           = COALESCE(@rate, rate),
    gender_hint    = COALESCE(@gender_hint, gender_hint)
  WHERE story_id = @story_id AND tag_name = @tag_name
`);

router.use((req, res, next) => {
  const story = getStoryStmt.get(req.params.id);
  if (!story) return next(new HttpError(404, 'Story tidak ditemukan.'));
  next();
});

router.get('/', (req, res) => {
  const presets = listPresetsStmt.all(req.params.id);
  res.json({
    success: true,
    data: { presets },
    message: 'OK',
    meta: { count: presets.length, timestamp: new Date().toISOString() },
  });
});

router.put('/:tag', (req, res) => {
  const tag = req.params.tag;
  const existing = getPresetStmt.get(req.params.id, tag);
  if (!existing) throw new HttpError(404, `Preset untuk tag "${tag}" tidak ditemukan.`);

  const patch = {
    story_id: req.params.id,
    tag_name: tag,
    voice_uri_hint: req.body?.voice_uri_hint ?? null,
    pitch: req.body?.pitch !== undefined ? Number(req.body.pitch) : null,
    rate: req.body?.rate !== undefined ? Number(req.body.rate) : null,
    gender_hint: req.body?.gender_hint ?? null,
  };

  if (patch.pitch !== null && (Number.isNaN(patch.pitch) || patch.pitch < 0 || patch.pitch > 2)) {
    throw new HttpError(400, 'pitch harus angka 0..2.');
  }
  if (patch.rate !== null && (Number.isNaN(patch.rate) || patch.rate < 0.1 || patch.rate > 10)) {
    throw new HttpError(400, 'rate harus angka 0.1..10.');
  }
  if (patch.gender_hint !== null && !validateGenderHint(patch.gender_hint)) {
    throw new HttpError(400, 'gender_hint harus male/female/neutral.');
  }

  updatePresetStmt.run(patch);
  const preset = getPresetStmt.get(req.params.id, tag);
  res.json({
    success: true,
    data: { preset },
    message: 'Preset diperbarui.',
    meta: { timestamp: new Date().toISOString() },
  });
});

export default router;
