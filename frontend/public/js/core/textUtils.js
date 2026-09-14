/**
 * Shared text utilities untuk FictionFlow frontend.
 */

/**
 * Strip reasoning/thinking tags dari output LLM.
 * Beberapa model menyisipkan konten reasoning dalam tag XML.
 */
export function stripReasoningContent(text) {
  if (typeof text !== 'string') return text;
  // Restrict to model-specific reasoning tags only. Generic English words like
  // 'reasoning'/'thought'/'analysis' could plausibly appear as in-story markup
  // in a roleplay app and get silently stripped — keep them out (TEMUAN-040).
  // 'think' = DeepSeek; 'ctrl32' = known model control tag.
  const tags = ['think', 'ctrl32'];
  let cleaned = text;
  for (const tag of tags) {
    cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`<\\/${tag}>`, 'gi'), '');
  }
  return cleaned;
}


/**
 * Escape string untuk disisipkan ke HTML template. SATU-SATUNYA helper escape
 * yang dipakai call-site innerHTML — jangan tulis re-implementasi per-file.
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
