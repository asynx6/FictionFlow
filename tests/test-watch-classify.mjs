/**
 * Self-check: scripts/watch.mjs classifier.
 * Run: node tests/test-watch-classify.mjs
 *
 * Spawns `node scripts/watch.mjs --self-test` and asserts exit 0.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'watch.mjs'), '--self-test'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

const stdout = r.stdout?.toString() ?? '';
const stderr = r.stderr?.toString() ?? '';

assert.equal(r.status, 0, `self-test exited ${r.status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
assert.match(stdout, /self-test: 10\/10 cases pass/, `expected 10/10 pass, got:\n${stdout}`);
assert.match(stdout, /\[ok\]/, `no [ok] log produced`);

console.log('OK — watch.mjs classifier self-check passed');
