/**
 * Util serialize timestamp dari SQLite row → ISO UTC string.
 *
 * Latar belakang bug: SQLite kolom DATETIME di-isi oleh `CURRENT_TIMESTAMP`
 * yang menyimpan string `'YYYY-MM-DD HH:MM:SS'` dalam **UTC** tanpa zona.
 * better-sqlite3 mengembalikan string persis seperti itu ke JS. Saat frontend
 * `new Date("2026-06-27 04:23:00")` parse, spesifikasi ECMAScript treat
 * format tanpa offset sebagai **local time** → Date.now() vs timestamp selisih
 * 7 jam (atau sesuai offset server).
 *
 * Fix: kalau string tidak punya timezone marker (Z atau ±HH:MM), treat sebagai
 * UTC → emit ISO dengan suffix 'Z' supaya frontend selalu parse benar di
 * semua zona waktu.
 *
 * Fungsi ini idempotent: kalau input sudah punya suffix Z, output tetap
 * valid ISO. Kalau null/undefined → null.
 */

const ISO_WITH_OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse nilai timestamp dari SQLite (string 'YYYY-MM-DD HH:MM:SS' atau
 * string ISO lengkap) jadi Date object UTC. Return null kalau invalid.
 */
export function parseSqliteTimestamp(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    // better-sqlite3 bisa return Date object kalau mode=integer diaktifkan,
    // tapi default kita string. Tetap defensif.
    return value;
  }
  const s = String(value).trim();
  if (!s) return null;
  // Replace space dengan 'T' supaya Date parser ISO-friendly.
  const normalized = ISO_WITH_OFFSET_RE.test(s)
    ? s
    : s.includes(' ')
      ? s.replace(' ', 'T') + 'Z'
      : s + 'Z';
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Serialize satu nilai timestamp jadi ISO UTC string. Return null untuk null.
 */
export function toIsoUtc(value) {
  const date = parseSqliteTimestamp(value);
  return date ? date.toISOString() : null;
}

const TIMESTAMP_FIELDS = new Set([
  'created_at',
  'updated_at',
  'synthesized_at',
  'learned_at',
]);

/**
 * Map semua timestamp fields di row jadi ISO UTC. Tidak mutate input.
 */
export function normalizeTimestamps(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const key of Object.keys(out)) {
    if (TIMESTAMP_FIELDS.has(key)) {
      const iso = toIsoUtc(out[key]);
      if (iso !== null) out[key] = iso;
    }
  }
  return out;
}

/**
 * Map array of rows. Bukan deep — treat rows flat.
 */
export function normalizeTimestampsInList(rows) {
  if (!Array.isArray(rows)) return rows ?? [];
  return rows.map(normalizeTimestamps);
}
