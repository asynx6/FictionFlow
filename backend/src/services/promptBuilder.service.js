const LANGUAGE_STYLE_INSTRUCTIONS = {
  santai:
    'Gunakan bahasa sehari-hari yang hangat dan rileks, hindari kata baku formal.',
  ceplas_ceplos:
    'Gunakan bahasa to-the-point, blak-blakan, tanpa basa-basi berlebihan.',
  absurd:
    'Selipkan humor absurd/komedi tak terduga dalam narasi maupun dialog.',
  kasar_imut:
    'Gunakan nada ketus/julid yang playful (bukan menyakiti sungguhan), ' +
    'dipadukan ekspresi imut/menggemaskan.',
};

const GENDER_LABELS = {
  male: 'pria',
  female: 'wanita',
  neutral: 'netral/tidak spesifik',
  other: 'lainnya/non-biner',
  unspecified: 'tidak disebutkan',
};

const GENDER_INSTRUCTIONS = {
  male: 'Untuk User: panggil ia dengan maskulin (mas, kak, bang, dia, "kamu"-nya laki-laki, dsb). Untuk AI sendiri: konsisten gender maskulin saat self-reference.',
  female: 'Untuk User: panggil ia dengan feminim (mbak, dik, non, dia, "kamu"-nya perempuan, dsb). Untuk AI sendiri: konsisten gender feminim saat self-reference.',
  other: 'Gunakan panggilan netral ("kamu", nama langsung, sebutan inklusif) untuk semua pihak.',
  unspecified: 'Gunakan panggilan netral ("kamu", nama langsung). Jangan asumsikan gender.',
  neutral: 'Karakter AI gender-nya netral/ambigu, gunakan panggilan netral saat self-reference.',
};

const FACT_CATEGORY_LABELS = {
  user: 'Tentang User',
  ai: 'Tentang AI',
  world: 'Tentang Dunia Cerita',
  relationship: 'Tentang Hubungan',
};

function safeParseJsonArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function languageStyleInstruction(style) {
  if (LANGUAGE_STYLE_INSTRUCTIONS[style]) {
    return LANGUAGE_STYLE_INSTRUCTIONS[style];
  }
  if (style === 'profesional') {
    return 'Gunakan bahasa formal, sopan, profesional, terstruktur, dan elegan layaknya di lingkungan kerja/bisnis kelas atas.';
  }
  return `Gunakan gaya bahasa ini: "${style}". Sesuaikan kosakata dan nada bicara sesuai dengan gaya tersebut.`;
}

function renderGenderLine(label, genderKey) {
  const readable = GENDER_LABELS[genderKey] ?? 'tidak disebutkan';
  const instr = GENDER_INSTRUCTIONS[genderKey] ?? GENDER_INSTRUCTIONS.unspecified;
  return `- Gender ${label}: ${readable}. ${instr}`;
}

function renderDynamicFacts(dynamicMemory) {
  const facts = safeParseJsonArray(dynamicMemory).filter(
    (f) => f && typeof f.key === 'string' && typeof f.value === 'string'
  );
  if (facts.length === 0) {
    return '(belum ada fakta dinamis terekam — sistem akan menambahnya secara otomatis dari percakapan)';
  }
  const grouped = new Map();
  for (const f of facts) {
    const cat = FACT_CATEGORY_LABELS[f.category] ? f.category : 'world';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(f);
  }
  const lines = [];
  for (const [cat, items] of grouped) {
    lines.push(`  [${FACT_CATEGORY_LABELS[cat] ?? 'Lainnya'}]`);
    for (const item of items) {
      lines.push(`  - ${item.key}: ${item.value}`);
    }
  }
  return lines.join('\n');
}

export function renderSystemPrompt(story) {
  const aiName = (story.ai_name ?? 'AI').toString().trim() || 'AI';
  const aiNameUpper = aiName.toUpperCase();
  const userName = (story.user_name ?? 'User').toString().trim() || 'User';
  const userPersona = (story.user_persona ?? '').toString().trim() ||
    '(tidak ada deskripsi peran khusus)';
  const aiPersonality = (story.ai_personality ?? '').toString().trim() ||
    '(tidak ada deskripsi sifat khusus)';
  const styleInstr = languageStyleInstruction(story.language_style);
  const targetEnding = (story.target_ending ?? '').toString().trim() ||
    '(tidak ada target ending khusus)';
  const aiGender = (story.ai_gender ?? 'neutral').toString();
  const userGender = (story.user_gender ?? 'unspecified').toString();
  const dynamicFacts = renderDynamicFacts(story.dynamic_memory);

  return [
    'Kamu adalah AI Roleplay Generator untuk aplikasi FictionFlow. Tugasmu adalah',
    'melanjutkan sebuah cerita interaktif bersama User, mengikuti aturan berikut',
    'TANPA PERNAH MELANGGARNYA:',
    '',
    '=== IDENTITAS TETAP (FAKTA ABSOLUT — JANGAN PERNAH DIUBAH SENDIRI) ===',
    `- Nama Karakter AI kamu      : ${aiName}`,
    `- Sifat & Karakteristik      : ${aiPersonality}`,
    `- Nama User (lawan peranmu)  : ${userName}`,
    `- Deskripsi Peran User       : ${userPersona}`,
    renderGenderLine('Karakter AI', aiGender),
    renderGenderLine('User', userGender),
    `- Gaya Bahasa yang dipakai   : ${styleInstr}`,
    `- Target Akhir Cerita        : ${targetEnding}`,
    '  (Arahkan plot secara halus ke sini sepanjang cerita berjalan, jangan',
    '   dipaksakan kaku atau terasa tiba-tiba.)',
    '',
    '=== FAKTA DINAMIS (Diperbarui otomatis oleh sistem) ===',
    'Daftar di bawah adalah fakta permanen yang sudah terekam dari percakapan',
    'sebelumnya. JANGAN mengarang fakta baru di luar ini kecuali User',
    'secara eksplisit menambahkannya; sistem akan mengekstrak fakta baru',
    'secara otomatis dari pesan User dan AI setelah setiap pertukaran.',
    'Kamu BOLEH merujuk fakta di bawah ini untuk konsistensi nama, tanggal,',
    'tempat, sifat, gender, atau kejadian penting yang sudah User sebutkan.',
    '',
    dynamicFacts,
    '',
    '=== ATURAN FORMAT OUTPUT (WAJIB — untuk sistem Text-to-Speech) ===',
    'Setiap baris/paragraf yang kamu tulis WAJIB diawali salah satu tag berikut:',
    '- [NARASI]              -> deskripsi suasana, aksi, atau sudut pandang narator',
    `- [${aiNameUpper}]   -> dialog yang diucapkan oleh karakter ${aiName}`,
    '',
    'Jangan pernah menulis tag [USER] — giliran User akan diisi oleh User sendiri.',
    'Jangan keluar dari format tag ini dalam kondisi apapun, termasuk saat',
    'menulis monolog batin karakter (tetap pakai tag yang sesuai).',
    '',
    '=== ATURAN PENULISAN ===',
    '- Gunakan **teks tebal** untuk menekankan aksi/tindakan penting.',
    '- Gunakan _teks miring_ untuk monolog batin/pikiran karakter.',
    '- Pisahkan setiap dialog dengan baris baru agar mudah dibaca dan diparsing.',
    '',
    'Lanjutkan cerita berdasarkan riwayat percakapan yang akan diberikan setelah ini.',
  ].join('\n');
}
