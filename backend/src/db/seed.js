import db from './database.js';

const LANGUAGE_STYLES = new Set(['santai', 'ceplas_ceplos', 'absurd', 'kasar_imut']);
const GENDER_HINTS = new Set(['male', 'female', 'neutral', 'other']);
const AI_GENDERS = new Set(['male', 'female', 'neutral', 'other']);
const USER_GENDERS = new Set(['male', 'female', 'other', 'unspecified']);

const AI_PRESETS_BY_GENDER = {
  female: { pitch: 1.45, rate: 1.05, voice: 'Google Bahasa Indonesia' },
  male: { pitch: 0.9, rate: 1.0, voice: 'Google Bahasa Indonesia' },
  neutral: { pitch: 1.0, rate: 1.0, voice: 'Google Bahasa Indonesia' },
  other: { pitch: 1.1, rate: 1.0, voice: 'Google Bahasa Indonesia' },
};

const USER_PRESETS_BY_GENDER = {
  male: { pitch: 0.85, rate: 1.0 },
  female: { pitch: 1.25, rate: 1.0 },
  other: { pitch: 1.0, rate: 1.0 },
  unspecified: { pitch: 1.0, rate: 1.0 },
};

export function validateLanguageStyle(value) {
  // Always accept any string for custom language styles.
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateGenderHint(value) {
  return GENDER_HINTS.has(value);
}

export function validateAiGender(value) {
  return AI_GENDERS.has(value);
}

export function validateUserGender(value) {
  return USER_GENDERS.has(value);
}

export function normalizeAiGender(value) {
  return validateAiGender(value) ? value : 'neutral';
}

export function normalizeUserGender(value) {
  return validateUserGender(value) ? value : 'unspecified';
}

export function buildDefaultVoicePresets(aiName, aiGender) {
  const aiTag = (aiName || 'AI').toUpperCase();
  const aiPreset = AI_PRESETS_BY_GENDER[aiGender] ?? AI_PRESETS_BY_GENDER.neutral;
  const userPreset = USER_PRESETS_BY_GENDER.unspecified;

  return [
    {
      tag_name: 'NARASI',
      voice_uri_hint: aiPreset.voice,
      pitch: 1.0,
      rate: 0.95,
      gender_hint: 'neutral',
    },
    {
      tag_name: 'USER',
      voice_uri_hint: aiPreset.voice,
      pitch: userPreset.pitch,
      rate: userPreset.rate,
      gender_hint: 'neutral',
    },
    {
      tag_name: aiTag,
      voice_uri_hint: aiPreset.voice,
      pitch: aiPreset.pitch,
      rate: aiPreset.rate,
      gender_hint: aiGender && GENDER_HINTS.has(aiGender) ? aiGender : 'neutral',
    },
  ];
}

const insertPresetStmt = db.prepare(`
  INSERT OR IGNORE INTO voice_presets
    (story_id, tag_name, voice_uri_hint, pitch, rate, gender_hint)
  VALUES
    (@story_id, @tag_name, @voice_uri_hint, @pitch, @rate, @gender_hint)
`);

export function seedVoicePresetsForStory(storyId, aiName, aiGender) {
  const presets = buildDefaultVoicePresets(aiName, aiGender);
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      insertPresetStmt.run({ story_id: storyId, ...row });
    }
  });
  tx(presets);
  return presets;
}
