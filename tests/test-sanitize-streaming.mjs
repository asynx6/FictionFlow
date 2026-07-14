/**
 * Self-check: sanitizeFinalContent strips JSON envelope during streaming.
 * Run: node tests/test-sanitize-streaming.mjs
 *
 * sanitizeFinalContent is private in story.page.js; mirror it here (same
 * pattern as test-sw-boot-probe / test-count-facts) and assert partial-JSON,
 * complete-JSON, and no-JSON cases.
 */
import assert from 'node:assert/strict';

function sanitizeFinalContent(text) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.full_story === 'string' && obj.full_story.trim()) return obj.full_story;
    } catch { /* fall through */ }
  }
  if (trimmed.startsWith('{')) {
    const m = trimmed.match(/"full_story"\s*:\s*"([\s\S]*)/);
    if (m) {
      let val = m[1];
      let end = -1;
      for (let i = 0; i < val.length; i++) {
        if (val[i] === '\\') { i++; continue; }
        if (val[i] === '"') { end = i; break; }
      }
      if (end >= 0) val = val.slice(0, end);
      val = val.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      val = val.replace(/\\+$/, '');
      return val;
    }
  }
  const cleaned = [];
  for (const line of trimmed.split('\n')) {
    const lt = line.trim();
    if (lt.startsWith('{') && !lt.includes('}')) continue;
    cleaned.push(line);
  }
  return cleaned.join('\n');
}

// Partial JSON mid-stream: only the in-progress prose shows, no envelope.
assert.equal(sanitizeFinalContent('{ "full_story": "Hening sejenak'), 'Hening sejenak');
assert.equal(sanitizeFinalContent('{ "full_story": "Halo\\nDunia'), 'Halo\nDunia');
// More tokens arrive; closing quote + rest of envelope handled.
assert.equal(sanitizeFinalContent('{ "full_story": "Halo", "audio_segments": [] }'), 'Halo');
// Complete envelope parsed via JSON.
assert.equal(sanitizeFinalContent('{ "full_story": "Baris1\\nBaris2", "audio_segments": [] }'), 'Baris1\nBaris2');
// No JSON at all — prose passthrough.
assert.equal(sanitizeFinalContent('Hening sejenak menyelimuti ruang.'), 'Hening sejenak menyelimuti ruang.');
// Empty/garbage safe.
assert.equal(sanitizeFinalContent(''), '');
assert.equal(sanitizeFinalContent(null), '');
// Escaped quote inside story doesn't prematurely close.
assert.equal(sanitizeFinalContent('{ "full_story": "Dia berkata \\"halo\\" dan men'), 'Dia berkata "halo" dan men');

console.log('OK — sanitize-streaming self-check passed');
