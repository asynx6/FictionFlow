# AI Prompt Overhaul + Memory System Smart

## Overview

Tambah mode roleplay pilihan ("Default" vs "Casual") + memory system pintar untuk pengalaman roleplay yang natural, unfiltered, dan konsisten.

### Tiga goal utama
1. **Mode Casual** — gaya chat natural, ekspresi markdown italic, no content filter
2. **Mode Default tetap** — prompt existing tidak berubah
3. **Memory system pintar** — update/hapus/rangkum memori otomatis

---

## 1. Mode Roleplay Selection

### Tambah kolom `roleplay_mode` di tabel stories
- Tipe: TEXT DEFAULT 'default'
- Nilai: 'default' | 'casual'

### Saat buat session (index.html)
- Tambah dropdown/selector "Mode Roleplay" di form
- Pilihan: "Default (Naratif)" | "Casual (Chat Natural)"
- Kirim sebagai `roleplay_mode` ke POST /api/stories

### Saat chat (promptBuilder.service.js)
- `renderSystemPrompt()` → untuk mode 'default' (tidak berubah)
- `renderCasualSystemPrompt()` → BARU, untuk mode 'casual'
- `memoryManager.service.js` → pilih fungsi prompt berdasarkan `story.roleplay_mode`

### Prompt Casual — key changes vs Default:
- Gaya santai, ekspresi `_italic_`, dialog `"..."`
- Blok "# Batasan Konten" — no filter, ikuti cerita apapun
- Format JSON tetap (`full_story` + `audio_segments`) untuk TTS

---

## 2. Memory System — Smart & Self-Optimizing

### a) Update — sudah ada (mergeFacts) ✓
### b) Delete fakta obsolete — BARU
- `callMemoryAuditor()` — LLM call deteksi konflik/obsolete
- Trigger: saat extractor menemukan fakta dengan key sama tapi value berbeda
### c) Rangkum — BARU
- Threshold 50+ fakta → summarization LLM
- Gabung fakta redundant, return max 30 fakta

---

## 3. File yang Diubah

| File | Perubahan |
|------|-----------|
| `backend/src/db/schema.sql` | Tambah kolom `roleplay_mode` |
| `backend/src/controllers/stories.controller.js` | Validasi + simpan `roleplay_mode` |
| `backend/src/services/promptBuilder.service.js` | Tambah `renderCasualSystemPrompt()` |
| `backend/src/services/memoryManager.service.js` | Pilih prompt berdasarkan mode |
| `backend/src/services/memoryExtractor.service.js` | Tambah auditor + summarizer |
| `frontend/public/index.html` | Tambah dropdown Mode Roleplay |
| `frontend/public/js/pages/dashboard.page.js` | Kirim `roleplay_mode` saat create |
| `frontend/public/js/pages/story.page.js` | Tampilkan mode di header |
