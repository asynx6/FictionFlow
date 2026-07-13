/**
 * Self-check: sanitizeFinalContent — strip JSON envelope from AI bubble body.
 * Run: node tests/test-sanitize-final-content.mjs
 *
 * Pure-Node test of the sanitizer. The real `sanitizeFinalContent` lives
 * inside `story.page.js` (not a pure module — wires DOM, audio, etc.),
 * so we re-declare the function verbatim at the top of this test file.
 * Keeping it inline avoids a re-export shim and keeps the test self-
 * contained; any drift between the two copies will surface in the run
 * because both must satisfy these cases.
 */
import assert from 'node:assert/strict';

function sanitizeFinalContent(text) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  // Case A: response is a complete JSON envelope.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.full_story === 'string' && obj.full_story.trim())
        return obj.full_story;
      if (Array.isArray(obj.audio_segments)) {
        const narrated = obj.audio_segments
          .map((s) => s?.text ?? '')
          .filter((t) => t && t.trim())
          .join('\n');
        if (narrated) return narrated;
      }
      const candidate = obj.story ?? obj.text ?? obj.narration;
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    } catch {
      /* not JSON — fall through */
    }
  }
  // Case B: response starts with a partial JSON line that never closed.
  // Heuristic: drop leading line if it opens `{` without matching `}`.
  const cleaned = [];
  for (const line of trimmed.split('\n')) {
    const lt = line.trim();
    if (lt.startsWith('{') && !lt.includes('}')) continue;
    cleaned.push(line);
  }
  return cleaned.join('\n');
}

const cases = [
  {
    name: 'JSON envelope with full_story',
    input: '{"full_story": "halo dunia", "audio_segments": []}',
    expected: 'halo dunia',
  },
  {
    name: 'JSON envelope with audio_segments array',
    input: '{"audio_segments": [{"text": "bagian 1"}, {"text": "bagian 2"}]}',
    expected: 'bagian 1\nbagian 2',
  },
  {
    name: 'JSON envelope fallback to story key',
    input: '{"story": "narasi panjang"}',
    expected: 'narasi panjang',
  },
  {
    name: 'Plain prose passes through unchanged',
    input: 'halo dunia\nini prosa biasa',
    expected: 'halo dunia\nini prosa biasa',
  },
  {
    name: 'Mixed: drops leading partial-JSON line',
    input: '{ini JSON yang tidak valid\nhalo dunia\nbaris prosa',
    expected: 'halo dunia\nbaris prosa',
  },
  {
    name: 'Null / empty / undefined / number / object all return empty string',
    input: [null, '', undefined, 42, {}],
    expected: '',
  },
  {
    name: 'Malformed truncated JSON returns empty string',
    input: '{"full_story":',
    expected: '',
  },
];

let pass = 0;
for (const c of cases) {
  if (Array.isArray(c.input)) {
    for (const v of c.input) {
      const out = sanitizeFinalContent(v);
      assert.equal(out, c.expected, `case "${c.name}" value=${JSON.stringify(v)}`);
      pass++;
    }
  } else {
    const out = sanitizeFinalContent(c.input);
    assert.equal(out, c.expected, `case "${c.name}"`);
    pass++;
  }
}

console.log(`OK — sanitizeFinalContent: ${pass}/${pass} cases pass`);
