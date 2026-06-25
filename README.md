# FictionFlow

> Platform interaktif roleplay novel berbasis AI. Single-user, self-hosted, hemat RAM. TTS multi-suara 100% gratis via Web Speech API browser.

## ✨ Fitur

- 🎭 **Long-Term Memory** — AI tidak pernah lupa fakta inti cerita (nama, sifat, gaya bahasa, target ending)
- 🧠 **Short-Term Memory** — Hanya N pertukaran terakhir yang dikirim ke AI, hemat token untuk cerita panjang
- 🔄 **Two-Tier Memory Engine** — Sesuai spec di `docs/FictionFlow.md` Bab 6
- 🎙️ **Multi-Voice TTS** — Tag `[NARASI]` dan `[<AI_NAME>]` di-parsing dan dibacakan dengan suara berbeda
- 📡 **Streaming Chat (SSE)** — Token demi token, tidak nunggu sampai selesai
- 🔌 **Pluggable Model Provider** — OpenRouter / 9Router / OpenAI-compatible lain
- 🗄️ **SQLite Lokal** — Semua cerita dan riwayat tersimpan di file `data/fictionflow.sqlite`

---

## 🚀 Quick Start (1 Perintah, Tinggal Pakai)

### Prasyarat

- **Node.js ≥ 18** ([download](https://nodejs.org))
- API key dari **OpenRouter** ([https://openrouter.ai](https://openrouter.ai)) — atau provider OpenAI-compatible lain (9Router lokal, dll)

### Windows (PowerShell)

```powershell
cd c:\Users\Beni\Downloads\FictionFlow
.\run.ps1
```

### Linux / macOS / WSL / Git Bash

```bash
cd /path/to/FictionFlow
chmod +x run.sh
./run.sh
```

**Atau tanpa chmod** (jika `Permission denied`):

```bash
bash run.sh
```

> ℹ️ Script akan otomatis: install dependencies, copy `backend/.env.example` ke `backend/.env` jika belum ada, lalu **berhenti dan minta kamu mengisi API key** di Notepad/nano. Setelah diisi, jalankan ulang script yang sama.

### Alur kerja

```
Jalankan run.sh / run.ps1
        │
        ▼
  ┌──────────────┐
  │  Install deps│ (skip jika sudah ada)
  └──────┬───────┘
         ▼
  ┌──────────────┐
  │ Bootstrap    │ Copy backend/.env.example → backend/.env
  │ .env         │ (skip jika sudah ada)
  └──────┬───────┘
         ▼
  ┌──────────────┐
  │ Cek API key  │── placeholder? ─▶ STOP, minta user edit
  └──────┬───────┘ (sk-xxx/xxxx)
         ▼
  ┌──────────────┐
  │ Start server │ Backend (port 3000) + Frontend (static via Express)
  └──────────────┘
         ▼
  Buka http://localhost:3000 → 🎭
```

Buka browser: **http://localhost:3000** 🎉

> ℹ️ Pada start pertama, folder `data/` dan file `fictionflow.sqlite` akan otomatis dibuat, semua tabel di-bootstrap, dan voice presets default (untuk `NARASI`, `USER`, dan tag AI uppercase) akan ter-seed otomatis setiap kali kamu membuat cerita baru.

---

## 🧩 Scripts Alternatif (Tanpa run.sh / run.ps1)

Kalau kamu lebih suka manual / untuk development:

| Perintah | Fungsi |
|---|---|
| `npm install --prefix backend` | Install dependency backend saja |
| `npm install --prefix frontend` | Install dependency frontend saja |
| `npm start --prefix backend` | Jalankan backend tanpa script helper |
| `npm run dev --prefix backend` | Backend dengan auto-reload (`node --watch`) |
| `npm run build:css --prefix frontend` | Rebuild `tailwind.output.css` (kalau ubah `tailwind.input.css`) |

---

## 🗂️ Struktur Proyek

```
FictionFlow/
├── run.sh                      # Quick start (Linux/macOS/WSL/Git Bash)
├── run.ps1                     # Quick start (Windows PowerShell)
├── package.json                # Metadata + orchestrator
├── README.md                   # File ini
├── data/                       # SQLite auto-generated di sini
├── docs/
│   ├── FictionFlow.md          # Spesifikasi lengkap (Bab 1-17)
│   └── task.md                 # Task tracker internal
├── tests/                      # Regression / E2E scripts
│   ├── fictionflow-chat.spec.js  # Playwright persistence E2E
│   ├── test-chat-endpoint.mjs    # Manual endpoint probe
│   ├── test-provider.mjs         # Model provider smoke
│   └── test-story-stream.mjs     # SSE stream smoke
├── scratch/                    # One-off scripts & debug snapshots (not production)
│   ├── smoke.mjs               # End-to-end smoke (13/13 PASS)
│   ├── visual-test.js          # Playwright visual screenshot harness
│   └── test_*.ps1 / test_*.mjs # Misc helpers
├── backend/                    # Node.js + Express + SQLite
│   ├── package.json
│   ├── .env.example            # Template env (Copy-Item ke .env oleh run.ps1)
│   └── src/
│       ├── server.js           # Entry point (HTTP server)
│       ├── app.js              # Express wiring + static serve
│       ├── config/             # env loader, fallback models
│       ├── db/                 # schema.sql, database.js, seed.js
│       ├── routes/             # stories, messages, models, voicePresets
│       ├── controllers/        # Business handlers
│       ├── services/           # promptBuilder, memoryManager, modelProvider
│       └── middlewares/        # errorHandler, requestLogger
└── frontend/                   # Vanilla JS + Tailwind (built, no build step)
    ├── public/                 # index.html, story.html, robots.txt
    ├── css/                    # tailwind.input.css + tailwind.output.css
    ├── js/                     # api/, core/, pages/, state/
    └── tailwind.config.js
```

---

## 🛠️ API Singkat

Base URL: `http://localhost:3000/api/v1`

| Method | Path | Fungsi |
|---|---|---|
| `GET` | `/health` | Cek status server |
| `GET` | `/models` | Daftar model dari provider |
| `POST` | `/stories` | Buat story baru (+ auto-seed voice presets) |
| `GET` | `/stories` | List semua story |
| `GET` | `/stories/:id` | Detail satu story |
| `PATCH` | `/stories/:id` | Edit title/premise/memory/model |
| `DELETE` | `/stories/:id` | Hapus story (cascade messages & presets) |
| `GET` | `/stories/:id/messages` | Riwayat pesan |
| `POST` | `/stories/:id/messages` | Kirim pesan → SSE stream balasan AI |
| `GET` | `/stories/:id/voice-presets` | Lihat voice mapping per tag |
| `PATCH` | `/stories/:id/voice-presets/:presetId` | Update pitch/rate/volume untuk satu tag |

---

## 🎙️ TTS & Tag

AI akan selalu membalas dengan format tag `[]` di uppercase:

```
[NARASI] Malam itu hujan turun perlahan di atas atap station tua itu.
[KAISHI] Kamu kenapa diam dari tadi? Aku jadi khawatir, tahu.
[USER] Aku hanya berpikir... apakah ini semua nyata?
```

Tag akan di-parse di browser, lalu tiap segmen dibacakan dengan suara berbeda sesuai `voice_presets`. Pengaturan pitch/rate/volume bisa diubah lewat endpoint `PATCH /voice-presets/:id`.

Regex parsing di frontend: `\[([A-Z0-9_]+)\]` — hanya huruf besar, angka, dan underscore. Presisi sesuai spec Bab 10.

---

## 🔐 Catatan Keamanan

- `MODEL_PROVIDER_API_KEY` hanya di backend, tidak pernah dikirim ke browser.
- Semua data cerita tersimpan lokal di SQLite — tidak ada cloud sync di MVP.
- Single-user, tanpa login. Jika di-expose ke internet publik, tambahkan reverse-proxy (Caddy/Nginx) + basic auth.

---

## 🧪 Testing / Re-verifikasi

Smoke test end-to-end ada di `scratch/smoke.mjs`:

```powershell
# Terminal 1: start server di port 3789 (test mode)
$env:PORT = 3789; npm start --prefix backend

# Terminal 2: run smoke test
node scratch/smoke.mjs
```

Hasil: 13/13 PASS (semua endpoint, auto-seed, static serving, error handling).

---

## 📜 Lisensi

MIT — gunakan, modifikasi, dan distribusikan secara bebas.
