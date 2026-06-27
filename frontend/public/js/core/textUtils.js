/**
 * Shared text utilities untuk FictionFlow frontend.
 */

/**
 * Strip reasoning/thinking tags dari output LLM.
 * Beberapa model menyisipkan konten reasoning dalam tag XML.
 */
export function stripReasoningContent(text) {
  if (typeof text !== 'string') return text;
  const tags = ['ctrl32', 'think', 'reasoning', 'thought', 'analysis'];
  let cleaned = text;
  for (const tag of tags) {
    cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`<\\/${tag}>`, 'gi'), '');
  }
  cleaned = cleaned.replace(/<ctrl32>.*?<\/ctrl32>/gi, '');
  cleaned = cleaned.replace(/<ctrl32>/gi, '');
  return cleaned;
}
