# FictionFlow

> Platform interaktif roleplay novel berbasis AI. Single-user, self-hosted, hemat RAM. Hybrid TTS via Microsoft Edge TTS (`edge-tts-universal` v1.4.0, Chrome 143 + MUID cookie auth — migrasi dari `@lixen/edge-tts` yang 403 setelah token rotation Feb 2026), 2-pack `id-ID`/`en-US` × male/female = 4 Neural voices + prosody 4-tuple `(type × gender)` untuk naturalisasi narasi + Web Speech API fallback (browser).

## ✨ Fitur

- 🎭 **Long-Term Memory** — AI tidak pernah lupa fakta inti cerita (nama, sifat, gaya bahasa, target ending)
- 🧠 **Short-Term Memory** — Hanya N pertukaran terakhir yang dikirim ke AI, hemat token untuk cerita panjang
- 🔄 **Two-Tier Memory Engine** — Sesuai spec di `docs/FictionFlow.md` Bab 6
- 🎙️ **Hybrid Multi-Voice TTS** — Server-synthesize via `edge-tts-universal` v1.4.0 (4 Neural voices: `id-ID-ArdiNeural`, `id-ID-GadisNeural`, `en-US-GuyNeural`, `en-US-JennyNeural`) + browser Web Speech fallback. **Prosody 4-tuple** `(type × gender)` → dialog female `+8%/+3Hz`, dialog male `+5%/+2Hz`, narration female `-2%/+1Hz`, narration male `-3%/+0Hz` — variasi ekspresi natural tanpa V2 voice (Indonesian Neural cuma 2 varian: Ardi+Gadis, tidak ada cheerful/serious). 2 voice pack pilihan user di Story settings. Backend emit `audio_segments[]` JSON + `gender` whitelist resolver (lowercase English exact, fallback ke `story.ai_gender`, default male), frontend queue manager play/cancel/skip + B6 SPA-replay-safe cache lifecycle
- 🛡️ **Crash-safe** — `process.once('uncaughtException')` race-pattern di service + filter di `server.js` agar 403 dari Microsoft endpoint tidak membunuh server
- 🎯 **Gender fidelity** — Whitelist-based gender resolver di controller + tightened prompter rule (no `perempuan`/`wanita`/`laki`/`cewek` Indonesian coercion → silent-fallback male lama) + Story-Identity consultation rule untuk AI/User speaker. End-to-end: Luna character female → GadisNeural bukan ArdiNeural lagi
- 📡 **Streaming Chat (SSE)** — Token demi token, tidak nunggu sampai selesai
- 🔌 **Pluggable Model Provider** — OpenRouter / 9Router / OpenAI-compatible lain
- 🗄️ **SQLite Lokal + Cache TTS** — Semua cerita dan riwayat tersimpan di `data/fictionflow.sqlite`; `message_tts` cache untuk replay segment

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

> ℹ️ Pada start pertama, folder `data/` dan file `fictionflow.sqlite` akan otomatis dibuat, semua tabel di-bootstrap (`stories`, `messages`, `message_facts`, `message_tts`).

---

## 🧩 Scripts Alternatif (Tanpa run.sh / run.ps1)

Kalau kamu lebih suka manual / untuk development:

| Perintah | Fungsi |
|---|---|
| `npm install --prefix backend` | Install dependency backend saja |
| `npm start --prefix backend` | Jalankan backend tanpa script helper |
| `npm run dev --prefix backend` | Backend dengan auto-reload (`node --watch`) |
| `npm run build:css --prefix frontend` | Rebuild `tailwind.output.css` (kalau ubah `tailwind.input.css`) |
| `node scratch/smoke.mjs` | End-to-end smoke test (perlu server jalan di PORT lain) |

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
│   ├── task.md                 # Task tracker internal
│   └── superpowers/            # Specs + plans post-audit
│       ├── specs/              # Design specs (YYYY-MM-DD-*.md)
│       └── plans/              # Implementation plans
├── tests/                      # Regression / E2E scripts
│   ├── fictionflow-chat.spec.js  # Playwright persistence E2E
│   ├── test-chat-endpoint.mjs    # Manual endpoint probe
│   ├── test-provider.mjs         # Model provider smoke
│   └── test-story-stream.mjs     # SSE stream smoke
├── scratch/                    # One-off scripts & debug snapshots (not production)
│   ├── smoke.mjs               # End-to-end smoke
│   ├── visual-test.js          # Playwright visual screenshot harness
│   └── test_*.ps1 / test_*.mjs # Misc helpers
├── backend/                    # Node.js + Express + SQLite
│   ├── package.json            # + @lixen/edge-tts
│   ├── .env.example            # Template env
│   └── src/
│       ├── server.js           # Entry point (uncaughtException filter, no kill on TTS 403)
│       ├── app.js              # Express wiring + static serve + /api mount
│       ├── config/             # env loader, fallback models
│       ├── db/                 # schema.sql (incl. message_tts), database.js, migrate.js
│       ├── routes/             # stories, messages, models, tts
│       ├── controllers/        # Business handlers
│       ├── services/           # promptBuilder, memoryManager, modelProvider, edgeTts
│       └── middlewares/        # errorHandler, requestLogger
└── frontend/                   # Vanilla JS + Tailwind (built, no build step)
    ├── public/                 # index.html, story.html, robots.txt
    ├── css/                    # tailwind.input.css + tailwind.output.css + chat-fixes.css
    ├── js/
    │   ├── api/                # apiClient.js (REST + synthesizeTts)
    │   ├── core/               # ttsQueueManager, eventBus, themeManager, api
    │   └── pages/              # story.page.js, dashboard.page.js
    └── tailwind.config.js
