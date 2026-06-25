-- =========================================================
-- FictionFlow schema (SQLite)
-- Definisi lihat FictionFlow.md Bab 5.
-- =========================================================

-- Wadah utama satu playthrough/cerita.
-- Bagian LONG-TERM MEMORY adalah Fakta Absolut: tidak pernah
-- dihapus otomatis, hanya bisa diedit manual oleh user.
CREATE TABLE IF NOT EXISTS stories (
    id                 TEXT PRIMARY KEY,
    title              TEXT NOT NULL,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- ====== LONG-TERM MEMORY (Tipe 1) ======
    user_name          TEXT NOT NULL,
    user_persona       TEXT,
    user_gender        TEXT DEFAULT 'unspecified',
    ai_name            TEXT NOT NULL,
    ai_gender          TEXT DEFAULT 'neutral',
    ai_personality     TEXT NOT NULL,
    language_style     TEXT NOT NULL,
    target_ending      TEXT NOT NULL,

    -- ====== Dynamic memory (Type 1.5) ======
    -- JSON array: [{ key, value, category, learned_at }]
    -- Diisi otomatis oleh memoryExtractor setelah setiap pertukaran chat.
    -- Diedit/dihapus hanya oleh user (tidak di-override AI).
    dynamic_memory     TEXT DEFAULT '[]',

    -- ====== Preferensi operasional ======
    active_model_id    TEXT NOT NULL DEFAULT 'openrouter/auto',
    short_term_window  INTEGER NOT NULL DEFAULT 4,

    is_archived        INTEGER NOT NULL DEFAULT 0
);

-- Riwayat percakapan PENUH. TIDAK pernah dipangkas dari DB.
-- Hanya N pesan terakhir yang dipakai untuk context window AI.
CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id        TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK(role IN ('user','assistant')),
    raw_content     TEXT NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    token_estimate  INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_story_created
    ON messages(story_id, created_at);

-- Mapping tag karakter -> konfigurasi suara, per-story.
CREATE TABLE IF NOT EXISTS voice_presets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id        TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    tag_name        TEXT NOT NULL,
    voice_uri_hint  TEXT,
    pitch           REAL NOT NULL DEFAULT 1.0,
    rate            REAL NOT NULL DEFAULT 1.0,
    gender_hint     TEXT CHECK(gender_hint IN ('male','female','neutral','other')),
    UNIQUE(story_id, tag_name)
);
