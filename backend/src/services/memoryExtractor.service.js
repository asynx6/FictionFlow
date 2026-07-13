import db from '../db/database.js';
import { chatCompletionOnce, getConfiguredModelId } from './modelProvider.service.js';
import {
  TAGGED_KEYS,
  canonicalizeRelationshipFact,
  isTaggedFact,
  taggedKeyOf,
  normalizeDynamicMemory,
} from '../util/dynamicMemory.js';

export { normalizeDynamicMemory };

const MAX_DYNAMIC_FACTS_TOTAL = 60;
const VALID_CATEGORIES = new Set(['user', 'ai', 'world', 'relationship']);

/**
 * Total fact count across all four categories.
 */
function totalFacts(memory) {
  let n = 0;
  for (const cat of VALID_CATEGORIES) n += (memory[cat]?.length ?? 0);
  return n;
}

/**
 * Normalize a fact string for fuzzy equality matching: lowercase, trim, and
 * collapse internal whitespace runs to a single space. Used by the auditor
 * dropset so a fact flagged for deletion still matches when the stored entry
 * has different internal spacing (TEMUAN-045).
 */
function normalizeForMatch(s) {
  return String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Order-insensitive deep-equality of two categorized memories: compare each
 * category as a sorted lowercased array set. Replaces JSON.stringify
 * comparison, which flagged spurious writes when the same facts arrived in a
 * different order or with key-order differences (TEMUAN-041/044).
 */
function memoryEqual(a, b) {
  for (const cat of VALID_CATEGORIES) {
    const aa = (a[cat] ?? []).slice().map((s) => String(s).toLowerCase()).sort();
    const bb = (b[cat] ?? []).slice().map((s) => String(s).toLowerCase()).sort();
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  }
  return true;
}

/**
 * Build the canonical return string list the extractor expects the LLM to
 * produce. Single source of truth — also used by validators/tests.
 */
const FACT_EXTRACTION_SYSTEM_PROMPT = [
  'Kamu adalah sistem ekstraksi memori untuk platform roleplay AI.',
  '',
  'Tugasmu: baca satu giliran percakapan (pesan user + balasan AI), lalu perbarui memori.',
  '',
  '## MEMORI SAAT INI',
  '{{CURRENT_MEMORY_JSON}}',
  '',
  '## GILIRAN PERCAKAPAN BARU',
  'User: {{USER_MESSAGE}}',
  'AI: {{AI_REPLY}}',
  '',
  '## ATURAN EKSTRAKSI',
  '',
  '### Kategori fakta',
  'Kembalikan JSON dengan tepat 4 kunci: user, ai, world, relationship.',
  'Total semua fakta (string di seluruh array) maksimal 60.',
  '',
  '### Dua jenis fakta di kategori `relationship`',
  '',
  'JENIS 1 — TAGGED STATE FACTS (format: "[KUNCI]: nilai")',
  'Merepresentasikan STATE SAAT INI. Setiap kunci hanya boleh muncul SATU KALI.',
  'Kunci yang dikenali: [STATUS], [AI_PANGGILAN], [USER_PANGGILAN], [SEJAK], [KONTEKS_PERILAKU]',
  'Jika memperbarui: HAPUS yang lama, TAMBAH yang baru. Tidak boleh ada dua entri dengan kunci sama.',
  '',
  'JENIS 2 — FAKTA NARATIF (string biasa)',
  'Kejadian, sejarah, observasi kepribadian. Boleh bertumpuk.',
  'Contoh: "AI cemburu saat user pulang terlambat tanpa kabar"',
  '',
  '### Kapan memperbarui Tagged State Facts',
  '',
  '[STATUS] — perbarui jika hubungan jelas berubah dalam percakapan ini.',
  '  Gunakan deskripsi bebas yang paling akurat (contoh: "teman biasa", "sedang pdkt",',
  '  "pacaran", "putus", "mantan", "asisten-pengguna", "guru-murid", dll).',
  '  Jangan perbarui jika tidak ada perubahan nyata.',
  '',
  '[AI_PANGGILAN] — perbarui jika di giliran ini AI menggunakan panggilan BARU untuk user.',
  '  Ambil dari teks balasan AI yang sebenarnya. Jika sama dengan sebelumnya, biarkan.',
  '',
  '[USER_PANGGILAN] — perbarui jika di giliran ini user menggunakan panggilan baru untuk AI.',
  '',
  '[SEJAK] — isi atau perbarui ketika [STATUS] berubah. Tulis singkat kapan/bagaimana.',
  '',
  '[KONTEKS_PERILAKU] — perbarui setiap kali [STATUS] berubah, atau jika ada pergeseran',
  '  penting dalam dinamika hubungan.',
  '  ',
  '  Tulis deskripsi perilaku yang harus ditunjukkan AI, berdasarkan:',
  '  - Kepribadian/persona karakter AI (dari fakta di kategori ai[])',
  '  - Status hubungan saat ini',
  '  - Kejadian relevan yang baru terjadi',
  '  ',
  '  Deskripsi harus spesifik, praktis, dan langsung dapat digunakan sebagai instruksi.',
  '  Jangan gunakan label generik. Tulis seolah kamu menginstruksikan aktor cara memainkan peran ini.',
  '  ',
  '  Contoh untuk berbagai skenario:',
  '  - Pacar tsundere: "Karakter tsundere yang sedang pacaran. Panggil user \'sayang\' dengan natural. ',
  '    Bisa malu, bisa cemburu, tapi jangan pernah meragukan bahwa mereka berpacaran — itu sudah pasti."',
  '  - Asisten profesional: "Karakter asisten formal. Tetap sopan, fokus pada tugas,',
  '    jaga jarak emosional yang tepat. Tidak ada perasaan romantis."',
  '  - Teman dekat: "Sahabat lama yang sudah sangat akrab. Bercanda bebas, jujur,',
  '    tapi tetap teman — bukan pacar. Panggil dengan nama aslinya."',
  '  - Karakter apapun: tulis berdasarkan realita kepribadian + situasinya.',
  '',
  '### Aturan dedup fakta naratif',
  '- Jika fakta sudah ada di memori, jangan tambah ulang.',
  '- Pertahankan versi yang paling spesifik, hapus yang samar/duplikat.',
  '- Hanya tambah fakta baru jika memang menambah informasi yang belum ada.',
  '',
  '### Jangan ekstrak',
  '- Obrolan basa-basi',
  '- Fakta yang sudah terwakili dengan baik di memori saat ini',
  '- Spekulasi yang tidak didukung percakapan ini',
  '',
  '## FORMAT OUTPUT',
  'Kembalikan HANYA JSON valid. Tidak ada penjelasan, tidak ada markdown, tidak ada teks lain.',
  '{',
  '  "user": [...],',
  '  "ai": [...],',
  '  "world": [...],',
  '  "relationship": [...]',
  '}',
].join('\n');

/**
 * Tagged-state merge for `relationship`: each tag is a singular key — newer
 * entry replaces older. Narrative facts dedup by case-insensitive equality.
 *
 * Every fact (existing AND incoming) is canonicalized to `[KEY]: value` via
 * `canonicalizeRelationshipFact` BEFORE partition, so bracket-less / lowercase
 * / spaced variants of the same tagged key collapse into one Map entry rather
 * than surviving as both a tagged entry and a narrative duplicate (BUG-04).
 * The existing array is also self-deduped for narrative on load — previously
 * duplicates already present in storage survived verbatim.
 *
 * @param {string[]} existing
 * @param {string[]} incoming
 * @returns {string[]}
 */
export function mergeRelationshipFacts(existing, incoming) {
  const tagged = new Map();
  const narrative = [];

  const addFact = (raw, isLatest) => {
    if (typeof raw !== 'string') return;
    const f = canonicalizeRelationshipFact(raw);
    const key = taggedKeyOf(f);
    if (key) {
      // latest wins: incoming overwrites existing for the same canonical key.
      if (isLatest || !tagged.has(key)) tagged.set(key, f);
    } else if (f.trim()) {
      const lower = f.toLowerCase();
      if (!narrative.some((n) => n.toLowerCase() === lower)) narrative.push(f);
    }
  };

  for (const f of existing || []) addFact(f, false);
  for (const f of incoming || []) addFact(f, true);

  return [...tagged.values(), ...narrative];
}

/**
 * Narrative dedup for non-relationship categories. Same case-insensitive rule.
 */
function dedupNarrative(existing, incoming) {
  const out = [...(existing || [])];
  for (const f of incoming || []) {
    if (typeof f !== 'string' || !f.trim()) continue;
    const lower = f.toLowerCase();
    if (!out.some((n) => n.toLowerCase() === lower)) out.push(f);
  }
  return out;
}

/**
 * Merge incoming facts (from extractor LLM) into existing categorized memory.
 * Total cap (MAX_DYNAMIC_FACTS_TOTAL) is enforced by global truncation if
 * exceeded; we keep the most recent state facts (relationship tagged first)
 * and trim narrative from older categories first.
 */
export function mergeDynamicMemory(existing, incoming) {
  const base = normalizeDynamicMemory(existing);
  const inc = normalizeDynamicMemory(incoming);

  return {
    user: dedupNarrative(base.user, inc.user),
    ai: dedupNarrative(base.ai, inc.ai),
    world: dedupNarrative(base.world, inc.world),
    relationship: mergeRelationshipFacts(base.relationship, inc.relationship),
  };
}

/**
 * If total fact count exceeds the cap, trim oldest narrative facts first and
 * ALWAYS keep every tagged relationship state fact (they are the highest-value
 * current state — STATUS / AI_PANGGILAN / USER_PANGGILAN / SEJAK /
 * KONTEKS_PERILAKU). Previously the sort+slice direction dropped tagged facts
 * FIRST when >60 facts accumulated (BUG-05 data-loss).
 *
 * `flat` preserves per-category insertion order (oldest→newest as stored), so
 * trimming narrative from the front drops the oldest entries.
 */
function capMemory(memory) {
  const tagged = [];
  const narrative = [];
  for (const cat of VALID_CATEGORIES) {
    for (const f of memory[cat]) {
      const item = { cat, f };
      if (cat === 'relationship' && isTaggedFact(f)) tagged.push(item);
      else narrative.push(item);
    }
  }
  if (tagged.length + narrative.length <= MAX_DYNAMIC_FACTS_TOTAL) return memory;

  // Keep ALL tagged state (never trim); fill the remaining budget with the
  // NEWEST narrative (drop oldest narrative from the front).
  const narrativeBudget = Math.max(0, MAX_DYNAMIC_FACTS_TOTAL - tagged.length);
  const keptNarrative = narrative.slice(-narrativeBudget);
  const out = { user: [], ai: [], world: [], relationship: [] };
  for (const item of [...tagged, ...keptNarrative]) out[item.cat].push(item.f);
  return out;
}

function stripCodeFences(text) {
  const trimmed = (text ?? '').trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
  }
  return trimmed;
}