```

---

## 🛠️ API Singkat

Base URL: `http://localhost:3000/api`

| Method | Path | Fungsi |
|---|---|---|
| `GET` | `/health` | Cek status server |
| `GET` | `/models` | Daftar model dari provider |
| `POST` | `/generate/character` | Auto-derive user/AI name/personality dari prompt |
| `POST` | `/stories` | Buat story baru |
| `GET` | `/stories` | List semua story |
| `GET` | `/stories/:id` | Detail satu story |
| `PATCH` | `/stories/:id` | Edit title/premise/memory/model |
| `DELETE` | `/stories/:id` | Soft-delete story |
| `DELETE` | `/stories/:id/permanent` | Hard-delete story (cascade messages & tts cache) |
| `GET` | `/stories/:id/messages` | Riwayat pesan |
| `POST` | `/stories/:id/messages` | Kirim pesan → SSE stream balasan AI + `audio_segments[]` |
| `POST` | `/tts` | Server-synthesize TTS `{"text","gender"}` → MP3 Blob |

---

## 🎙️ TTS & Audio

AI membalas dengan struktur hybrid melalui sistem **2 voice pack** (pengaturan user di Story settings):

| Pack | Locale | Narration (male) | Dialogue female |
|------|--------|------------------|-----------------|
| Indonesian | `id-ID` | `id-ID-ArdiNeural` | `id-ID-GadisNeural` |
| English (US) | `en-US` | `en-US-GuyNeural` | `en-US-JennyNeural` |

Pemilihan pack disimpan di `localStorage.fictionflow_voice_pack` (default `id-ID`). Pack user menang atas hint apapun dari LLM. Setiap dialog ditandai dengan gender karakter sehingga backend otomatis pilih voice yang sesuai.

Backend emit SSE dengan field `audio_segments[]`:

```jsonc
{
  "message_id": 17,
  "full_content": "Malam itu hujan turun perlahan...",
  "audio_segments": [
    { "text": "Malam itu hujan turun perlahan...", "gender": "male",  "type": "narration", "voice_config": { "locale": "id-ID", "voice_name": "id-ID-ArdiNeural"  } },
    { "text": "Kamu kenapa diam dari tadi?",        "gender": "female","type": "dialogue",  "voice_config": { "locale": "id-ID", "voice_name": "id-ID-GadisNeural" } }
  ],
  "used_fallback_parse": false
}
```

Pipeline:
1. Backend `services/edgeTts.service.js` panggil `@lixen/edge-tts` per-segment → MP3 Blob. Hint dari LLM dinormalisasi (suffix `-Male`/`-Female` → `Neural`) sebelum dipakai; kalau tidak ada hint, suara dipilih berdasar `gender` + pack aktif dari request.
2. Frontend `core/ttsQueueManager.js` fetch via `apiClient.synthesizeTts()` → `<audio>` element, Antrian + skip/abort/8s timeout. Voice di-resolve dari pack aktif + segment gender (sumber kebenaran tunggal di `edgeVoiceForPack`).
3. Kalau EdgeTTS gagal (403 / network / 500 / hint tidak dikenal), fallback ke `window.speechSynthesis` per-segment di browser (lookup prefix-locale pack).

Endpoint server-side `POST /api/tts` tersedia untuk replay/ujian manual (body: `{text, voice?, gender?}` → MP3 Buffer + header `X-Tts-Voice`). Sekarang menerima `voice` eksplisit (e.g. `id-ID-GadisNeural`) atau derivasi otomatis dari `gender`.

---

## 🛡️ Stabilization (audit 2026-06-25)

Codebase full-audit scan (34 files, 17 findings: 2H/6M/5L/4I, 0C). Semua High + Medium sudah landed:

- **F1** Single-slot AI error dialog handlers (`story.page.js`)
- **F2** Bound 5s fact-poll timer + pagehide clear (`story.page.js`)
- **F3** `STORY_FIELD_MAX_LENGTH` enforced di `createStory` + `updateStory` (HttpError 413)
- **F4** `MAX_MESSAGE_CONTENT=20000` cap di `POST /messages`
- **F5** `_stashSegments`/`_readSegments` data-segments XSS guard
- **F6** Structured error log di `memoryExtractor`
- **F7** Delegated click di `dashboard.page.js` (no listener accumulation)
- **F8** `EventBus.off(event, listener)` API

Plus EdgeTTS crash mitigation dua layer:
1. Service `process.once('uncaughtException')` + named `removeListener` di `finally` (`runSynthesize`)
2. Filter `EdgeTTS|Unexpected server response` di `server.js` `uncaughtException`/`unhandledRejection` → no `exit(1)`

Verified smoke `POST /api/tts {text:'Halo',gender:'female'}` → 500 JSON bersih, `GET /api/health` setelahnya 200, process hidup.

LOW (5) + INFO (4) deferred — voice allowlist, dashboard escapeHtml, CDN SRI, prompt-injection framing, model_id whitelist, console.warn scrub, dead ternary, PRAGMA allowlist, unhandledRejection grace.

---

## 🔐 Catatan Keamanan

- `MODEL_PROVIDER_API_KEY` hanya di backend, tidak pernah dikirim ke browser.
- Semua data cerita tersimpan lokal di SQLite — tidak ada cloud sync di MVP.
- Single-user, tanpa login. Jika di-expose ke internet publik, tambahkan reverse-proxy (Caddy/Nginx) + basic auth.
- Input limits: `MAX_MESSAGE_CONTENT=20000`, `STORY_FIELD_MAX_LENGTH` map per-field, body 1 MB. LLM context & DB tidak akan tumbuh tak terbatas.

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
