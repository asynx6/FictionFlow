# FictionFlow — Task Tracker

## Phase 1: Core Build
### Backend
- [x] Root config files (package.json orchestrator, .gitignore, .env.example, README.md)
- [x] Backend: config (env.js, fallbackModels.json)
- [x] Backend: database init (schema.sql, database.js, seed.js)
- [x] Backend: services (promptBuilder, memoryManager, modelProvider)
- [x] Backend: controllers (stories, messages, models)
- [x] Backend: routes + middlewares + server.js
- [x] Backend: `npm install` (105 packages, zero vulnerabilities)

### Frontend
- [x] Tailwind config + hand-written `tailwind.output.css`
- [x] API client + state + markdown renderer
- [x] TTS engine + queue manager
- [x] Pages (dashboard, story)
- [x] HTML files (index.html, story.html, robots.txt)

## Phase 2: Verification
- [x] Smoke test 13/13 PASS (semua endpoint, DB init, auto-seed presets, static serving)
- [x] Bug fixes: FRONTEND_PUBLIC path (3x `..` → 2x `..`), dynamic SQL builder, child router param name
- [x] Walkthrough artifact

## Phase 3: Quick Start Scripts
- [x] `run.sh` untuk Linux/macOS/WSL/Git Bash (bash syntax OK)
- [x] `run.ps1` untuk Windows PowerShell (PS parser OK, forward-slash paths)
- [x] Functional test run.ps1: auto-create .env + detect placeholder + stop & warn (PASS)
- [x] Reset backend/.env (user mulai fresh)

## Phase 4: Folder Cleanup
- [x] Hapus `\.env.example` di root (cukup yang di `backend/`)
- [x] Hapus `\FictionFlow.md` di root (sudah ada di `docs/`)
- [x] Pindahkan `\task.md` → `docs/task.md`
- [x] Update `README.md` (quick start pakai `run.sh` / `run.ps1`)

## Final State
- [x] Test data dibersihkan (DB + .env user-facing)
- [x] User tinggal: jalankan `run.sh` / `run.ps1`, isi API key di Notepad, jalankan ulang