/**
 * Extract the first balanced `{...}` object from text (e.g. an LLM that
 * prefixed its JSON with prose like "Berikut memori: {...}"). Scans for the
 * first `{`, tracks brace depth (ignoring braces inside strings), and returns
 * the substring spanning the first top-level object — or null if none found.
 * Used as a fallback when raw JSON.parse fails (TEMUAN-043).
 */
function extractFirstJsonObject(text) {
  const s = text ?? '';
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseMemoryJson(raw) {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: model prefixed JSON with prose. Try to salvage the embedded
    // object before giving up (TEMUAN-043).
    const objStr = extractFirstJsonObject(cleaned);
    if (!objStr) return null;
    try { return JSON.parse(objStr); } catch { return null; }
  }
}

/**
 * Truncate a long message to a budget while keeping both the head and the tail.
 * Relationship-status changes often appear near the end of a long AI reply, so
 * a head-only slice missed them (TEMUAN-042). When the text fits the budget it
 * is returned verbatim; otherwise head + "[...]" + tail.
 */
function headTail(text, budget = 2000) {
  const s = (text ?? '').toString();
  if (s.length <= budget) return s;
  const tailLen = Math.floor(budget * 0.3);
  const headLen = budget - tailLen - 5; // 5 for the "[...]" marker
  return `${s.slice(0, headLen)}[...]${s.slice(-tailLen)}`;
}

