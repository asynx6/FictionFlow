/**
 * Self-check for DEFAULT_MODEL_ID[_1.._N] fallback chain.
 * Run: node tests/test-model-chain.mjs
 *
 * Strategies:
 *   - Use `node --import` to set process.env BEFORE env.js loads.
 *   - Restage backend/.env when the test specifically needs on-disk values.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ENV_PATH = './backend/.env';
const ORIGINAL_ENV = readFileSync(ENV_PATH, 'utf8');

function captureEnv(envText) {
  // Write a temp backend/.env → run a tiny script that imports
  // config/env.js and dumps MODEL_CHAIN to stdout. Restore the file at the
  // end so other tests aren't disrupted.
  writeFileSync(ENV_PATH, envText);
  try {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e',
        `import('./backend/src/config/env.js').then(m => console.log(JSON.stringify({ chain: m.env.MODEL_CHAIN, primary: m.env.DEFAULT_MODEL_ID, max: m.env.MAX_MODEL_SLOTS })));`
      ],
      { encoding: 'utf-8' }
    );
    if (r.status !== 0) {
      return { error: true, status: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    const lines = r.stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } finally {
    writeFileSync(ENV_PATH, ORIGINAL_ENV);
  }
}

function captureEnvFails(envText) {
  writeFileSync(ENV_PATH, envText);
  try {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e',
        `import('./backend/src/config/env.js').catch(e => console.error('IMPORT_ERR', e.message));`
      ],
      { encoding: 'utf-8' }
    );
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    writeFileSync(ENV_PATH, ORIGINAL_ENV);
  }
}

// ── Case 1: only DEFAULT_MODEL_ID, no chain ──
let out = captureEnv(
  'MODEL_PROVIDER_BASE_URL=http://x/\nMODEL_PROVIDER_API_KEY=k\nDEFAULT_MODEL_ID=m0\n'
);
assert.equal(out.chain.length, 1, 'single slot');
assert.equal(out.chain[0].value, 'm0');
assert.equal(out.chain[0].slot, 0);
assert.equal(out.chain[0].key, 'DEFAULT_MODEL_ID');
assert.equal(out.primary, 'm0');
assert.equal(out.max, 11);

// ── Case 2: skip empty slots in the middle ──
out = captureEnv(
  'MODEL_PROVIDER_BASE_URL=http://x/\nMODEL_PROVIDER_API_KEY=k\n' +
  'DEFAULT_MODEL_ID=m0\n' +
  'DEFAULT_MODEL_ID_2=m2\n'
);
assert.equal(out.chain.length, 2, 'empty slots are skipped');
assert.deepEqual(out.chain.map((e) => e.value), ['m0', 'm2']);
assert.equal(out.chain[0].slot, 0);
assert.equal(out.chain[1].slot, 2);

// ── Case 3: full 11-slot chain ──
const lines = ['MODEL_PROVIDER_BASE_URL=http://x/', 'MODEL_PROVIDER_API_KEY=k'];
lines.push('DEFAULT_MODEL_ID=m0');
for (let i = 1; i <= 10; i++) lines.push(`DEFAULT_MODEL_ID_${i}=m${i}`);
out = captureEnv(lines.join('\n') + '\n');
assert.equal(out.chain.length, 11);
assert.deepEqual(out.chain.map((e) => e.slot), [0,1,2,3,4,5,6,7,8,9,10]);
assert.equal(out.chain[0].key, 'DEFAULT_MODEL_ID');
for (let i = 1; i <= 10; i++) {
  assert.equal(out.chain[i].key, `DEFAULT_MODEL_ID_${i}`);
  assert.equal(out.chain[i].value, `m${i}`);
}

// ── Case 4: env-too-many check (we silently accept; user edit responsibility).
// Just verify 12+ doesn't crash — ordering still goes up to _10.
out = captureEnv(
  'MODEL_PROVIDER_BASE_URL=http://x/\nMODEL_PROVIDER_API_KEY=k\n' +
  'DEFAULT_MODEL_ID=m0\nDEFAULT_MODEL_ID_10=m10a\nDEFAULT_MODEL_ID_15=ignored\n'
);
assert.equal(out.chain.length, 2);
assert.deepEqual(out.chain.map((e) => e.value), ['m0', 'm10a']);

// ── Case 5: missing DEFAULT_MODEL_ID → fail-fast (exit non-zero) ──
out = captureEnvFails(
  'MODEL_PROVIDER_BASE_URL=http://x/\nMODEL_PROVIDER_API_KEY=k\n'
);
assert.notEqual(out.status, 0, 'must fail when DEFAULT_MODEL_ID absent');
assert.match(out.stderr, /DEFAULT_MODEL_ID/, 'must name the missing key');

console.log('OK — model-chain parsing self-check passed');
