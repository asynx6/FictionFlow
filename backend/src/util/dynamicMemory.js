/**
 * Shared dynamic-memory normalization + tagged-key canonicalization.
 *
 * Single source of truth for the `[KEY]: value` tagged-state convention used
 * across the memory subsystem. The extractor (write-side merge/dedup) and the
 * prompt builder (read-side context surfacing) MUST go through this module so
 * the two never drift on what counts as a "tagged relationship fact".
 *
 * LLM output is unreliable at exact `[KEY]: value` formatting — it often emits
 * `USER_PANGGILAN: kaishi`, `[user_panggilan]: kaishi`, `[USER_PANGGILAN] : x`,
 * or `[USER_PANGGILAN] - x`. The legacy migration path also emits bare
 * `KEY: value` without brackets. Every consumer below treats any of those as
 * the same canonical `[KEY]: value` form, so dedup collapses duplicates and
 * the read-side parser surfaces state regardless of how the LLM formatted it.
 */

/** Tagged state keys — one entry per key, latest value wins. */
export const TAGGED_KEYS = ['STATUS', 'AI_PANGGILAN', 'USER_PANGGILAN', 'SEJAK', 'KONTEKS_PERILAKU'];

const TAGGED_KEY_SET = new Set(TAGGED_KEYS);

const VALID_CATEGORIES = ['user', 'ai', 'world', 'relationship'];
const VALID_CATEGORY_SET = new Set(VALID_CATEGORIES);

// Tolerant match — two forms:
//   bracketed: `[KEY]` then `:` OR `-` separator (LLM drift: `[STATUS] - x`)
//   bare:      `KEY`   then `:` only (LLM drift: `USER_PANGGILAN: x`)
// Bare keys do NOT accept `-` so narrative phrases like "status-quo report"
// are not mis-read as `[STATUS]: quo report`. Bracket present is the strong
// signal that justifies the looser `-` separator. Case-insensitive; the key is
// uppercased and matched against TAGGED_KEYS.
const TAGGED_FACT_PATTERN = /^\s*(?:\[([A-Za-z][A-Za-z0-9_]*)\]\s*[:\-]|([A-Za-z][A-Za-z0-9_]*)\s*:)\s*(.*)$/;

/** Pull the uppercased tagged key out of a tolerant match, or null. */
function matchTaggedKey(fact) {
  const m = typeof fact === 'string' ? fact.match(TAGGED_FACT_PATTERN) : null;
  if (!m) return null;
  const key = (m[1] ?? m[2] ?? '').toUpperCase();
  return TAGGED_KEY_SET.has(key) ? key : null;
}

/**
 * Rewrite a relationship fact to its canonical `[KEY]: value` form when its
 * (case-insensitive) key is a known TAGGED_KEYS entry — tolerating missing
 * brackets, mixed case, surrounding whitespace, and `:`/`-` separators.
 *
 * Non-tagged facts (narrative) are returned untouched so free-text like
 * "AI cemburu" never gets mis-rewrite'd into `[AI]: cemburu`.
 *
 * @param {string} fact
 * @returns {string}
 */
export function canonicalizeRelationshipFact(fact) {
  if (typeof fact !== 'string') return fact;
  const key = matchTaggedKey(fact);
  if (!key) return fact;
  const m = fact.match(TAGGED_FACT_PATTERN);
  const value = (m[3] ?? '').trim();
  return `[${key}]: ${value}`;
}

/**
 * True iff the fact canonicalizes to a tagged state entry. Use this instead of
 * a regex test on the raw string so bracket-less / lowercase variants count.
 *
 * @param {string} fact
 * @returns {boolean}
 */
export function isTaggedFact(fact) {
  return matchTaggedKey(fact) !== null;
}

/**
 * Extract the uppercase tagged key from a fact (after tolerant match), or null
 * if it isn't a tagged fact.
 *
 * @param {string} fact
 * @returns {string | null}
 */
export function taggedKeyOf(fact) {
  return matchTaggedKey(fact);
}

function emptyMemory() {
  return { user: [], ai: [], world: [], relationship: [] };
}

/**
 * Normalize any raw `dynamic_memory` payload (DB string, already-parsed object,
 * or legacy `[{category,key,value}]` array) into the canonical
 * `{user,ai,world,relationship}` string-array shape.
 *
 * Legacy entries whose uppercase `key` is a known TAGGED_KEYS value are emitted
 * in canonical bracketed form (`[KEY]: value`) so they dedup with freshly
 * extracted facts — fixes the legacy "USER_PANGGILAN: x" vs "[USER_PANGGILAN]: x"
 * split-brain that produced double entries.
 *
 * Relationship entries are run through `canonicalizeRelationshipFact` so the
 * stored shape is canonical before any merge/read.
 *
 * @param {unknown} raw
 * @returns {Record<'user'|'ai'|'world'|'relationship', string[]>}
 */
export function normalizeDynamicMemory(raw) {
  const empty = emptyMemory();
  if (!raw) return empty;
  let parsed;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return empty; }
  } else {
    parsed = raw;
  }

  // Already in new schema shape.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const out = emptyMemory();
    for (const cat of VALID_CATEGORIES) {
      const arr = parsed[cat];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed) continue;
        out[cat].push(cat === 'relationship' ? canonicalizeRelationshipFact(trimmed) : trimmed);
      }
    }
    return out;
  }

  // Legacy schema: array of { category, key, value }.
  if (Array.isArray(parsed)) {
    const out = emptyMemory();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const cat = VALID_CATEGORY_SET.has(item.category) ? item.category : 'world';
      const k = typeof item.key === 'string' ? item.key.trim() : '';
      const v = typeof item.value === 'string' ? item.value.trim() : '';
      if (!v) continue;
      // Emit canonical `[KEY]: value` for known tagged keys; otherwise keep the
      // legacy `KEY: value` human-readable tag so non-tagged legacy facts don't
      // get rewritten spuriously.
      const upperKey = k.toUpperCase();
      if (cat === 'relationship' && k && TAGGED_KEY_SET.has(upperKey)) {
        out[cat].push(`[${upperKey}]: ${v}`);
      } else {
        out[cat].push(k ? `${k}: ${v}` : v);
      }
    }
    return out;
  }

  return empty;
}
