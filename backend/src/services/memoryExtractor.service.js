import db from '../db/database.js';
import { chatCompletionOnce, resolveModelId } from './modelProvider.service.js';

const MAX_DYNAMIC_FACTS = 60;
const VALID_CATEGORIES = new Set(['user', 'ai', 'world', 'relationship']);

const EXTRACTOR_SYSTEM_PROMPT = [
  'Kamu adalah modul Memory Extractor untuk aplikasi roleplay.',
  'Tugasmu: membaca satu pesan User dan satu balasan AI, lalu',
  'mengekstrak FAKTA PERMANEN yang worth-disimpan untuk konsistensi cerita.',
  '',
  'Kategori yang boleh dipakai (pilih satu per fakta):',
  '- user        : fakta tentang User (nama asli, gender, usia, pekerjaan,',
  '                tempat tinggal, sifat, kebiasaan, preferensi, keluarga,',
  '                teman, hewan, dsb).',
  '- ai          : fakta tentang karakter AI sendiri (nama julukan, sikap',
  '                yang muncul konsisten, dsb).',
  '- world       : fakta tentang dunia cerita (lokasi, waktu/tahun/bulan,',
  '                event penting, aturan dunia).',
  '- relationship: fakta tentang hubungan AI dan User (status, panggilan,',
  '                momen penting, dsb).',
  '',
  'ATURAN KERAS:',
  '1. Output HARUS JSON valid, tanpa markdown, tanpa teks lain di luar JSON.',
  '2. Format: array of objects dengan field category, key, value.',
  '    category salah satu dari: user, ai, world, relationship.',
  '    Jika tidak ada fakta baru, kembalikan array kosong [].',
  '3. Hanya fakta yang EKSPLISIT disebutkan oleh User atau AI di pesan',
  '   tersebut. JANGAN mengarang, menebak, atau mengisi default.',
  '4. Skip fakta yang terlalu trivial atau sementara.',
  '5. Skip fakta yang sudah ada di EXISTING_FACTS (jangan duplikat).',
  '6. Key singkat, value informatif.',
  '    Contoh: {"category":"user","key":"nama_asli","value":"Beni"}.',
  '7. Untuk tahun/bulan/tanggal gunakan key terpisah: tahun_lahir,',
  '   bulan_lahir, hari_jadian, dsb.',
  '',
  'Kembalikan JSON saja.',
].join('\n');

function safeParseFacts(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stripCodeFences(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
  }
  return trimmed;
}

function sanitizeFacts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const category = VALID_CATEGORIES.has(item.category) ? item.category : 'world';
    const key = typeof item.key === 'string' ? item.key.trim().slice(0, 80) : '';
    let value;
    if (typeof item.value === 'string') value = item.value.trim().slice(0, 400);
    else if (typeof item.value === 'number' || typeof item.value === 'boolean')
      value = String(item.value);
    else value = null;
    if (!key || !value) continue;
    const dedupKey = `${category}::${key.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      category,
      key,
      value,
      learned_at: new Date().toISOString(),
    });
  }
  return out;
}

function mergeFacts(existing, incoming) {
  const byKey = new Map();
  for (const f of existing) {
    const k = `${f.category}::${String(f.key).toLowerCase()}`;
    byKey.set(k, f);
  }
  for (const f of incoming) {
    const k = `${f.category}::${String(f.key).toLowerCase()}`;
    if (byKey.has(k)) {
      byKey.set(k, { ...byKey.get(k), value: f.value, learned_at: f.learned_at });
    } else {
      byKey.set(k, f);
    }
  }
  let merged = Array.from(byKey.values());
  if (merged.length > MAX_DYNAMIC_FACTS) {
    merged = merged.slice(-MAX_DYNAMIC_FACTS);
  }
  return merged;
}

async function callExtractor({ model, existingFacts, userMessage, assistantMessage }) {
  const userPrompt = [
    'EXISTING_FACTS:',
    JSON.stringify(existingFacts),
    '',
    'USER_MESSAGE:',
    userMessage.slice(0, 2000),
    '',
    'ASSISTANT_MESSAGE:',
    assistantMessage.slice(0, 2000),
    '',
    'Kembalikan JSON array saja.',
  ].join('\n');

  const raw = await chatCompletionOnce({
    model,
    messages: [
      { role: 'system', content: EXTRACTOR_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
  });

  const cleaned = stripCodeFences(raw);
  try {
    return sanitizeFacts(JSON.parse(cleaned));
  } catch (err) {
    console.error('[memoryExtractor] stage=parse model=' + model + ' err=' + err.message);
    return [];
  }
}

const updateMemoryStmt = db.prepare(`
  UPDATE stories SET dynamic_memory = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

