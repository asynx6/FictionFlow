#!/usr/bin/env node
/**
 * FictionFlow dev watch — auto-reload on file changes.
 *
 * Triggers (debounced):
 *   - backend/.env          → respawn backend (env reloaded)
 *   - backend/src/_ + .js   → respawn backend (node --watch handles too, but
 *                              we also clean up + show source paths)
 *   - frontend/public/css/_ → incremental `npm run build:css` (tailwind only)
 *   - frontend/public/{story,index}.html + js/_ → log only (static serve picks up)
 *
 * Zero new dependencies. Uses Node ≥20 native fs.watch.
 *
 * Usage:
 *   node scripts/watch.mjs
 *   npm run dev
 *
 * Flags:
 *   --self-test    exit after classifying one fake-change event (for tests).
 *   --skip-install skip npm install checks (assumes deps exist).
 */
import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { dirname, join, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

const args = new Set(process.argv.slice(2));
const SELF_TEST = args.has('--self-test');
if (SELF_TEST) args.delete('--self-test');

const FRONTEND = join(ROOT, 'frontend');
const BACKEND = join(ROOT, 'backend');
const FRONTEND_CSS = join(FRONTEND, 'public', 'css');
const FRONTEND_JS = join(FRONTEND, 'public', 'js');
const FRONTEND_PUBLIC = join(FRONTEND, 'public');
const BACKEND_SRC = join(BACKEND, 'src');
const BACKEND_ENV = join(BACKEND, '.env');

const c = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const log = (m) => console.log(`${c.cyan('[watch]')} ${m}`);
const ok = (m) => console.log(`${c.green('[ok]   ')} ${m}`);
const warn = (m) => console.log(`${c.yellow('[warn] ')} ${m}`);
const err = (m) => console.log(`${c.red('[err]  ')} ${m}`);
const dim = (m) => console.log(`${c.dim('       ' + m)}`);

// --- classify file change ---
function classify(filePath) {
  const rel = relative(ROOT, filePath).split(sep).join('/');
  if (!rel || rel.startsWith('..')) return null;

  if (rel === 'backend/.env') return 'backend-env';
  if (rel.startsWith('backend/src/') && rel.endsWith('.js')) return 'backend-src';
  if (rel.startsWith('frontend/public/css/')) return 'frontend-css';
  if (rel === 'frontend/public/story.html' || rel === 'frontend/public/index.html') return 'frontend-html';
  if (rel.startsWith('frontend/public/js/') && rel.endsWith('.js')) return 'frontend-js';
  return null;
}

// --- debouncer ---
function debounce(fn, ms) {
  let timer = null;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...lastArgs);
    }, ms);
  };
}

// --- pipeline: classify many events at once ---
const handledRecently = new Map();
function dedupPath(filePath, ttlMs = 150) {
  const now = Date.now();
  const last = handledRecently.get(filePath) || 0;
  if (now - last < ttlMs) return false;
  handledRecently.set(filePath, now);
  // GC
  for (const [k, t] of handledRecently) {
    if (now - t > 5000) handledRecently.delete(k);
  }
  return true;
}

// --- backend child ---
let backend = null;
let backendStarting = false;

async function startBackend() {
  if (backendStarting) return;
  backendStarting = true;
  await killBackend();
  backendStarting = false;

  log(`spawn backend → node ${join(BACKEND, 'src', 'server.js')}`);
  backend = spawn(process.execPath, [join(BACKEND, 'src', 'server.js')], {
    cwd: BACKEND,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });

  backend.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (code === 0 || signal) return;
    warn(`backend exited code=${code}. Will respawn on next file change.`);
  });
}

async function killBackend() {
  if (!backend) return;
  const child = backend;
  backend = null;
  await new Promise((resolve) => {
    if (!child.killed && child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    const done = () => resolve();
    child.once('exit', done);
    // hard kill fallback after 3s
    setTimeout(() => {
      try { if (!child.killed) child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 3000);
  });
}

// --- tailwind one-shot rebuild ---
let cssBusy = false;
async function rebuildCss() {
  if (cssBusy) return;
  cssBusy = true;
  log(`rebuilding CSS → ${c.dim('tailwindcss (input.css → output.css)')}`);
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(npmCmd, ['run', 'build:css'], {
        cwd: FRONTEND,
        stdio: 'inherit',
        shell: isWin,
        env: process.env,
      });
      proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
      proc.on('error', reject);
    });
    ok('CSS rebuilt.');
  } catch (e) {
    err(`CSS rebuild failed: ${e.message}`);
  } finally {
    cssBusy = false;
  }
}

// --- handlers ---
const triggerBackendRestart = debounce(async (path) => {
  ok(`restarting backend (${path})`);
  await startBackend();
}, 300);

const triggerCssRebuild = debounce(async (path) => {
  await rebuildCss();
  dim(`trigger: ${path}`);
}, 250);

function onChange(filePath) {
  if (!dedupPath(filePath)) return;
  const kind = classify(filePath);
  const rel = relative(ROOT, filePath);
  if (!kind) return;

  if (kind === 'backend-env' || kind === 'backend-src') {
    triggerBackendRestart(rel);
  } else if (kind === 'frontend-css') {
    triggerCssRebuild(rel);
  } else if (kind === 'frontend-html' || kind === 'frontend-js') {
    // static serve picks up next request — just log
    log(`${c.dim('frontend')} reloaded on next browser fetch: ${rel}`);
  }
}

// --- watch loop ---
function startWatching() {
  const dirs = [BACKEND_ENV, BACKEND_SRC, FRONTEND_PUBLIC];
  for (const target of dirs) {
    if (!existsSync(target)) continue;
    try {
      const watcher = watch(target, { recursive: true }, (event, name) => {
        if (!name) return;
        const fullPath = join(target, name);
        onChange(fullPath);
      });
      watcher.on('error', (e) => warn(`watcher error on ${target}: ${e.message}`));
      log(`watching ${relative(ROOT, target)}`);
    } catch (e) {
      err(`cannot watch ${target}: ${e.message}`);
    }
  }
}

// --- graceful shutdown ---
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, shutting down…`);
  await killBackend();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- self-test (used by tests/dev-watch.test.mjs) ---
if (SELF_TEST) {
  // exercise classifier on a battery of paths
  const cases = [
    ['backend/.env', 'backend-env'],
    ['backend/src/server.js', 'backend-src'],
    ['backend/src/config/env.js', 'backend-src'],
    ['frontend/public/css/foo.css', 'frontend-css'],
    ['frontend/public/story.html', 'frontend-html'],
    ['frontend/public/index.html', 'frontend-html'],
    ['frontend/public/js/api/apiClient.js', 'frontend-js'],
    ['README.md', null],
    ['frontend/package.json', null],
    ['backend/data/sqlite.db', null],
  ];
  let pass = 0;
  for (const [p, expected] of cases) {
    const got = classify(p);
    if (got === expected) {
      pass++;
    } else {
      err(`classify(${p}) = ${got}, want ${expected}`);
    }
  }
  if (pass === cases.length) {
    ok(`self-test: ${pass}/${cases.length} cases pass`);
    process.exit(0);
  }
  process.exit(1);
}

// --- entry ---
console.log('');
console.log(c.cyan('================================'));
console.log(c.cyan('  FictionFlow — Dev Watch Mode'));
console.log(c.cyan('================================'));
console.log('');
ok('file watcher armed (CSS rebuild + backend restart). Ctrl+C untuk stop.');
console.log('');

startWatching();
startBackend();
