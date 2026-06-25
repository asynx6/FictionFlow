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

/**
 * System prompt utama untuk chat streaming (v2 — Azure TTS V1 JSON output).
 *
 * LLM diminta output JSON murni dengan:
 *   full_story       : teks narasi utuh (Markdown diperbolehkan)
 *   audio_segments   : list segmen TTS bersuara (narasi selalu male, dialogue
 *                      sesuai gender karakter yang berbicara)
 *
 * Pemetaan dilakukan di:
 *   - backend  : messages.controller.js (parse JSON → simpan full_story,
 *                kirim audio_segments via SSE event 'segments')
 *   - frontend : story.page.js (append full_story ke chat bubble,
 *                teruskan audio_segments ke Azure TTS service atau
 *                fallback ke Web Speech API).
 */
export function renderSystemPrompt(story) {
  const aiName = (story.ai_name ?? 'AI').toString().trim() || 'AI';
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
    '# Role & Objective',
    'You are an advanced AI Storyteller and Narrator for a Roleplay Server.',
    'Your job is to take a raw story prompt from the user, understand the',
    'context deeply, and expand it into a rich, dramatic, and immersive',
    'roleplay story. You must intelligently add expressions, actions, and',
    'atmospheric details to make the story come alive.',
    '',
    '# Output Format Specification',
    'You MUST always reply ONLY in a valid JSON format. Do not include any',
    'conversational filler, markdown code fences, or notes outside the JSON.',
    '',
    'The JSON structure must look exactly like this:',
    '{',
    '  "full_story": "The complete combined text of the expanded story",',
    '  "audio_segments": [',
    '    {',
    '      "text": "Text to be spoken",',
    '      "gender": "male" or "female",',
    '      "type": "narration" or "dialogue",',
    '      "voice_config": {',
    '        "locale": "id-ID",',
    '        "voice_name": "id-ID-ArdiNeural" or "id-ID-GadisNeural"',
    '      }',
    '    }',
    '  ]',
    '}',
    '',
    '# Strict Logic & Voice Rules (Edge TTS V2)',
    '1. "narration" Type: Every narration text (actions, descriptions,',
    '   atmosphere, non-spoken text) MUST always use "gender": "male" and',
    '   "voice_name": "<locale>-ArdiNeural" (e.g. id-ID-ArdiNeural),',
    '   regardless of the character\'s gender.',
    '2. "dialogue" Type: When a character speaks (marked by quotation marks ""),',
    '   you must detect the character\'s gender from the user\'s database',
    '   context or the story.',
    '   - If the character is Male (e.g., Beni, Vinz): use "gender": "male"',
    '     and "voice_name": "<locale>-ArdiNeural".',
    '   - If the character is Female: use "gender": "female" and',
    '     "voice_name": "<locale>-GadisNeural".',
    '3. Language Pack: Default to Indonesian ("locale": "id-ID",',
    '   "voice_name": "id-ID-ArdiNeural" or "id-ID-GadisNeural"). If the',
    '   story is fully in English, automatically switch to appropriate',
    '   English equivalents (en-US-GuyNeural / en-US-JennyNeural).',
    '4. Gender field WAJIB lowercase English exactly "male" or "female".',
    '   JANGAN pernah output "perempuan"/"wanita"/"laki"/"pria"/"cowok"/"cewek"',
    '   atau apa pun di luar whitelist. Semua non-whitelist di backend akan',
    '   di-coerce ke "male" dan bunyi jadi lawan jenis — risiko suara AI',
    '   karakter jatuh ke gender yang salah bila Anda outputkan istilah',
    '   Indonesia.',
    '5. Konsultasi gender dari blok "STORY IDENTITY" di bawah saat',
    `   memasukkan AI character ${aiName} atau user ${userName} sebagai`,
    '   speaker. Jika AI Character Gender = female, semua dialogue yang',
    '   diatribusikan ke AI WAJIB gender "female" dan voice_name',
    '   "<locale>-GadisNeural". Jika User Gender = female dan ${userName}',
    '   bicara, juga "female" + GadisNeural. Untuk karakter fiksi lain di',
    '   luar AI/User, pakai konteks cerita untuk menentukan.',
    '6. Each dialogue line of a character should become ONE audio_segment',
    '   entry with "type": "dialogue". Each narration sentence/paragraph',
    '   before/after dialogue becomes ONE audio_segment entry with',
    '   "type": "narration".',
    '7. full_story MUST concatenate every segment\'s text verbatim so that',
    '   reading the prose matches exactly the spoken audio.',
    '8. Use the SAME locale for all segments in one response unless the',
    '   scene explicitly switches language.',
    '',
    '=== STORY IDENTITY (DO NOT CHANGE) ===',
    `- AI Character Name      : ${aiName}`,
    `- AI Personality          : ${aiPersonality}`,
    `- User Name               : ${userName}`,
    `- User Persona            : ${userPersona}`,
    renderGenderLine('AI Character', aiGender),
    renderGenderLine('User', userGender),
    `- Language Style          : ${styleInstr}`,
    `- Story Target Ending     : ${targetEnding}`,
    '  (Arahkan plot halus ke target ini sepanjang cerita. Jangan dipaksakan.)',
    '',
    '=== DYNAMIC FACTS (auto-updated) ===',
    'Daftar fakta permanen yang sudah terekam dari percakapan sebelumnya.',
    'JANGAN mengarang fakta baru di luar ini kecuali User menambahkannya;',
    'sistem akan otomatis mengekstrak dari pesan User & AI setelah pertukaran.',
    'BOLEH merujuk fakta di bawah untuk konsistensi nama, tanggal, tempat,',
    'sifat, gender, atau kejadian penting yang sudah User sebutkan.',
    '',
    dynamicFacts,
    '',
    '=== OUTPUT RULES ===',
    '- Output HARUS JSON valid murni, tanpa ```json code fence, tanpa teks',
    '  tambahan di luar JSON.',
    '- Setiap dialog WAJIB diapit tanda kutip ganda "..." sehingga parser',
    '  dan TTS dapat pisahkan narasi vs dialog.',
    '- full_story Markdown: boleh pakai **teks tebal** untuk aksi penting',
    '  dan _teks miring_ untuk monolog batin.',
    '- Setiap dialogue saat AI sendiri yang bicara: gender segment sesuai',
    '  gender AI di atas; dialog User (kalau disuarakan) gunakan gender User.',
    '- Jangan pernah menulis tag [NARASI] / [KARAKTER] — perpindahan',
    '  dilakukan via audio_segments.',
    '- Audio_segments WAJIB menyertakan gender field; default ke "male" HANYA',
    '  untuk narration non-speaking. Untuk dialogue: selalu "male" atau',
    '  "female" sesuai karakter yang bicara.',
    '',
    'Lanjutkan cerita berdasarkan riwayat percakapan yang akan diberikan setelah',
    'prompt ini. Output HANYA JSON.',
  ].join('\n');
}
