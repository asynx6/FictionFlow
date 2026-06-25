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
