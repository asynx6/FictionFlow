#!/usr/bin/env node
/**
 * FictionFlow bootstrap + start (cross-platform).
 * Replaces run.ps1 / run.sh.
 *
 * Steps: check node → install deps → build CSS → bootstrap .env → validate API key → start backend.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

const c = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function log(msg) { console.log(c.cyan('[run]'), msg); }
function ok(msg) { console.log(c.green('[ok] '), msg); }
function err(msg) { console.error(c.red('[err]'), msg); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: isWin,
    cwd: opts.cwd || ROOT,
    env: process.env,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function ensureNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 18) {
    err(`Node.js >= 18 required (found ${process.version}). Install from https://nodejs.org`);
    process.exit(1);
  }
  ok(`Node ${process.version}`);
}

function ensureDeps(dir, label) {
  const nm = join(ROOT, dir, 'node_modules');
  if (existsSync(nm)) {
    ok(`${label} dependencies already installed.`);
    return;
  }
  log(`Installing ${label} dependencies...`);
  run(npmCmd, ['install'], { cwd: join(ROOT, dir) });
  ok(`${label} dependencies installed.`);
}

function buildCss() {
  log('Building frontend CSS...');
  run(npmCmd, ['run', 'build:css'], { cwd: join(ROOT, 'frontend') });
  ok('Frontend CSS built → frontend/public/css/tailwind.output.css');
}

function bootstrapEnv() {
  const envPath = join(ROOT, 'backend', '.env');
  const example = join(ROOT, 'backend', '.env.example');
  if (existsSync(envPath)) {
    ok('backend/.env already exists.');
    return;
  }
  if (!existsSync(example)) {
    err('backend/.env.example tidak ditemukan. Tidak bisa bootstrap .env.');
    process.exit(1);
  }
  log('Creating backend/.env from .env.example...');
  copyFileSync(example, envPath);
  ok('backend/.env created.');
}

function readEnvValues() {
  const envPath = join(ROOT, 'backend', '.env');
  const text = readFileSync(envPath, 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function isPlaceholder(value) {
  if (!value || !value.trim()) return true;
  return /xxxx|your-key|change.?me|^<.*>$/i.test(value);
}

function validateProviderEnv() {
  log('Checking provider env (.env-only configuration)...');
  const env = readEnvValues();
  const missing = [];
  if (isPlaceholder(env.MODEL_PROVIDER_BASE_URL)) missing.push('MODEL_PROVIDER_BASE_URL');
  if (isPlaceholder(env.MODEL_PROVIDER_API_KEY)) missing.push('MODEL_PROVIDER_API_KEY');
  if (isPlaceholder(env.DEFAULT_MODEL_ID)) missing.push('DEFAULT_MODEL_ID');

  if (missing.length > 0) {
    console.log('');
    console.log(c.red('================================'));
    console.log(c.red('  .env tidak lengkap'));
    console.log(c.red('================================'));
    console.log('');
    console.log('  Field WAJIB di backend/.env:');
    for (const k of missing) console.log(`   - ${k}`);
    console.log('');
    console.log('  Buka file:  backend/.env');
    console.log('  Contoh (pakai OpenRouter):');
    console.log('    MODEL_PROVIDER_BASE_URL=https://openrouter.ai/api/v1');
    console.log('    MODEL_PROVIDER_API_KEY=sk-xxxxxxxxxxxxxxxx');
    console.log('    DEFAULT_MODEL_ID=openrouter/auto');
    console.log('');
    console.log('  Atau 9Router lokal (port 20128):');
    console.log('    MODEL_PROVIDER_BASE_URL=http://localhost:20128/v1');
    console.log('    MODEL_PROVIDER_API_KEY=anything');
    console.log('    DEFAULT_MODEL_ID=im/DeepSeek-V4-Flash');
    console.log('');
    process.exit(1);
  }

  ok(
    `provider env OK (url=${env.MODEL_PROVIDER_BASE_URL}, ` +
      `model=${env.DEFAULT_MODEL_ID}, ` +
      `key len=${env.MODEL_PROVIDER_API_KEY.length}).`
  );
}

function startBackend(dev) {
  const port = process.env.PORT || '3000';
  console.log('');
  console.log(c.green('================================'));
  console.log(c.green('  Starting FictionFlow'));
  console.log(c.green('================================'));
  console.log('');
  console.log(c.cyan(`  Backend + Frontend:  http://localhost:${port}`));
  console.log('  Tekan Ctrl+C untuk stop');
  console.log('');

  const script = dev ? 'dev' : 'start';
  const child = spawn(npmCmd, ['run', script], {
    cwd: join(ROOT, 'backend'),
    stdio: 'inherit',
    shell: isWin,
    env: process.env,
  });

  const forward = (sig) => {
    if (!child.killed) child.kill(sig);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}

function main() {
  const args = new Set(process.argv.slice(2));
  const dev = args.has('--dev');
  const skipInstall = args.has('--skip-install');

  console.log('');
  console.log(c.cyan('================================'));
  console.log(c.cyan('  FictionFlow — Quick Run'));
  console.log(c.cyan('================================'));
  console.log('');

  ensureNode();

  if (!existsSync(join(ROOT, 'frontend', 'package.json'))) {
    err('frontend/package.json tidak ditemukan.');
    process.exit(1);
  }
  if (!existsSync(join(ROOT, 'backend', 'package.json'))) {
    err('backend/package.json tidak ditemukan.');
    process.exit(1);
  }

  if (!skipInstall) {
    ensureDeps('backend', 'Backend');
    ensureDeps('frontend', 'Frontend');
  }

  buildCss();
  bootstrapEnv();
  validateProviderEnv();
  startBackend(dev);
}

main();
