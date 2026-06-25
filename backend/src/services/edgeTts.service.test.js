/**
 * Unit tests untuk prosodyFor() — per-(type, gender) prosody mapper.
 * Tujuan: pastikan semua 4 (type, gender) kombinasi mengembalikan tuple
 * signed yang sesuai regex edge-tts-universal `^[+-]\d+(%|Hz)$`, dan test
 * fallback ke narasi male ketika gender undefined.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { prosodyFor } from './edgeTts.service.js';

// Library regex requirement — bare '0%' ditolak.
const SIGNED_RE = /^[+-]\d+(%|Hz)$/;

test('prosodyFor: dialogue + female → paling ekspresif (+8% / +0% / +3Hz)', () => {
  const p = prosodyFor('dialogue', 'female');
  assert.equal(p.rate, '+8%');
  assert.equal(p.volume, '+0%');
  assert.equal(p.pitch, '+3Hz');
  for (const v of Object.values(p)) assert.match(v, SIGNED_RE);
});

test('prosodyFor: dialogue + male → agak cepat (+5% / +0% / +2Hz)', () => {
  const p = prosodyFor('dialogue', 'male');
  assert.equal(p.rate, '+5%');
  assert.equal(p.volume, '+0%');
  assert.equal(p.pitch, '+2Hz');
  for (const v of Object.values(p)) assert.match(v, SIGNED_RE);
});

test('prosodyFor: narration + female → +0% female narrating (-2% / +0% / +1Hz)', () => {
  const p = prosodyFor('narration', 'female');
  assert.equal(p.rate, '-2%');
  assert.equal(p.volume, '+0%');
  assert.equal(p.pitch, '+1Hz');
  for (const v of Object.values(p)) assert.match(v, SIGNED_RE);
});

test('prosodyFor: narration + male → gravitas, paling lambat (-3% / +0% / +0Hz)', () => {
  const p = prosodyFor('narration', 'male');
  assert.equal(p.rate, '-3%');
  assert.equal(p.volume, '+0%');
  assert.equal(p.pitch, '+0Hz');
  for (const v of Object.values(p)) assert.match(v, SIGNED_RE);
});

test('prosodyFor: gender=undefined → default ke male voice', () => {
  // Spec prosodyFor: gender=undefined / null / non-string → 'male'.
  // Combined dengan type='dialogue' → dialogue male tuple (+5%/+2Hz).
  const p = prosodyFor('dialogue', undefined);
  assert.equal(p.rate, '+5%');
  assert.equal(p.volume, '+0%');
  assert.equal(p.pitch, '+2Hz');
  for (const v of Object.values(p)) assert.match(v, SIGNED_RE);
});

test('prosodyFor: type=undefined → diperlakukan sebagai narration', () => {
  const p = prosodyFor(undefined, 'female');
  assert.equal(p.rate, '-2%');
  assert.equal(p.volume, '+0%');
  assert.equal(p.pitch, '+1Hz');
});

test('prosodyFor: gender=bukan-string (null/number) → male voice tuple', () => {
  // Combined dengan type='narration' → narration male tuple (gravitas).
  assert.deepEqual(prosodyFor('narration', null), { rate: '-3%', volume: '+0%', pitch: '+0Hz' });
  assert.deepEqual(prosodyFor('narration', 42), { rate: '-3%', volume: '+0%', pitch: '+0Hz' });
});

test('prosodyFor: type+gender keduanya undefined → safest default = narration male', () => {
  // Spec intent: kalau caller tidak kasih info apa-apa, default ke route
  // paling umum & paling aman (narasi laki-laki, gravitas). Fungsi apply
  // matrix: type≠'dialogue' → 'narration', gender≠'female' → 'male'.
  const p = prosodyFor(undefined, undefined);
  assert.equal(p.rate, '-3%');
  assert.equal(p.volume, '+0%');
  assert.equal(p.pitch, '+0Hz');
  for (const v of Object.values(p)) assert.match(v, SIGNED_RE);
});
