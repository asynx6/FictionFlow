import db from '../db/database.js';
import { renderSystemPrompt } from './promptBuilder.service.js';

const getRecentStmt = db.prepare(`
  SELECT id, role, raw_content, created_at
  FROM messages
  WHERE story_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const MIN_WINDOW = 3;
const MAX_WINDOW = 5;

function clampWindow(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, n));
}

/**
 * Membangun payload context untuk dikirim ke model AI sesuai Bab 6.3:
 *   1. System prompt dari Long-Term Memory (tabel stories).
 *   2. Short-Term Memory: N pertukaran terakhir (N x 2 baris).
 *   3. Pesan user yang baru dikirim di akhir payload.
 *
 * Mengabaikan pesan dengan content kosong/whitespace-only.
 */
export function buildContextPayload(story, latestUserMessage) {
  const window = clampWindow(story.short_term_window, 4);
  const recentDesc = getRecentStmt.all(story.id, window * 2);
  const recentAsc = recentDesc
    .slice()
    .reverse()
    .filter((m) => m && typeof m.raw_content === 'string' && m.raw_content.trim().length > 0);

  const systemPrompt = renderSystemPrompt(story);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...recentAsc.map((m) => ({ role: m.role, content: m.raw_content.trim() })),
  ];

  // Only append user message if it has real content
  if (typeof latestUserMessage === 'string' && latestUserMessage.trim().length > 0) {
    messages.push({ role: 'user', content: latestUserMessage.trim() });
  }

  return messages;
}

/**
 * Estimasi kasar jumlah token (untuk monitoring, bukan billing).
 * Heuristik 1 token ~ 4 karakter untuk teks campuran id/en.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