// Stmt untuk Auditor & Summarizer (butuh akses BACA dynamic_memory + update).
const getDynamicMemoryStmt = db.prepare(`
  SELECT dynamic_memory FROM stories WHERE id = ?
`);

/**
 * Background job: ekstrak fakta dari pasangan pesan user+assistant,
 * merge dengan dynamic_memory existing, simpan balik ke DB.
 *
 * Fire-and-forget: tidak melempar error ke caller. Hanya log warning.
 */
export async function extractAndMergeFacts({ story, userMessage, assistantMessage }) {
  if (!story || !userMessage || !assistantMessage) return;
  if (userMessage.length < 8 && assistantMessage.length < 16) return;

  const existingFacts = safeParseFacts(story.dynamic_memory);
  const model = resolveModelId(story.active_model_id);

  try {
    const extracted = await callExtractor({
      model,
      existingFacts,
      userMessage,
      assistantMessage,
    });
    if (extracted.length === 0) return;
    const merged = mergeFacts(existingFacts, extracted);
    updateMemoryStmt.run(JSON.stringify(merged), story.id);

    // Trigger memory auditor (event-based: setelah merge, cek obsolete).
    callMemoryAuditor(story.id).catch(() => {});
    // Trigger summarizer kalau fakta > 50.
    summarizeFacts(story.id).catch(() => {});
  } catch (err) {
    console.error('[memoryExtractor] stage=merge story=' + story.id + ' model=' + model + ' err=' + (err && err.message ? err.message : err));
  }
}

// ─── Memory Auditor (Task 7) ────────────────────────────────────────────────

const AUDITOR_SYSTEM_PROMPT = [
  'Kamu adalah Memory Auditor untuk aplikasi roleplay.',
  'Tugasmu: deteksi fakta OBSOLETE (sudah tidak relevan) atau KONFLIK (bertentangan)',
  'dari daftar DYNAMIC FACTS yang diberikan.',
  '',
  'HANYA tandai fakta yang:',
  '- SUDAH TIDAK RELEVAN: kejadian sudah lewat/lampau (misal: "User sedang di kafe" padahal scene sekarang di rumah)',
  '- KONFLIK: dua fakta bertentangan, salah satu harus dihapus (pilih yang lebih lama/usang)',
  '- REDUNDAN: dua fakta mengatakan hal yang sama dengan wording berbeda',
  '',
  'JANGAN hapus fakta yang:',
  '- Masih permanen dan relevan (nama, sifat, hubungan, lokasi tetap)',
  '- Fakta identitas karakter (nama user/ai, gender, kepribadian inti)',
  '- Fakta yang baru saja ditambahkan',
  '',
  'Output HANYA JSON array berisi KEY dari fakta yang HARUS DIHAPUS:',
  '["key_fakta_obsolete_1", "key_fakta_obsolete_2"]',
  '',
  'Kalau tidak ada yang perlu dihapus → output []',
].join('\n');

const AUDITOR_TRIGGER_COUNT = 20;

/**
 * Deteksi dan hapus fakta obsolete/konflik dari dynamic_memory sebuah story.
 * Event-based trigger: dijalankan setelah extractAndMergeFacts kalau jumlah
 * fakta >= AUDITOR_TRIGGER_COUNT.
 */
