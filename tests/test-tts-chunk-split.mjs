/**
 * Self-check: _splitTtsChunks for incremental TTS playback.
 * Run: node tests/test-tts-chunk-split.mjs
 *
 * _splitTtsChunks is private in story.page.js; mirror it here and assert
 * sentence boundaries, max-char hard wrap, and whitespace collapse.
 */
import assert from 'node:assert/strict';

const TTS_CHUNK_MAX_CHARS = 160;

function _splitTtsChunks(text) {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out = [];
  let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (let i = 0; i < clean.length; i++) {
    buf += clean[i];
    const ch = clean[i];
    if ('.!?…'.includes(ch)) {
      let j = i + 1;
      while (j < clean.length && '")’”'.includes(clean[j])) { buf += clean[j]; j++; }
      flush();
      i = j - 1;
      continue;
    }
    if (clean[i] === '\n') { flush(); continue; }
    if (buf.length >= TTS_CHUNK_MAX_CHARS) { flush(); }
  }
  flush();
  return out;
}

// Empty.
assert.deepEqual(_splitTtsChunks(''), []);
assert.deepEqual(_splitTtsChunks('   '), []);

// Single sentence → one chunk.
assert.deepEqual(_splitTtsChunks('Halo sayang.'), ['Halo sayang.']);

// Multiple sentences split at . ! ?
const multi = _splitTtsChunks('Halo sayang. Aku kangen! Apa kabar?');
assert.equal(multi.length, 3);
assert.equal(multi[0], 'Halo sayang.');
assert.equal(multi[1], 'Aku kangen!');
assert.equal(multi[2], 'Apa kabar?');

// Trailing quote kept with sentence.
const q = _splitTtsChunks('"Aku kangen." Dia tersenyum.');
assert.equal(q[0], '"Aku kangen."');
assert.equal(q[1], 'Dia tersenyum.');

// Long run hard-wraps at max chars.
const long = _splitTtsChunks('a'.repeat(400));
assert.ok(long.length >= 2, 'long text splits into multiple chunks');
for (const c of long) assert.ok(c.length <= TTS_CHUNK_MAX_CHARS + 5, `chunk within budget: ${c.length}`);

// Whitespace collapse (newlines → space).
const ws = _splitTtsChunks('Halo   sayang.\n\nAku   kangen.');
assert.deepEqual(ws, ['Halo sayang.', 'Aku kangen.']);

// First chunk is short (fast cold-start) for a typical message.
const typical = _splitTtsChunks('Aku juga kangen, sayang. Awas aja jangan telat, ya, atau gue samperin ke rumah lo!');
assert.ok(typical[0].length <= TTS_CHUNK_MAX_CHARS, 'first chunk short');
assert.equal(typical.length, 2);

console.log('OK — tts chunk-split self-check passed');