async function callExtractor({ existingMemory, userMessage, assistantMessage }) {
  const systemPrompt = FACT_EXTRACTION_SYSTEM_PROMPT
    .replace('{{CURRENT_MEMORY_JSON}}', JSON.stringify(existingMemory, null, 0))
    .replace('{{USER_MESSAGE}}', headTail(userMessage, 2000))
    .replace('{{AI_REPLY}}', headTail(assistantMessage, 2000));

  let raw;
  try {
    raw = await chatCompletionOnce({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Kembalikan JSON saja.' },
      ],
      temperature: 0.2,
    });
  } catch (err) {
    console.error('[memoryExtractor] stage=call err=' + (err?.message ?? err));
    return null;
  }

  const parsed = parseMemoryJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    console.error('[memoryExtractor] stage=parse model=' + getConfiguredModelId() + ' err=unparseable output');
    return null;
  }
  try {
    const out = { user: [], ai: [], world: [], relationship: [] };
    for (const cat of VALID_CATEGORIES) {
      const arr = parsed[cat];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item !== 'string') continue;
          const trimmed = item.trim();
          if (!trimmed) continue;
          // Canonicalize relationship facts so LLM formatting drift (no
          // brackets, lowercase, spaced colon) is normalized before merge.
          out[cat].push(cat === 'relationship' ? canonicalizeRelationshipFact(trimmed) : trimmed);
        }
      }
    }
    return out;
  } catch (err) {
    console.error('[memoryExtractor] stage=parse model=' + getConfiguredModelId() + ' err=' + err.message);
    return null;
  }
}

