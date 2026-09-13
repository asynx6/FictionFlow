// Label tampilan untuk nilai enum yang disimpan di DB.
// Dipakai dashboard & story page — SATU sumber biar nggak drift.
//
// Fallback sadar: baris lama bisa menyimpan label teksnya langsung, bukan key
// enum. Tapi lookup HARUS pakai Object.hasOwn — map[value] polos bisa kena
// inherited property (`toString`, `constructor`, `__proto__`), yang kalau
// value-nya user-controlled nyuntik fungsi/objek ke HTML (XSS/prototype lookup).

export const GENDER_LABELS = { male: 'Laki-laki', female: 'Perempuan', neutral: 'Netral' };

export const LANGUAGE_STYLE_LABELS = {
  santai: 'Santai & Asik',
  ceplas_ceplos: 'Blak-blakan & To the point',
  absurd: 'Kocak & Absurd',
  kasar_imut: 'Kasar tapi Imut (Tsundere)',
  profesional: 'Profesional & Sopan',
};

export const GENDER_ICONS = { male: 'male', female: 'female', neutral: 'person' };

/**
 * Ambil label aman dari map. Nilai tak dikenal dikembalikan sebagai
 * string-nya (dipanggil dari konteks yang me-escape output), undefined → ''.
 *
 * KONTRAK: semua call-site WAJIB menaruh hasil di innerText / escaped
 * template. Jangan pernah selipkan hasil labelFor ke innerHTML mentah.
 */
export function labelFor(map, value) {
  if (typeof value !== 'string') return '';
  return Object.hasOwn(map, value) ? map[value] : value;
}
