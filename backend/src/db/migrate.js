/**
 * Runtime schema migration untuk FictionFlow.
 *
 * Karena CREATE TABLE IF NOT EXISTS tidak bisa menambah kolom baru
 * ke tabel yang sudah ada, kita pakai pola pragma user_version:
 * - Baca versi saat ini
 * - Jalankan ALTER TABLE yang sesuai untuk naik versi
 * - Set pragma ke versi baru
 *
 * Idempotent: aman dipanggil setiap kali app boot.
 */

const MIGRATIONS = [
  {
    version: 2,
    description: 'Add user_gender, ai_gender, dynamic_memory columns',
    up: (db) => {
      const hasColumn = (table, column) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        return cols.some((c) => c.name === column);
      };

      const addColumnIfMissing = (table, column, definition) => {
        if (!hasColumn(table, column)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      };

      addColumnIfMissing('stories', 'user_gender', "TEXT DEFAULT 'unspecified'");
      addColumnIfMissing('stories', 'ai_gender', "TEXT DEFAULT 'neutral'");
      addColumnIfMissing('stories', "dynamic_memory", "TEXT DEFAULT '[]'");
    },
  },
  {
    version: 3,
    description: 'Add tts_voice column (per-story voice pack choice)',
    up: (db) => {
      const hasColumn = (table, column) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        return cols.some((c) => c.name === column);
      };
      if (!hasColumn('stories', 'tts_voice')) {
        // DEFAULT clause backfills existing rows otomatis.
        db.exec("ALTER TABLE stories ADD COLUMN tts_voice TEXT NOT NULL DEFAULT 'id-ID-ArdiNeural'");
      }
    },
  },
  {
    version: 4,
    description: 'Add avatar_url + avatar_enabled columns (per-story profile picture)',
    up: (db) => {
      const hasColumn = (table, column) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        return cols.some((c) => c.name === column);
      };
      if (!hasColumn('stories', 'avatar_url')) {
        db.exec('ALTER TABLE stories ADD COLUMN avatar_url TEXT');
      }
      if (!hasColumn('stories', 'avatar_enabled')) {
        // 0 = disabled (fallback to initial letter), 1 = pakai URL.
        db.exec('ALTER TABLE stories ADD COLUMN avatar_enabled INTEGER NOT NULL DEFAULT 0');
      }
    },
  },
  {
    version: 5,
    description: 'Add font_family + font_size columns (per-story reading preferences)',
    up: (db) => {
      const hasColumn = (table, column) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        return cols.some((c) => c.name === column);
      };
      if (!hasColumn('stories', 'font_family')) {
        // Default 'serif' (Crimson Pro) — sesuai FONT_FAMILY_DEFAULT frontend.
        db.exec("ALTER TABLE stories ADD COLUMN font_family TEXT NOT NULL DEFAULT 'serif'");
      }
      if (!hasColumn('stories', 'font_size')) {
        // Default 16 — sesuai FONT_SIZE_DEFAULT frontend.
        db.exec('ALTER TABLE stories ADD COLUMN font_size INTEGER NOT NULL DEFAULT 16');
      }
    },
  },
  {
    version: 6,
    description: 'Add roleplay_mode column (dual prompt mode: default/casual)',
    up: (db) => {
      const hasColumn = (table, column) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        return cols.some((c) => c.name === column);
      };
      if (!hasColumn('stories', 'roleplay_mode')) {
        db.exec("ALTER TABLE stories ADD COLUMN roleplay_mode TEXT NOT NULL DEFAULT 'default'");
      }
    },
  },
  {
    version: 7,
    description: 'Add memory_prev column (server-side pre-update snapshot for rollback)',
    up: (db) => {
      const hasColumn = (table, column) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        return cols.some((c) => c.name === column);
      };
      if (!hasColumn('stories', 'memory_prev')) {
        // Holds the dynamic_memory value captured just before the last extractor
        // write, so rollback can restore server-side without relying on a
        // client-supplied snapshot (TEMUAN-019/024/030).
        db.exec("ALTER TABLE stories ADD COLUMN memory_prev TEXT DEFAULT NULL");
      }
    },
  },
];

export function runMigrations(db) {
  const currentVersion = db.pragma('user_version', { simple: true }) ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      try {
        const tx = db.transaction(() => {
          migration.up(db);
          db.pragma(`user_version = ${migration.version}`);
        });
        tx();
        console.log(
          `[migrate] v${currentVersion} -> v${migration.version}: ${migration.description}`
        );
      } catch (err) {
        console.error(`[migrate] Gagal migrasi v${migration.version}:`, err.message);
        throw err;
      }
    }
  }
}
