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
    console.warn('[memoryExtractor] Gagal parse JSON dari LLM:', err.message);
    return [];
  }
}

const updateMemoryStmt = db.prepare(`
  UPDATE stories SET dynamic_memory = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
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
  } catch (err) {
    console.warn('[memoryExtractor] Skip —', err.message);
  }
}