const updateMemoryStmt = db.prepare(`
  UPDATE stories
  SET dynamic_memory = ?, memory_prev = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);
const getDynamicMemoryStmt = db.prepare(`
  SELECT dynamic_memory FROM stories WHERE id = ?
`);
// Fresh re-read of BOTH columns right before the write (inside the lock) so
// concurrent extractors/auditors/summarizers on the same story don't clobber
// each other from a stale snapshot (TEMUAN-006).
const getDynamicMemoryForWriteStmt = db.prepare(`
  SELECT dynamic_memory, memory_prev FROM stories WHERE id = ?
`);

// Per-story in-process mutex. better-sqlite3 transactions are synchronous but
// the extractor LLM call is awaited between read and write — a second turn on
// the same story can read the same base and last-write-wins. The mutex
// serializes the whole read-merge-write critical section per story.
const memoryLocks = new Map();
async function withMemoryLock(storyId, fn) {
  const prev = memoryLocks.get(storyId) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  memoryLocks.set(storyId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Only clear if our promise is still the latest (avoid clearing a newer lock).
    if (memoryLocks.get(storyId) === next) memoryLocks.delete(storyId);
  }
}

export async function extractAndMergeFacts({ story, userMessage, assistantMessage }) {
  if (!story || !userMessage || !assistantMessage) return;
  if (userMessage.length < 8 && assistantMessage.length < 16) return;

  // Snapshot the request-entry memory to feed the (slow) extractor LLM. The
  // actual merge + write re-reads fresh inside the lock so concurrent writers
  // don't clobber each other.
  const baseMemory = normalizeDynamicMemory(story.dynamic_memory);

  let incoming;
  // Bounded retry with backoff for transient extractor failures (provider
  // hiccup, parse blip). Previously a single transient failure silently
  // skipped memory extraction for the turn, losing relationship state changes
  // (TEMUAN-047). 2 attempts total, ~500ms apart.
  const MAX_EXTRACT_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
    try {
      incoming = await callExtractor({
        existingMemory: baseMemory,
        userMessage,
        assistantMessage,
      });
      if (incoming) break;
    } catch (err) {
      console.error(
        '[memoryExtractor] stage=call story=' + story.id + ' attempt=' + attempt + ' err=' +
          (err && err.message ? err.message : err)
      );
    }
    if (attempt < MAX_EXTRACT_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  if (!incoming) return;

  await withMemoryLock(story.id, async () => {
    // Re-read fresh inside the lock; merge the LLM delta onto the LATEST
    // memory, not the stale request snapshot. Atomically snapshot the
    // pre-update value into memory_prev for server-side rollback.
    const writeTx = db.transaction(() => {
      const row = getDynamicMemoryForWriteStmt.get(story.id);
      const latestRaw = row?.dynamic_memory ?? story.dynamic_memory;
      const latestMemory = normalizeDynamicMemory(latestRaw);

      const merged = mergeDynamicMemory(latestMemory, incoming);
      const capped = capMemory(merged);

      // Order-insensitive deep-equal so a no-op extraction (same facts, different
      // order / key order) doesn't trigger a spurious write + auditor/summarizer
      // fan-out (TEMUAN-041/044).
      const changed = !memoryEqual(capped, latestMemory);
      if (!changed) return false;

      // Snapshot the value we're about to overwrite, for server-side rollback.
      updateMemoryStmt.run(JSON.stringify(capped), latestRaw ?? '{}', story.id);
      return true;
    });

    let wrote = false;
    try {
      wrote = writeTx();
    } catch (err) {
      console.error(
        '[memoryExtractor] stage=write story=' + story.id + ' err=' +
          (err && err.message ? err.message : err)
      );
      return;
    }

    if (wrote) {
      // Serialize auditor + summarizer (previously parallel → last-write-wins
      // race, TEMUAN-006). Both re-read fresh from DB.
      try { await callMemoryAuditor(story.id); } catch { /* logged inside */ }
      try { await summarizeFacts(story.id); } catch { /* logged inside */ }
    }
  });
}

// ─── Memory Auditor ─────────────────────────────────────────────────────────

const AUDITOR_SYSTEM_PROMPT = [
  'Kamu adalah Memory Auditor untuk aplikasi roleplay.',
  'Tugasmu: deteksi fakta OBSOLETE atau KONFLIK dari dynamic_memory sebuah story.',
  '',
  'Diberi sebuah JSON memory dengan 4 kategori: user, ai, world, relationship.',
  'Tiap kategori berisi array of string.',
  '',
  'Untuk kategori relationship, PERHATIKAN tagged facts ([STATUS], [AI_PANGGILAN],',
  '[USER_PANGGILAN], [SEJAK], [KONTEKS_PERILAKU]). Hapus tagged fact hanya jika',
  'ada tagged fact pengganti dari kunci yang sama dengan isi yang lebih baru',
  '(sistem sudah mempertahankan yang terbaru, jadi jarang perlu dihapus).',
  '',
  'HANYA tandai fakta yang memenuhi salah satu:',
  '- SUDAH TIDAK RELEVAN: kejadian sudah lampau/tidak berlaku',
  '- KONFLIK: dua fakta dalam kategori yang sama saling bertentangan',
  '- REDUNDAN: dua fakta mengatakan hal sama dengan wording berbeda',
  '',
  'JANGAN hapus:',
  '- Tagged fact di relationship (state sekarang)',
  '- Identitas permanen (nama user/ai, gender, kepribadian inti)',
  '- Fakta yang baru saja ditambahkan',
  '',
  'Output HANYA JSON object:',
  '{',
  '  "user": ["string fakta yang harus dihapus"],',
  '  "ai": ["..."],',
  '  "world": ["..."],',
  '  "relationship": ["..."]',
  '}',
  '',
  'Kalau tidak ada yang perlu dihapus → {"user":[],"ai":[],"world":[],"relationship":[]}',
].join('\n');

const AUDITOR_TRIGGER_COUNT = 50;

/**
 * Detect & remove obsolete/conflicting facts from dynamic_memory.
 * Trigger: after extractAndMergeFacts when total fact count >= threshold.
 */
export async function callMemoryAuditor(storyId) {
  if (!storyId) return 0;
  const dynamicRaw = getDynamicMemoryStmt.pluck().get(storyId) ?? '{}';
  const memory = normalizeDynamicMemory(dynamicRaw);
  const total = totalFacts(memory);
  if (total < AUDITOR_TRIGGER_COUNT) return 0;

  try {
    const response = await chatCompletionOnce({
      messages: [
        { role: 'system', content: AUDITOR_SYSTEM_PROMPT },
        { role: 'user', content: `Berikut dynamic_memory saat ini:\n\n${JSON.stringify(memory, null, 2)}\n\nTentukan string mana saja yang harus dihapus per kategori.` },
      ],
      max_tokens: 600,
      temperature: 0.2,
    });
    if (!response) return 0;
    const parsed = parseMemoryJson(response);
    if (!parsed || typeof parsed !== 'object') return 0;

    let removed = 0;
    const next = { user: [], ai: [], world: [], relationship: [] };
    for (const cat of VALID_CATEGORIES) {
      const dropSet = new Set(
        (Array.isArray(parsed[cat]) ? parsed[cat] : [])
          .map((s) => (typeof s === 'string' ? normalizeForMatch(s) : ''))
          .filter(Boolean)
      );
      for (const f of memory[cat]) {
        if (!dropSet.has(normalizeForMatch(f))) {
          next[cat].push(f);
        } else {
          removed += 1;
        }
      }
    }
    if (removed > 0) {
      // Apply the drop under the per-story lock against the LATEST memory (a
      // concurrent extractor may have added facts since we read). Snapshot the
      // overwritten value into memory_prev for server-side rollback.
      await withMemoryLock(storyId, async () => {
        const row = getDynamicMemoryForWriteStmt.get(storyId);
        const latestRaw = row?.dynamic_memory ?? dynamicRaw;
        const latest = normalizeDynamicMemory(latestRaw);
        const mergedNext = { user: [], ai: [], world: [], relationship: [] };
        let applied = 0;
        for (const cat of VALID_CATEGORIES) {
          const dropSet = new Set(
            (Array.isArray(parsed[cat]) ? parsed[cat] : [])
              .map((s) => (typeof s === 'string' ? normalizeForMatch(s) : ''))
              .filter(Boolean)
          );
          for (const f of latest[cat]) {
            if (dropSet.has(normalizeForMatch(f))) {
              applied += 1;
            } else {
              mergedNext[cat].push(f);
            }
          }
        }
        if (applied > 0) {
          updateMemoryStmt.run(JSON.stringify(mergedNext), latestRaw ?? '{}', storyId);
          console.log(`[memoryAuditor] Dihapus ${applied} fakta obsolete dari story ${storyId}`);
        }
      });
    }
    return removed;
  } catch (err) {
    console.warn('[memoryAuditor] Gagal:', err.message);
    return 0;
  }
}

// ─── Memory Summarizer ──────────────────────────────────────────────────────

const SUMMARIZER_SYSTEM_PROMPT = [
  'Kamu adalah Memory Summarizer untuk aplikasi roleplay.',
  'Tugasmu: merangkum dynamic_memory sebuah story menjadi versi lebih ringkas.',
  '',
  'Diberi JSON dengan 4 kategori (user, ai, world, relationship).',
  'Tiap kategori berisi array of string (termasuk tagged facts di relationship).',
  '',
  'Aturan:',
  '- Pertahankan SEMUA tagged fact di relationship ([STATUS], [AI_PANGGILAN], ',
  '  [USER_PANGGILAN], [SEJAK], [KONTEKS_PERILAKU]).',
  '- Buang fakta narrative yang redundan atau trivial.',
  '- Pertahankan fakta PALING PENTING (identitas, hubungan, event krusial, lokasi).',
  '- Output JSON object dengan 4 kategori yang sama.',
  '',
  'Format:',
  '{',
  '  "user": [...],',
  '  "ai": [...],',
  '  "world": [...],',
  '  "relationship": [...]',
  '}',
].join('\n');

const SUMMARIZER_MAX_FACTS = 50;

/**
 * Compress facts when total count exceeds SUMMARIZER_MAX_FACTS.
 */
export async function summarizeFacts(storyId) {
  if (!storyId) return 0;
  const dynamicRaw = getDynamicMemoryStmt.pluck().get(storyId) ?? '{}';
  const memory = normalizeDynamicMemory(dynamicRaw);
  const total = totalFacts(memory);
  if (total <= SUMMARIZER_MAX_FACTS) return total;

  try {
    const response = await chatCompletionOnce({
      messages: [
        { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
        { role: 'user', content: `Rangkum dynamic_memory berikut (jangan hilangkan tagged facts di relationship):\n\n${JSON.stringify(memory, null, 2)}` },
      ],
      max_tokens: 1200,
      temperature: 0.2,
    });
    if (!response) return total;
    const parsed = parseMemoryJson(response);
    if (!parsed || typeof parsed !== 'object') return total;

    // Write under the per-story lock against the LATEST memory (a concurrent
    // extractor may have added facts since we read). The merge below preserves
    // tagged state (mergeRelationshipFacts: latest-wins by key) and narrative
    // facts the summarizer LLM omitted (TEMUAN-020). Snapshot the overwritten
    // value into memory_prev for server-side rollback.
    let resultTotal = total;
    await withMemoryLock(storyId, async () => {
      const row = getDynamicMemoryForWriteStmt.get(storyId);
      const latestRaw = row?.dynamic_memory ?? dynamicRaw;
      const latest = normalizeDynamicMemory(latestRaw);
      const parsedNorm = normalizeDynamicMemory(parsed);
      // MERGE (not replace) so narrative facts the summarizer LLM omitted are
      // not permanently lost (TEMUAN-020). Relationship uses mergeRelationshipFacts
      // (tagged latest-wins + narrative dedup); other categories use dedupNarrative.
      const next = {
        user: dedupNarrative(latest.user, parsedNorm.user),
        ai: dedupNarrative(latest.ai, parsedNorm.ai),
        world: dedupNarrative(latest.world, parsedNorm.world),
        relationship: mergeRelationshipFacts(latest.relationship, parsedNorm.relationship),
      };
      // Re-apply cap so a merge that grew past the cap still trims oldest
      // narrative (tagged state always kept).
      const capped = capMemory(next);
      updateMemoryStmt.run(JSON.stringify(capped), latestRaw ?? '{}', storyId);
      resultTotal = totalFacts(capped);
      console.log(`[memorySummarizer] Dirangkum ${total} → ${resultTotal} fakta untuk story ${storyId}`);
    });
    return resultTotal;
  } catch (err) {
    console.warn('[memorySummarizer] Gagal:', err.message);
    return total;
  }
}

// Re-export for tests.
export const __testing__ = {
  stripCodeFences,
  capMemory,
  TAGGED_KEYS,
  withMemoryLock,
  memoryEqual,
  parseMemoryJson,
  headTail,
  normalizeForMatch,
};