export async function callMemoryAuditor(storyId) {
  if (!storyId) return 0;
  const dynamicRaw = getDynamicMemoryStmt.pluck().get(storyId) ?? '[]';
  let facts = [];
  try { facts = JSON.parse(dynamicRaw); } catch { return 0; }
  if (!Array.isArray(facts)) return 0;
  const validFacts = facts.filter((f) => f?.key && f?.value);
  if (validFacts.length < AUDITOR_TRIGGER_COUNT) return 0;

  const factsList = validFacts
    .map((f, i) => `${i}. [${f.category ?? 'world'}] ${f.key}: ${f.value}`)
    .join('\n');

  try {
    const response = await chatCompletionOnce({
      model: 'openrouter/google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: AUDITOR_SYSTEM_PROMPT },
        { role: 'user', content: `Berikut daftar fakta saat ini:\n\n${factsList}\n\nTentukan key mana saja yang harus dihapus (output JSON array saja).` },
      ],
      max_tokens: 400,
      temperature: 0.2,
    });

    if (!response) return 0;
    const cleaned = response
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/g, '')
      .trim();
    const keysToDelete = JSON.parse(cleaned);
    if (!Array.isArray(keysToDelete) || keysToDelete.length === 0) return 0;

    const deleteSet = new Set(keysToDelete.map((k) => (typeof k === 'string' ? k.toLowerCase().trim() : '')).filter(Boolean));
    if (deleteSet.size === 0) return 0;

    const kept = validFacts.filter((f) => !deleteSet.has(f.key.toLowerCase().trim()));
    const removed = validFacts.length - kept.length;
    if (removed > 0) {
      updateMemoryStmt.run(JSON.stringify(kept), storyId);
      console.log(`[memoryAuditor] Dihapus ${removed} fakta obsolete dari story ${storyId}`);
    }
    return removed;
  } catch (err) {
    console.warn('[memoryAuditor] Gagal:', err.message);
    return 0;
  }
}

// ─── Memory Summarizer (Task 8) ──────────────────────────────────────────────

const SUMMARIZER_SYSTEM_PROMPT = [
  'Kamu adalah Memory Summarizer untuk aplikasi roleplay.',
  'Tugasmu: merangkum daftar fakta yang TERLALU BANYAK (>50) menjadi maksimal 30 fakta.',
  '',
  'Aturan:',
  '- Gabungkan fakta redundant (dua fakta yang bicara hal sama → jadi satu)',
  '- Pertahankan fakta PALING PENTING (identitas, hubungan, event krusial, lokasi tetap)',
  '- Buang fakta trivial yang sudah tidak relevan',
  '- JANGAN mengubah key fakta yang dipertahankan (key + value tetap persis)',
  '- Output HANYA JSON array fakta yang dipertahankan (format sama dengan input)',
  '',
  'Format input & output:',
  '[',
  '  {"key": "...", "value": "...", "category": "..."},',
  '  ...',
  ']',
  '',
  'Kalau input sudah <= 30 fakta → outputkan semua apa adanya (tidak ada yang dirangkum).',
].join('\n');

const SUMMARIZER_MAX_FACTS = 30;

/**
 * Rangkum dynamic_memory kalau jumlah fakta > 50 → maks 30 fakta.
 * Trigger: setelah auditor selesai (atau setelah merge), cek count.
 */
export async function summarizeFacts(storyId) {
  if (!storyId) return 0;
  const dynamicRaw = getDynamicMemoryStmt.pluck().get(storyId) ?? '[]';
  let facts = [];
  try { facts = JSON.parse(dynamicRaw); } catch { return 0; }
  if (!Array.isArray(facts)) return 0;
  const validFacts = facts.filter((f) => f?.key && f?.value);
  if (validFacts.length <= 50) return validFacts.length;

  const factsJson = JSON.stringify(validFacts.map((f) => ({
    key: f.key,
    value: f.value,
    category: f.category ?? 'world',
  })));

  try {
    const response = await chatCompletionOnce({
      model: 'openrouter/google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
        { role: 'user', content: `Rangkum fakta berikut menjadi maksimal ${SUMMARIZER_MAX_FACTS} fakta:\n\n${factsJson}` },
      ],
      max_tokens: 1200,
      temperature: 0.2,
    });

    if (!response) return validFacts.length;
    const cleaned = response
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/g, '')
      .trim();
    const summarized = JSON.parse(cleaned);
    if (!Array.isArray(summarized) || summarized.length === 0) return validFacts.length;

    const finalFacts = summarized
      .filter((f) => f && typeof f.key === 'string' && typeof f.value === 'string')
      .slice(0, SUMMARIZER_MAX_FACTS);

    updateMemoryStmt.run(JSON.stringify(finalFacts), storyId);
    console.log(`[memorySummarizer] Dirangkum ${validFacts.length} → ${finalFacts.length} fakta untuk story ${storyId}`);
    return finalFacts.length;
  } catch (err) {
    console.warn('[memorySummarizer] Gagal:', err.message);
    return validFacts.length;
  }
}
