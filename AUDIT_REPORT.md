# FICTIONFLOW — LAPORAN AUDIT TOTAL
Tanggal audit: 2026-07-13
Auditor: GLM 5.2 (via multi-agent workflow: 4 cluster deep-read → adversarial verify → 3 end-to-end traces)
Status: DRAFT — untuk dieksekusi oleh DeepSeek V4 Pro

---

## RINGKASAN EKSEKUTIF

FictionFlow adalah platform roleplay AI Node.js + Express + SQLite (better-sqlite3) single-user self-hosted, dengan streaming SSE, memori dua-tingkat (short-term window + long-term `dynamic_memory` JSON), TTS Microsoft Edge Neural, dan PWA service worker. Audit ini membaca **seluruh** kode sumber (40 file backend/frontend, ~3770 baris) dan diverifikasi adversarial: 48 subagent, 645 tool call, setiap temuan HIGH/MEDIUM diperiksa ulang oleh skeptic yang membaca kode sebenarnya dan mencoba menyangkal.

Kondisi codebase: **stabilitas 5/10**. Arsitektur dasarnya sehat (fail-fast env validation, WAL+foreign_keys, fallback chain model, atomic rollback transaction, semaphore TTS global). Tapi ada satu kluster cacat yang **mengalahkan seluruh tujuan produk**: sistem memori long-term. Konvensi format `[KEY]: value` dipakai sebagai syarat pembeda antara "state fact" dan "narrative fact" di **tiga tempat terpisah** (dedup extractor, parser prompt, migration legacy), dan ketiganya **regex-exact** — tanpa normalisasi. Akibatnya setiap penyimpangan format dari LLM (tanpa bracket, lowercase, spasi sebelum colon) membuat fakta yang sama muncul dua kali (BUG-04) DAN tidak terbaca sebagai state oleh prompt builder (BUG-05). Kedua bug user terberat ini berakar pada **satu cacat struktural yang sama**, jadi satu perbaikan terpusat (normalisasi kanonik + satu sumber kebenaran tagged-key) menyelesaikan keduanya.

BUG-01 (notifikasi cache setiap refresh) dan BUG-02 (pesan terbaru hilang setelah refresh) juga berakar jelas: probe service worker membandingkan `?v=38` dari script tag terhadap `scriptURL` SW yang terdaftar sebagai `/sw.js` polos (tidak pernah match → timeout → toast), dan SW tidak mengecualikan `/api/*` GET dari cache SWR (pesan lama disajikan, baru dibuang). Keduanya fix localized 1-2 baris. BUG-03 (TTS lambat >2s) multi-cause: warmup men-sintesis string dummy yang cache-key-nya tak pernah cocok dengan pesan asli, tidak ada prewarm saat AI message baru selesai, dan fetch play-click tanpa timeout.

Urgensi: **HIGH**. Tiga dari lima bug user berdampak langsung pada inti pengalaman (roleplay continuity, memory reliability, TTS responsiveness). Perbaikan dapat dikerjakan berurutan tanpa konflik jika urutan task diikuti (lihat RENCANA EKSEKUSI). Tidak ada temuan CRITICAL (tidak ada data-loss pada happy path, tidak ada RCE/injection — parameterized queries, no raw HTML in markdown). Yang ada adalah degradasi kualitas yang akumulatif.

---

## STATISTIK TEMUAN

| Severity  | Jumlah (distink) |
|-----------|--------|
| CRITICAL  | 0      |
| HIGH      | 13     |
| MEDIUM    | 21     |
| LOW       | 28     |
| INFO      | 4      |
| TOTAL     | 66     |

Catatan verifikasi: dari 71 temuan awal, **3 di-REFUTE total** oleh verifier adversarial (C-002 voice-mismatch pre-synth — frontend pakai satu voice per story, bukan per-segment, jadi tidak ada mismatch; C-010 cache LRU vs FIFO — sebenarnya LRU yang benar, comment yang menyesatkan; D-003 ordering asymmetry — server sudah `desc.slice().reverse()` ke oldest-first per page, kedua renderer konsisten). **2 di-merge** karena ditemukan dua cluster独立 sebagai defect yang sama (C-004≡A-001 di-merge ke TEMUAN-001; C-005≡A-002 di-merge ke TEMUAN-002 — akar BUG-04/05 yang sama, fix yang sama). **2 di-downgrade** (A-006 MEDIUM→LOW: klaim "tidak ada semaphore global" salah, `edgeTts.service.js:140-161` punya semaphore MAX_CONCURRENT=3 global yang gate semua path; B-MEM-010 MEDIUM→LOW: klaim "prompt tumbuh tak terbatas" salah, capMemory/summarizer membatasi count ke 60/50, hanya bytes-per-fact yang unbounded dan worst-case ~18KB masih jauh di bawah cap 200KB). Verdict per-temuan dirangkum di bawah masing-masing temuan bertanda `[V: …]`. Total distink = 71 − 3 refuted − 2 merged = 66.

---

## DAFTAR TEMUAN — HIGH SEVERITY

### [TEMUAN-001] Dedup tagged-state fact hanya cocok format bracket eksak → duplikat (akar BUG-04)
- **Severity:** HIGH
- **File:** backend/src/services/memoryExtractor.service.js (juga ditemukan cluster C-stream sebagai C-004 — temuan sama, merge)
- **Baris:** 6-8 (regex), 170-197 (mergeRelationshipFacts), 56-58 (legacy migration emit), 290-299 (parse incoming tanpa normalisasi)
- **Kategori:** LOGIC_ERROR
- **Deskripsi:** `mergeRelationshipFacts` mempartisi fakta relationship ke `tagged` Map (satu-per-kunci, latest-wins) vs `narrative` array berdasarkan **satu-satunya** diskriminator: `TAGGED_KEY_PATTERN = /^\[[A-Z_]+\]:/`. Regex ini mensyaratkan bracket `[` pembuka, key uppercase+underscore, `]`, lalu `:` tanpa spasi. Tiga sumber format drift yang lolos:
  1. **Legacy migration** (baris 58): `out[cat].push(k ? \`${k}: ${v}\` : v)` menghasilkan `USER_PANGGILAN: kaishi` **tanpa bracket**. Tidak pernah match regex → masuk narrative.
  2. **LLM tidak patuh format**: prompt meminta `[KUNCI]: nilai` (baris 99-102) tapi tak ada penegakan. LLM sering emit `USER_PANGGILAN: kaishi`, `[user_panggilan]: kaishi` (lowercase), `[USER_PANGGILAN] kaishi` (tanpa colon), atau `[USER_PANGGILAN] : kaishi` (spasi sebelum colon). Semua gagal regex → masuk narrative.
  3. **Parse incoming tanpa normalisasi** (baris 290-299): `callExtractor` hanya `item.trim()`, tidak pernah kanonikalisasi ke bentuk bracket.
  Konsekuensi: fakta `USER_PANGGILAN: kaishi` (di narrative array) dan `[USER_PANGGILAN]: kaishi` (di tagged Map) **berdua survive** ke `[...tagged.values(), ...narrative]` (baris 196) karena narrative dedup (baris 190-192) hanya bandingkan case-insensitive equality **terhadap entry narrative lain**, tidak pernah terhadap nilai di tagged Map. Auditor (baris 416-429) dan summarizer (baris 492-504) juga exact-string match → tidak bisa menyembuhkan duplikat ini.
- **Root Cause:** Tidak ada langkah normalisasi/kanonikalisasi antara output LLM dan fungsi merge. Format bracket adalah konvensi yang LLM boleh langgar; tak ada yang menegakkan atau memperbaiki. Narrative dedup exact-string saja. Eksisting-array juga tidak self-dedup (baris 174-182 push verbatim).
- **Dampak ke User:** `relationship[]` menumpuk entri ganda+ untuk fakta state yang sama (mis. `USER_PANGGILAN: kaishi` muncul berkali-kali). Boros token prompt, bingungkan LLM. Persis gejala BUG-04.
- **Solusi yang Diperlukan:** Tambah pass normalisasi atas **setiap** fakta relationship (incoming DAN existing) sebelum merge: deteksi known TAGGED_KEYS terlepas dari bracket/case/spacing (regex toleran seperti `/^\s*\[?\s*(KEY)\s*\]?\s*[:\-]\s*(.*)$/i`) dan rewrite ke bentuk kanonik `[KEY]: value`. Map-keyed dedup yang ada lalu otomatis collapse. Juga self-dedup array existing saat load. Kanonikalisasi juga harus diterapkan di `normalizeDynamicMemory` legacy branch (emit `[KEY]: value` untuk key yang ada di TAGGED_KEYS). Buat SATU helper shared (lihat TEMUAN duplikasi parser di LOW).
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED] — semua klaim diverifikasi baris-per-baris; catatan minor: narrative loop juga dedup incoming-vs-later-incoming, tapi klaim load-bearing (existing tidak self-dedup, exact-string-only) valid.

### [TEMUAN-002] Blok KONTEKS SAAT INI kosong saat tagged fact tanpa bracket → AI tak terima state hubungan (akar BUG-05)
- **Severity:** HIGH
- **File:** backend/src/services/promptBuilder.service.js (juga C-005 — merge)
- **Baris:** 85-97 (parseRelationshipState), 110-112 (gate suppress), 114-140 (block content)
- **Kategori:** LOGIC_ERROR
- **Deskripsi:** `parseRelationshipState` mengekstrak state hanya via `fact.startsWith(\`[${key}]:\`)` — sama rigornya dengan regex extractor (TEMUAN-001). `buildCurrentContextBlock` (baris 110) return string kosong saat **tidak ada satupun** dari STATUS/AI_PANGGILAN/KONTEKS_PERILAKU/USER_PANGGILAN ditemukan. Karena TEMUAN-001 menunjukkan fakta tersimpan bisa tanpa bracket, `parseRelationshipState` tak menemukan apapun → blok `## KONTEKS SAAT INI [BACA INI SEBELUM MEMBALAS]` absen dari system prompt. AI hanya melihat fakta relationship sebagai baris bullet biasa di `=== DYNAMIC FACTS ===` (`renderDynamicFacts` baris 158-178) tanpa penekanan bahwa mis. status sudah `pacaran`. Instruksi kuat `Perilakumu HARUS mencerminkan konteks ini setiap saat` (baris 136) hanya muncul di dalam blok yang ter-suppress. AI memperlakukan konteks pacaran sebagai trivia low-salience → bereaksi seolah hubungan baru (mis. "udah berani manggil sayang ya?").
- **Root Cause:** `parseRelationshipState` dan `buildCurrentContextBlock` berbagi dependensi bracket-prefix yang sama rigil dengan dedup extractor. Dua konsumer konvensi bracket (merge + prompt surfacing) **berdua rusak identik** saat LLM omit bracket.
- **Dampak ke User:** AI tidak konsisten pakai konteks hubungan. Skenario pacaran tapi AI kaget dipanggil sayang. Persis BUG-05.
- **Solusi yang Diperlukan:** Buat deteksi tagged-key toleran terhadap missing bracket/case/spacing (normalisasi yang sama dengan fix TEMUAN-001), dipusatkan di **satu helper** yang dipakai extractor merge DAN `parseRelationshipState`. Setelah fakta disimpan kanonik, dedup dan prompt surfacing jalan dari satu sumber kebenaran. Tambahan: blok KONTEKS SAAT INI sebaiknya **selalu** di-emit (meski sebagian field kosong) dengan direktif bahwa baris `[KEY]: value` di Tentang Hubungan adalah state binding yang harus dipatuhi + panggil user pakai AI_PANGGILAN (lihat TEMUAN-007 untuk dekouple direktif dari keberadaan satu tagged field).
- **Terkait dengan Bug User:** BUG-05
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-003] Pesan user terbaru disuntik dua kali ke prompt AI
- **Severity:** HIGH
- **File:** backend/src/services/memoryManager.service.js
- **Baris:** 31-50 (buildContextPayload), 4-10 (getRecentStmt)
- **Kategori:** LOGIC_ERROR / CORRECTNESS
- **Deskripsi:** POST `/messages` (messages.routes.js:115) INSERT pesan user sinkron **sebelum** `streamChat` dipanggil. `buildContextPayload` lalu jalan `getRecentStmt` yang sudah include baris user yang baru di-insert sebagai elemen terakhir `recentAsc`, DAN append `latestUserMessage` lagi di baris 48-50. AI menerima turn user yang sama dua kali di array messages. better-sqlite3 sinkron jadi row sudah committed dan visible ke `getRecentStmt`.
- **Root Cause:** Insert dipindah sebelum streamChat (atau streamChat ditambah setelah insert) tapi `buildContextPayload` masih append `latestUserMessage` unconditionally dengan asumsi DB fetch mengecualikannya.
- **Dampak ke User:** AI lihat pesan user duplikat, boros token, mungkin merespon dua kali atau behave inkonsisten. Berkontribusi BUG-05 (AI tak behave sesuai konteks).
- **Solusi yang Diperlukan:** Pilih satu sumber kebenaran untuk turn user terbaru: (a) exclude user row terbaru dari `getRecentStmt` via bound id (`WHERE id < ?`), atau (b) berhenti append `latestUserMessage` karena sudah di recent window. Jangan dua-duanya.
- **Terkait dengan Bug User:** BUG-05
- **Verifikasi:** [V: CONFIRMED] — ⚠️ PERLU KLARIFIKASI: apakah double-injection ini disengaja sebagai teknik "last message emphasis"? Tidak ada comment yang mengindikasikan intent; verify hanya konfirmasi structural double-include. Jika disengaja, dokumentasikan; jika tidak, fix.

### [TEMUAN-004] capMemory evict tagged relationship fact PERTAMA (komparator terbalik)
- **Severity:** HIGH
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 242-253 (capMemory sort + slice)
- **Kategori:** LOGIC_ERROR / CORRECTNESS
- **Deskripsi:** `capMemory` flatten semua fakta, sort tagged-relationship ke depan (aIsTagged=0) dan non-tagged ke belakang (1), lalu ambil `flat.slice(-60)` = **60 TERAKHIR**. Saat total > 60, elemen pertama (tagged) di-drop duluan. Contoh: 5 tagged + 65 narrative → `slice(-60)` drop indeks 0-9 = **semua 5 tagged + 5 narrative**. Comment doc (baris 232-234) bilang "Keep tagged relationship state last... never trim unless absolutely necessary" — kode lakukan kebalikannya.
- **Root Cause:** Arah sort dan arah slice tidak konsisten dengan intent: sort tagged ke indeks 0 lalu slice tail membuang tagged duluan.
- **Dampak ke User:** Saat story akumulasi >60 fakta, fakta state tertinggi-value (STATUS, AI_PANGGILAN, USER_PANGGILAN, KONTEKS_PERILAKU) **silently dihapus**, narrative low-value survive. AI kehilangan state hubungan → gejala BUG-05. Summarizer (>50) dan auditor (≥50) biasanya jalan sebelum cap menggigit, tapi burst >60 langsung buang tagged.
- **Solusi yang Diperlukan:** Salah satu: sort tagged ke END (aIsTagged=1, non-tagged=0) sehingga `slice(-60)` keep tagged, ATAU `slice(0, 60)` dengan tagged sorted ke depan. Rekonsiliasi arah dengan intent + tambah guard bahwa tagged fact tidak pernah di-trim. Verifikasi dengan unit test: 5 tagged + 65 narrative → 5 tagged survive.
- **Terkait dengan Bug User:** BUG-05
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-005] Klasifikasi tagged-fact bergantung regex eksak; drift format LLM bikin duplikat (BUG-04 varian)
- **Severity:** HIGH
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 7-8 (regex), 170-197
- **Kategori:** LOGIC_ERROR / CORRECTNESS
- **Deskripsi:** Ini overlap dengan TEMUAN-001 (akar yang sama) tapi menekankan sudut berbeda: `TAGGED_KEY_PATTERN = /^\[[A-Z_]+\]:/` mensyaratkan `[UPPER]` langsung diikuti colon tanpa spasi. `mergeRelationshipFacts` hanya dedup fakta sebagai tagged jika match regex ini; else masuk narrative dedup (case-insensitive exact equality). Jika LLM return `[USER_PANGGILAN] : kaishi` (spasi), `[User_Panggilan]: kaishi` (mixed case), atau `USER_PANGGILAN: kaishi` (no brackets), fakta diklasifikasi narrative dan ditambah BERSAMA existing bracketed `[USER_PANGGILAN]: kaishi` → double entry.
- **Root Cause:** Dedup keying diturunkan dari regex-match raw LLM text, bukan parse `[KEY]` struktural dengan normalisasi toleran. LLM unreliable di exact bracket-colon formatting.
- **Dampak ke User:** `relationship[]` akumulasi duplikat semantik tagged fact dengan formatting sedikit beda (BUG-04). Array bloat, AI lihat state value konflik.
- **Solusi yang Diperlukan:** Parse leading `[KEY]` toleran: allow optional whitespace sebelum/sesudah colon, case-insensitive key match terhadap known key set, lalu normalize ke `[KEY]: value` kanonik sebelum dedup. Treat apapun yang stripped-lowercased key-nya match known tagged key sebagai tagged, terlepas formatting. (Sama dengan fix TEMUAN-001 — kerjakan sekali, selesai.)
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-006] Read-modify-write `dynamic_memory` tanpa serialisasi (extractor + auditor + summarizer konkuren)
- **Severity:** HIGH
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 314-343 (extractAndMergeFacts), 341-342 (spawn auditor+summarizer paralel)
- **Kategori:** RACE_CONDITION
- **Deskripsi:** `extractAndMergeFacts` baca `story.dynamic_memory` (snapshot dari `getStoryStmt.get` saat request masuk), await extractor LLM yang lambat, lalu tulis merged via `updateMemoryStmt.run`. Setelah write, fire `callMemoryAuditor` DAN `summarizeFacts` paralel (baris 341-342), masing-masing melakukan read-modify-write sendiri pada `dynamic_memory`. Jika ekstraksi turn user berikutnya mulai sebelum yang ini selesai, 2-3 writer konkuren clobber last-write-wins. Auditor (baris 395) dan summarizer (baris 473) re-read dari DB, tapi keduanya spawn bersamaan tanpa koordinasi → yang selesai terakhir overwrite kerja yang lain. Tidak ada DB transaction, tidak ada compare-and-set, tidak ada mutex.
- **Root Cause:** Tidak ada concurrency control sekitar update `dynamic_memory`; ketiga LLM-backed updater baca snapshot stale, komputasi independen, overwrite buta.
- **Dampak ke User:** Fakta dari satu turn di-overwrite dan hilang oleh turn/auditor/summarizer konkuren; tagged state bisa regress ke value lama. Manifest sebagai BUG-04 (state inkonsisten/duplikat) + memory unreliability umum.
- **Solusi yang Diperlukan:** Serialisasi update `dynamic_memory` per story (in-process mutex/queue keyed by story id, atau single writer task), ATAU compare-and-set UPDATE dengan kolom versi sehingga write dari snapshot stale direject + retry. Minimal: lakukan read-merge-write dalam **satu** better-sqlite3 transaction dan re-read fresh tepat sebelum write. Auditor dan summarizer harus di-serialize (await auditor → lalu summarizer), bukan paralel.
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-007] Blok current-state di-omit sepenuhnya saat tak ada tagged state; flat list tak ada penekanan
- **Severity:** HIGH
- **File:** backend/src/services/promptBuilder.service.js
- **Baris:** 110-112 (gate), 158-178 (renderDynamicFacts), 136 (direktif)
- **Kategori:** LOGIC_ERROR / CORRECTNESS
- **Deskripsi:** `buildCurrentContextBlock` return `''` kecuali minimal satu dari STATUS/AI_PANGGILAN/KONTEKS_PERILAKU/USER_PANGGILAN ada. Jika extractor belum pernah populate ini (mis. ekstraksi fail silent return null di memoryExtractor:326, atau LLM judge "no change"), blok `## KONTEKS SAAT INI [BACA INI SEBELUM MEMBALAS]` absen. AI hanya lihat info relationship sebagai baris biasa di flat `DYNAMIC FACTS` tanpa instruksi bahwa ini represent state current yang harus dipatuhi. Direktif kuat `Perilakumu HARUS mencerminkan konteks ini setiap saat` hanya hidup di dalam blok yang ter-gate; flat list tak ada padanan penekanan.
- **Root Cause:** Direktif strong hanya ada di `buildCurrentContextBlock`, di-gate pada keberadaan tagged state. Flat facts list tak ada penekanan ekuivalen dan tak ada instruksi treat `[STATUS]`/`[KONTEKS_PERILAKU]` sebagai binding current state.
- **Dampak ke User:** AI ignore konteks hubungan saat tagged state missing/belum diekstrak → BUG-05 ("udah berani manggil sayang ya?" saat sudah pacaran). AI tak punya enforced notion of current relationship state.
- **Solusi yang Diperlukan:** Selalu emit current-state section (meski sebagian kosong) yang eksplisit menginstruksikan AI: (1) treat baris `[STATUS]`/`[AI_PANGGILAN]`/`[USER_PANGGILAN]`/`[KONTEKS_PERILAKU]` di memory sebagai binding current state, (2) panggil user pakai AI_PANGGILAN konsisten, (3) treat status hubungan sebagai in-effect. Dekouple direktif dari keberadaan satu tagged field. (Kombinasi dengan fix TEMUAN-002: setelah normalisasi, tagged state hampir selalu ada; tetap backup directive untuk kasus extraction fail.)
- **Terkait dengan Bug User:** BUG-05
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-008] AbortError user di-re-wrap jadi 'Provider error' generik → fallback chain retry saat user cancel
- **Severity:** HIGH
- **File:** backend/src/services/modelProvider.service.js
- **Baris:** 218-226 (catch re-wrap), 79-86 (shouldTryNextModel), 144-149 (internal abort ctl)
- **Kategori:** RACE_CONDITION / LOGIC_ERROR
- **Deskripsi:** Di `streamSingleModel`, fetch di-wrap `_fetchWithFirstByteTimeout` yang abort via AbortController internal yang di-wire ke caller signal (baris 144-149). Saat user klik Stop, `callerSignal.abort` fire `ctl.abort`, fetch throw AbortError. Error ditangkap baris 218 dan di-re-throw sebagai `new Error(\`Provider error (${body.model}): hang/timeout > ...ms\`)` (baris 220-222) — name jadi `Error`, bukan `AbortError`. `shouldTryNextModel` (baris 81) cek `err.name === 'AbortError'` return false untuk stop chain; tapi error re-wrap punya name `Error` + message mengandung 'timeout' → `shouldTryNextModel` return true. Chain lalu coba slot model BERIKUTNYA, bukan bail out. Identitas AbortError hancur di boundary per-model.
- **Root Cause:** Catch di baris 218 tak preserve AbortError identity. Blanket-convert setiap fetch failure (timeout, abort, network) jadi Provider error generik. Tidak ada `if (callerSignal.aborted) throw err` short-circuit sebelum re-wrap.
- **Dampak ke User:** Setelah klik Stop, backend silently retry model berikut di chain (jika dikonfigurasi) bukan cancel langsung. User lihat cancellation delayed, wasted provider call, mungkin partial/duplicate token. Multi-slot chain → cancel bisa ambil 25s+ per slot tersisa.
- **Solusi yang Diperlukan:** Sebelum re-wrap, cek apakah caller signal aborted; jika ya, re-throw AbortError original (atau construct `new Error` dengan `name='AbortError'`) supaya `shouldTryNextModel` lihat AbortError dan stop chain. Bedakan caller-abort dari internal-timeout abort: hanya internal timeout yang retryable.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-009] Tidak ada in-flight dedup: request konkuren untuk text/voice sama di-synthesize dua kali (race + BUG-03 latency)
- **Severity:** HIGH
- **File:** backend/src/routes/tts.routes.js, backend/src/services/edgeTts.service.js
- **Baris:** tts.routes 47-79, edgeTts 322-352 (synthesizeText), 385-390 (warmupText), 413-415 (warmupVoice)
- **Kategori:** RACE_CONDITION
- **Deskripsi:** POST `/api/tts` panggil `synthesizeText` yang cek cache lalu `runWithRetry`. Jika cache cold dan dua request datang untuk (text, voice) yang sama sebelum salah satu selesai (mis. pre-synth background loop dari messages.controller racing frontend play fetch), **dua-duanya miss cache, dua-duanya acquire semaphore, dua-duanya buka WebSocket** ke Microsoft Edge TTS untuk kerja identik. Hanya `cachePut` terakhir yang populate; result pertama dibuang. `warmupVoice` punya issue sama (tak ada single-flight guard, beda `warmup()` yang guard via `warmupPromise`).
- **Root Cause:** `synthesizeText` tak punya in-flight promise map. `cacheGet` return null untuk key yang sedang di-synthesize, jadi caller konkuren masing-masing start synthesis sendiri. Semaphore limit total concurrency 3 tapi tidak coalesce identical work.
- **Dampak ke User:** Duplikat Edge TTS request untuk segmen sama (wasted quota, extra latency untuk caller kedua yang bisa await yang pertama). Untuk BUG-03 ini langsung tambah latency: frontend fetch dan backend pre-synth fetch untuk segmen sama berdua hit cold cache dan race; yang frontend await bisa jadi yang lebih lambat.
- **Solusi yang Diperlukan:** Tambah Map of in-flight cache keys → `Promise<Buffer>` di `edgeTts.service`. Saat cache miss, simpan running promise; caller konkuren await promise yang sama. Hapus entry saat settle. Single-flight ini coalesce duplikat synthesis.
- **Terkait dengan Bug User:** BUG-03
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-010] Service worker cache SEMUA GET same-origin termasuk /api/* → pesan stale saat refresh (akar BUG-02)
- **Severity:** HIGH
- **File:** frontend/public/sw.js
- **Baris:** 98 (skip non-GET only), 119-139 (catch-all SWR)
- **Kategori:** CORRECTNESS / DATA_FRESHNESS
- **Deskripsi:** Fetch handler SW hanya skip non-GET (baris 98 `if (req.method !== 'GET') return;`). Setiap GET same-origin — termasuk `/api/stories`, `/api/stories/:id`, `/api/stories/:id/messages` — fall through ke blok stale-while-revalidate (baris 119-139) yang return `cached || networkFetch`. Saat refresh, jika cached Response `/api/stories/:id/messages` ada dari kunjungan sebelumnya, **disajikan langsung dan fresh network fetch dibuang** (cache di-update background only). User lihat list pesan LAMA; pesan user+AI terbaru absen. Refresh kedua pick up cache yang baru ter-update. Comment header file sendiri (baris 8) bilang "Other API calls: network-only (data fresh, SSE stream must not cache)" tapi kode tak pernah implement exclusion itu.
- **Root Cause:** Missing `/api/*` (atau minimal `/api/stories/*`) exclusion sebelum catch-all SWR branch. Intent comment tak pernah di-code.
- **Dampak ke User:** Setelah refresh, pesan terbaru tidak muncul, muncul lambat, atau hilang sampai refresh lagi — persis BUG-02. Juga serve story metadata stale (avatar, voice, dynamic_memory count).
- **Solusi yang Diperlukan:** Tambah early `if (url.pathname.startsWith('/api/')) return;` (network-only, no caching, no SWR) sebelum static-asset dan app-shell branch, sehingga semua API read selalu hit network. Pertahankan hanya TTS-POST cache handler eksplisit untuk `/api/tts`.
- **Terkait dengan Bug User:** BUG-02
- **Verifikasi:** [V: CONFIRMED] — control flow diverifikasi baris 86/92-95/98/100-102/104-116/119-139; tidak ada kode mengecualikan `/api/*` GET.

### [TEMUAN-011] probeServiceWorker version comparison selalu false → toast 'Cache audio tidak aktif' setiap refresh (akar BUG-01)
- **Severity:** HIGH
- **File:** frontend/public/js/pages/story.page.js, frontend/public/story.html
- **Baris:** story.page 138-161 (probeServiceWorker), 1258-1261 (catch toast), 146-147 (hasV); story.html 296 (register `/sw.js` polos)
- **Kategori:** LOGIC_ERROR
- **Deskripsi:** `probeServiceWorker` baca `?v=N` dari script tag `story.page.js` dan cek apakah `scriptURL` SW aktif mengandung `?v=N` (baris 146-147 `hasV = (u) => u.includes(\`?v=${currentV}\`)`). Tapi SW terdaftar sebagai `/sw.js` polos (story.html baris 296, index.html — tanpa query string), jadi `scriptURL` = `https://host/sw.js` yang **tidak pernah** mengandung `?v=38`. `hasV` selalu false untuk `reg.active.scriptURL` dan `controller.scriptURL`. Fungsi lalu post `SKIP_WAITING` dan wait 1000ms untuk `controllerchange`. Pada refresh biasa tidak ada SW baru install, jadi `controllerchange` tak pernah fire → timeout → `reject(Error('timeout'))` → `.catch` baris 1259-1261 fire `showTransientError('Cache audio tidak aktif — pemutaran pertama mungkin lebih lambat.')`. Toast dipicu oleh probe yang rusak, BUKAN oleh state cache aktual.
- **Root Cause:** Version dibandingkan terhadap substring `?v=` yang absen dari SW scriptURL (registrasi pakai `/sw.js` tanpa version query). Probe tak bisa pernah return 'current', jadi selalu timeout.
- **Dampak ke User:** Setiap refresh story-page notifikasi 'Cache audio tidak aktif' muncul meski SW cache berfungsi. BUG-01.
- **Solusi yang Diperlukan:** Bandingkan terhadap build fingerprint nyata yang embedded di SW sendiri (mis. konstanta `self.SW_VERSION` yang SW broadcast via `message` event, atau registrasi SW berversi `/sw.js?v=38`). Hanya show toast saat SW genuinely missing/unsupported atau SW baru genuinely gagal claim — bukan pada refresh normal di mana controller sudah aktif. Alternatif sederhana: hanya show toast saat `probeServiceWorker` resolve `'missing'`/`'unsupported'`, dan swallow `'timeout'` (atau hilangkan probe sepenuhnya jika SW self-update via CACHE_VERSION sudah cukup).
- **Terkait dengan Bug User:** BUG-01
- **Verifikasi:** [V: CONFIRMED] — semua klaim load-bearing diverifikasi; register `/sw.js` polos dikonfirmasi di story.html:296.

### [TEMUAN-012] Tidak ada TTS prewarm untuk AI message baru yang di-stream → play click pertama cold fetch >2s (akar BUG-03)
- **Severity:** HIGH
- **File:** frontend/public/js/pages/story.page.js
- **Baris:** 1756-1769 (SSE done handler, no prewarm), 1407-1409 (prewarm only at initial render), 190-204 (prewarmLatestAssistantTts), 514 (play click cold fetch)
- **Kategori:** PERFORMANCE / FEATURE_GAP
- **Deskripsi:** `prewarmLatestAssistantTts` (baris 190-204) hanya dipanggil saat render awal (baris 1407-1409, dalam `requestAnimationFrame` setelah window pertama paint). Ia synthesize 3 assistant message terbaru fire-and-forget untuk warm backend Edge TTS cache. Tapi SSE `done` handler (baris 1756-1769) — yang fire saat AI message BARU selesai render selama sesi — **tidak trigger prewarm apapun**. Saat user klik play bubble baru, `_onTtsPlayOrToggleClick` (baris 514) laku `await apiClient.synthesizeTts({text, voice})` tanpa prefetch, tanpa signal, tanpa timeout: full network roundtrip + Edge TTS synthesis, rutin melebihi target 2s. Dead `ttsQueueManager._prefetchNext` (yang akan prefetch segmen N+1) tidak dipakai live pipeline.
- **Root Cause:** Prewarm terikat initial-load only; path streaming tak pernah di-wire ke prewarm on `done`. Live pipeline tak punya prefetch sama sekali.
- **Dampak ke User:** Audio mulai >2s setelah klik play pada AI message yang di-generate selama sesi. BUG-03.
- **Solusi yang Diperlukan:** Pada SSE `done` event (setelah final content di-sanitize), fire-and-forget `synthesizeTts` untuk text+voice message itu sehingga backend cache warm sebelum user klik play. Opsional: dukung mode opt-in auto-play-after-render. Pastikan voice yang di-prewarm = voice yang akan di-request saat play (`story.tts_voice`).
- **Terkait dengan Bug User:** BUG-03
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-013] Blocking warmupTts({wait:true}) delay render pesan awal sampai 25s
- **Severity:** HIGH
- **File:** frontend/public/js/pages/story.page.js
- **Baris:** 1368-1378 (await warmup wait=true), 1390-1394 (messages fetch setelahnya), apiClient 298-300 (25s ceiling)
- **Kategori:** PERFORMANCE
- **Deskripsi:** `loadStoryAndMessages` await `apiClient.warmupTts({ voice: settledVoice, wait: true })` (baris 1370) **SEBELUM** fetch dan render pesan. Backend warmup-with-wait punya ceiling 25s (apiClient baris 298-300). Sampai resolve (atau timeout), loading spinner stay dan tidak ada pesan render. Bahkan happy path ini nambah latency warmup Edge TTS ke first paint; pada endpoint Edge TTS lambat/unreachable blok UI sampai 25s. Ini fire-and-forget menurut design intent comment sendiri (baris 297-300 bilang default harus non-blocking) tapi story page override jadi blocking. Tambahan: warmup hanya synthesize string dummy (`'Halo, saya siap membantu Anda.'`) yang cache-key-nya tak pernah match pesan asli — jadi blok 25s ini **membeli apa-apa** untuk playback nyata (lihat TEMUAN-012, TTS-001 trace).
- **Root Cause:** `warmupTts` di-await dengan `wait=true` pada critical render path, bukan di-race paralel dengan message load. Plus warmup warm dummy string yang tak pernah hit.
- **Dampak ke User:** Story page terasa frozen saat load (spinner only) selama detik-sampai-25s; secara tak langsung memperburuk persepsi BUG-02/03 (pesan 'muncul lambat').
- **Solusi yang Diperlukan:** Jangan blok render pesan pada warmup. Kick off `warmupTts` paralel dengan messages GET (atau fire-and-forget `wait=false`) dan render pesan saat GET resolve. Hanya TTS play action yang boleh wait warmup, dan itu pun bisa race warmup vs direct synthesize. Jika blocking tetap diinginkan, cap ~1-2s dan warm text pesan terbaru nyata, bukan dummy.
- **Terkait dengan Bug User:** BUG-03 (dan berkontribusi persepsi BUG-02)
- **Verifikasi:** [V: CONFIRMED] — baris 1370 blocking await, iterator messages hanya dibuat di 1390 dan di-await 1394, strictly setelah warmup.

---

## DAFTAR TEMUAN — MEDIUM SEVERITY

### [TEMUAN-014] schema.sql omit kolom avatar/font/roleplay_mode yang migrate.js tambahkan
- **Severity:** MEDIUM
- **File:** backend/src/db/schema.sql, backend/src/db/migrate.js
- **Baris:** schema 9-44; migrate v4 (48-64), v5 (66-82), v6 (84-95)
- **Kategori:** MAINTAINABILITY / CORRECTNESS
- **Deskripsi:** `schema.sql` (yang di-`db.exec` di database.js:18-19) definisikan tabel stories **tanpa** `avatar_url`/`avatar_enabled`/`font_family`/`font_size`/`roleplay_mode`. migrate.js tambah via ALTER TABLE. Pada DB fresh: schema.sql jalan dulu bikin tabel tanpa kolom itu, lalu runMigrations (user_version 0) jalan migration v4/v5/v6 menambahkan — fresh install akhirnya benar via migration. Tapi schema.sql dan migration jadi dua sumber kebenaran divergen. Developer baca schema.sql sendiri lihat definisi tabel tidak lengkap. Jika migration pernah di-skip atau `user_version` manual diset 6 pada DB fresh (mis. backup restore), kolom hilang dan setiap read/write avatar/font di stories.controller throw `SQLITE_ERROR no such column`.
- **Root Cause:** Schema dibangun inkremental via migration tanpa back-port bentuk final ke schema.sql. schema.sql diperlakukan sebagai baseline v1 saja.
- **Dampak ke User:** Tidak ada pada boot path normal hari ini. Latent: schema.sql misleading sebagai dokumentasi, dan migration history skip/corrupt → tabel stories rusak yang 500 pada setiap operasi avatar/font.
- **Solusi yang Diperlukan:** Sync schema.sql ke union kolom lengkap semua migration sampai v6, sehingga `CREATE TABLE IF NOT EXISTS` produksi tabel lengkap pada fresh install dan migration jadi no-op. Pertahankan migration untuk DB existing.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-015] Filter uncaughtException/unhandledRejection menelan error via substring match rapuh
- **Severity:** MEDIUM
- **File:** backend/src/server.js
- **Baris:** 23-45
- **Kategori:** SECURITY / RELIABILITY
- **Deskripsi:** Handler `uncaughtException` dan `unhandledRejection` keep process hidup saat pesan error mengandung substring `'EdgeTTS'` atau `'Unexpected server response'`. Ini substring match pada `err.message`. Jika komponen tak terkait throw error yang pesannya kebetulan mengandung salah satu substring (mis. log string `'Unexpected server response from EdgeTTS wrapper'`, atau string user-supplied yang ter-propagate ke error message), handler menelan dan proses lanjut di state potentially corrupt. Comment membenarkan ini untuk paket library synchronous WebSocket error, tapi filter terlalu luas: tidak cek origin, stack, atau typed property. Untuk non-TTS uncaught exception, kontrak dokumentasi Node adalah proses dalam state undefined dan harus exit; lanjut risiko silent data corruption.
- **Root Cause:** String-based error classification, bukan typed discriminator (error code, class, flag).
- **Dampak ke User:** Low probability high severity: fatal error yang salah diklasifikasi sebagai TTS transport error tinggalkan server running dengan state corrupt, potentially tulis data buruk ke SQLite.
- **Solusi yang Diperlukan:** Tag error asal-TTS dengan properti pembeda (mis. `err.isTtsTransport = true` atau unique error code) di throw site, dan handler cek properti itu bukan substring. Alternatif: catch paket WebSocket error di source-nya di `edgeTts.service` sehingga tak pernah reach process-level handler.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-016] NODE_ENV dan MODEL_FIRST_BYTE_TIMEOUT_MS dibaca process.env langsung, bypass config/env.js
- **Severity:** MEDIUM
- **File:** backend/src/routes/tts.routes.js, backend/src/services/modelProvider.service.js
- **Baris:** tts.routes 70 & 98; modelProvider 136-139
- **Kategori:** CONFIG / MAINTAINABILITY
- **Deskripsi:** `config/env.js` adalah sumber tunggal env (fail-fast validate saat boot). Tapi `tts.routes.js` baca `process.env.NODE_ENV` langsung (baris 70, 98) untuk logging gate, dan `modelProvider.service.js:137` baca `process.env.MODEL_FIRST_BYTE_TIMEOUT_MS`. Ini bypass config module: `MODEL_FIRST_BYTE_TIMEOUT_MS` tak pernah divalidasi/didokumentasi di env.js, `NODE_ENV` sudah diekspos sebagai `env.NODE_ENV` tapi tak reused. Split env handling antar file; typo nama env var fail silent (timeout silently fallback 25s, log gate silent).
- **Root Cause:** Tidak ada enforced convention bahwa semua `process.env` access lewat config/env.js.
- **Dampak ke User:** Tidak ada functional hari ini. Maintainability/config-traceability: operator tak bisa temukan semua env knob dari satu file, silent fallback sembunyikan misconfig.
- **Solusi yang Diperlukan:** Pindah parsing `MODEL_FIRST_BYTE_TIMEOUT_MS` ke env.js (clamp/fallback pattern sama), export; ganti dua `process.env.NODE_ENV` dengan `env.NODE_ENV`.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-017] Short-term window query tak ada id tiebreaker → urutan pesan nondeterministic
- **Severity:** MEDIUM
- **File:** backend/src/services/memoryManager.service.js
- **Baris:** 4-10 (getRecentStmt)
- **Kategori:** LOGIC_ERROR / CORRECTNESS
- **Deskripsi:** `getRecentStmt` pakai `ORDER BY created_at DESC LIMIT ?` tanpa id tiebreaker. SQLite `CURRENT_TIMESTAMP` punya resolusi 1-detik, jadi pesan di-insert dalam detik yang sama (user+assistant pada exchange cepat) share `created_at` dan return urutan arbitrary. List endpoint (messages.routes.js:16) benar pakai `created_at DESC, id DESC`. Setelah `.reverse()`, context window AI bisa present turn di luar urutan kronologis.
- **Root Cause:** Missing `id DESC` tiebreaker; inkonsisten dengan list query.
- **Dampak ke User:** AI terima urutan percakapan scramble saat pesan share timestamp → reply tidak koheren. Juga berkontribusi BUG-02 (pesan appear/vanish/reorder saat refresh) karena nondeterminism yang sama affect row mana yang masuk LIMIT window.
- **Solusi yang Diperlukan:** Tambah `id DESC` (atau `id ASC`) sebagai tiebreaker deterministik, match list endpoint ordering.
- **Terkait dengan Bug User:** BUG-02
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-018] chatCompletionOnce (extractor/auditor/summarizer) tanpa timeout atau abort signal
- **Severity:** MEDIUM
- **File:** backend/src/services/modelProvider.service.js
- **Baris:** 286-333 (chatCompletionOnce), 293-302 (fetch tanpa timeout)
- **Kategori:** RELIABILITY
- **Deskripsi:** Non-streaming `chatCompletionOnce` yang dipakai memory extractor, auditor, summarizer call `fetch` tanpa timeout dan tanpa AbortController. Path streaming punya `_fetchWithFirstByteTimeout` (25s) tapi non-streaming tidak. Jika provider hang, promise tak pernah resolve. `extractAndMergeFacts` fire-and-forget (`.catch` di messages.controller:387) jadi hung promise linger tanpa cleanup.
- **Root Cause:** Timeout logic hanya diimplementasi untuk path streaming; path completion non-streaming ditinggalkan tanpa guard ekuivalen.
- **Dampak ke User:** Extractor LLM stuck pegang socket terbuka dan promise unresolved indefinite; repeated occurrences leak resource. Tidak ada user-visible error (non-blocking) tapi memory silently berhenti update.
- **Solusi yang Diperlukan:** Apply first-response timeout (dan/atau caller-supplied AbortSignal dengan deadline default) ke `chatCompletionOnce` ekuivalen streaming first-byte timeout, abort fetch saat exceeded.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-019] Extractor tak simpan snapshot pre-update; rollback bergantung frontend
- **Severity:** MEDIUM
- **File:** backend/src/services/memoryExtractor.service.js, backend/src/routes/messages.routes.js
- **Baris:** extractor 339-343 (write langsung); routes 154-197 (rollback restore dari memory_snapshot body)
- **Kategori:** DATA_INTEGRITY
- **Deskripsi:** `extractAndMergeFacts` tulis `dynamic_memory` baru langsung (baris 340) tanpa persist snapshot pre-update. Rollback route (messages.routes:154-197) restore memory hanya jika frontend kirim `memory_snapshot` di request body. Jika frontend omit, rollback hapus pesan tapi tak bisa restore prior memory state.
- **Root Cause:** Tanggung jawab snapshot di-push ke frontend, bukan direcord server-side saat write.
- **Dampak ke User:** Setelah Stop/rollback tanpa frontend snapshot, `dynamic_memory` retain fakta dari exchange yang sudah dihapus → memory diverge dari conversation history aktual.
- **Solusi yang Diperlukan:** Simpan pre-update `dynamic_memory` di side table/kolom (mis. `memory_prev`) saat write, atau rollback endpoint baca prior value dari append-only audit log. Jangan rely client supply snapshot.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-020] Summarizer replace narrative relationship fact dan bisa duplicate drifted tagged fact
- **Severity:** MEDIUM
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 493-504 (summarizeFacts merge)
- **Kategori:** DATA_LOSS / LOGIC_ERROR
- **Deskripsi:** `summarizeFacts` bangun `next` via `{...memory, ...parsed}` yang bikin `parsed.relationship` **REPLACE** `memory.relationship` sepenuhnya. Lalu re-prepend `existingTagged` dan dedup tagged by key, tapi narrative relationship fact dari memory yang summarizer LLM omit **permanently hilang**. Tambahan, jika LLM return tagged fact dengan formatting drift (tidak match regex), di-treat sebagai narrative dan `existingTagged` yang di-prepend tidak dedup terhadapnya → duplicate tagged-looking fact muncul.
- **Root Cause:** Spread override buang narrative relationship fact pre-existing; dedup filter hanya handle bracket-matching tagged fact, jadi drifted-format tagged fact survive alongside canonical.
- **Dampak ke User:** Loss narrative relationship history saat summarization; potential duplicate tagged entry (BUG-04) saat summarizer LLM emit formatting imperfect.
- **Solusi yang Diperlukan:** Merge (bukan replace) `parsed.relationship` dengan `memory.relationship` pakai routine narrative-dedup + tolerant-tagged-dedup yang sama dengan `mergeRelationshipFacts`, sehingga tak ada yang di-drop silent dan drifted tag di-normalisasi.
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-021] Legacy migration emit bracket-less `KEY: value` yang tak pernah match tagged pattern
- **Severity:** MEDIUM
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 56-58 (legacy branch emit)
- **Kategori:** CORRECTNESS / LOGIC_ERROR
- **Deskripsi:** `normalizeDynamicMemory` legacy branch (array `{category,key,value}`) produksi `${k}: ${v}` = `USER_PANGGILAN: kaishi` **tanpa bracket**. Ini tak pernah match `TAGGED_KEY_PATTERN /^\[[A-Z_]+\]:/`, jadi migrated tagged-style fact diklasifikasi narrative. Saat extractor baru nanti tambah canonical `[USER_PANGGILAN]: kaishi`, **keduanya coexist** sebagai string distinct → duplicate.
- **Root Cause:** Migration format omit bracket yang tagged-dedup regex syaratkan; legacy fact dan new fact untuk key sama di-treat sebagai unrelated narrative.
- **Dampak ke User:** Migrated story show doubled relationship state entry (BUG-04) sampai manual clean.
- **Solusi yang Diperlukan:** Saat legacy migration, jika key (uppercased) ada di known TAGGED_KEYS set, emit bentuk canonical bracketed `[KEY]: value` bukan `KEY: value`, supaya migrated fact dedup dengan yang baru. (Bagian dari fix terpusat TEMUAN-001.)
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-022] SSE `[DONE]` marker return tanpa yield chunk 'done' — dead-code path
- **Severity:** MEDIUM
- **File:** backend/src/services/modelProvider.service.js
- **Baris:** 255 (return pada [DONE]), 245+272 (yield done hanya pada reader-done)
- **Kategori:** LOGIC_ERROR
- **Deskripsi:** Di `streamSingleModel`, saat stream provider kirim `data: [DONE]` (baris 255), generator `return;` exit langsung. `yield { type: 'done' }` di baris 272 hanya reach saat reader hit `done` (baris 245 break) tanpa marker [DONE]. Controller loop (messages.controller 268-270) break pada `chunk.type === 'done'`; jika tidak ada done chunk yielded (path [DONE]), for-await complete natural dan eksekusi fall through ke parsing. Fungsional controller tetap kirim SSE done sendiri (baris 351), jadi bukan breakage live — tapi `{type:'done'}` yield dead code untuk completion path paling umum, dan logic controller masa depan yang gate pada `chunk.type==='done'` akan silently misbehave.
- **Root Cause:** Dua completion signal (SSE [DONE] vs reader-done) di-handle inkonsisten: satu return, satu yield done. Kontrak 'always yield done chunk' tak dipegang.
- **Dampak ke User:** Tidak ada hari ini, tapi fragile: consumer yang gate pada `chunk.type==='done'` (mis. retry/rollback decision masa depan) tak fire pada path [DONE].
- **Solusi yang Diperlukan:** Unify completion: pada [DONE] ATAU reader-done, set flag dan break inner loop, lalu `yield {type:'done'}` sekali setelah loop di semua kasus.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-023] hardTimeout setTimeout tak pernah di-clear saat streamPromise menang race — leaked timer per synthesis
- **Severity:** MEDIUM
- **File:** backend/src/services/edgeTts.service.js
- **Baris:** 275-279 (hardTimeout Promise.race, tanpa clearTimeout)
- **Kategori:** RESOURCE_LEAK
- **Deskripsi:** Di `_doSynthesize`, `Promise.race([streamPromise, ttsError, hardTimeout])` (baris 279). `hardTimeout` adalah Promise yang reject setelah 8s via `setTimeout` (baris 275-277). Saat `streamPromise` resolve duluan (kasus normal), `setTimeout` di balik hardTimeout masih armed — tidak ada `clearTimeout` untuk itu. Timer fire ~8s kemudian, callback reject jalan pada race promise yang sudah settled (no-op), dan timer GC hanya setelah fire. Setiap synthesis sukses leak satu 8s timer. Comment 8s bilang fail-fast tapi timer outlive success.
- **Root Cause:** Timeout diimplementasi sebagai self-contained rejecting Promise tanpa handle retained untuk clearing. Beda `_fetchWithFirstByteTimeout` (yang `clearTimeout` di finally), `_doSynthesize` tak punya cleanup untuk hardTimeout timer.
- **Dampak ke User:** Under sustained synthesis (pre-synth loop, warmup 4 voice, banyak segmen), lusinan 8s timer armed dan fire pointless. Minor CPU/timer-slot waste; bukan memory growth leak (timer short-lived), tapi pada busy single-user loop nambah jitter.
- **Solusi yang Diperlukan:** Retain timer id dari `setTimeout` dan clear di `finally` block saat `streamPromise` settle (atau restructure pakai AbortController + clearTimeout seperti `_fetchWithFirstByteTimeout`).
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-024] Rollback tulis memory_snapshot verbatim tanpa validasi JSON — bisa corrupt dynamic_memory
- **Severity:** MEDIUM
- **File:** backend/src/routes/messages.routes.js
- **Baris:** 166, 185-199 (transaction tulis memorySnapshot verbatim)
- **Kategori:** DATA_INTEGRITY
- **Deskripsi:** Transaction rollback (baris 185-199) restore memory via `updateStoryMemoryStmt.run(memorySnapshot, storyId)` (baris 196) kapanpun `typeof memorySnapshot === 'string' && memorySnapshot.length > 0`. Tidak ada cek bahwa `memorySnapshot` valid JSON, apalagi shape `{user,ai,world,relationship}`. Frontend buggy yang kirim snapshot truncated/stale/garbage (mis. string `'undefined'` atau partial JSON) akan overwrite `dynamic_memory` story dengan garbage. `normalizeDynamicMemory` berikutnya return empty (JSON.parse throw → empty), **silently wipe semua long-term memory**.
- **Root Cause:** Rollback endpoint trust client-supplied snapshot string dan persist tanpa parse/validate terhadap memory schema. Endpoint atomic di level SQLite (single transaction) tapi tidak correct di level data.
- **Dampak ke User:** Malformed rollback payload silently destroy accumulated long-term memory. Karena rollback dipicu Stop, frontend bug saat abort bisa wipe memory tanpa error surfaced.
- **Solusi yang Diperlukan:** Sebelum write, `JSON.parse` memorySnapshot dan jalankan `normalizeDynamicMemory`; reject (400) jika bukan valid JSON atau tidak normalize ke shape 4-category. Hanya persist bentuk normalized.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-025] Pagination list pesan pakai created_at second-granularity + id tiebreak — boundary race drop/duplicate pesan terbaru saat refresh (kontributor BUG-02)
- **Severity:** MEDIUM
- **File:** backend/src/routes/messages.routes.js
- **Baris:** 13-18 (listMessagesStmt ORDER BY), 94 (reverse)
- **Kategori:** LOGIC_ERROR / CORRECTNESS
- **Deskripsi:** `listMessagesStmt` order `created_at DESC, id DESC` dengan LIMIT/OFFSET. `created_at` = SQLite CURRENT_TIMESTAMP (granularitas detik, tanpa sub-detik). Dua pesan di-insert dalam detik yang sama (user+assistant satu turn, atau turn cepat) share `created_at`; `id DESC` tiebreaker. Saat refresh, frontend paginate dari offset 0 (newest) mundur. Jika turn baru di-insert antara dua page fetch, boundary offset bisa shift sehingga pesan di boundary **skip** (appear vanished sampai refresh) atau **return dua kali**. Combined dengan frontend incremental-load logic, newest user+AI pair bisa appear late atau vanish sampai refresh lagi.
- **Root Cause:** Pagination by (created_at, id) dengan second-granularity timestamp tidak stable across inserts. Tidak ada monotonic cursor (mis. strictly id-based pagination, atau high-water-mark id) — OFFSET pagination re-read seluruh ordering tiap page dan sensitif terhadap insert antar page.
- **Dampak ke User:** Setelah refresh, pesan user+AI terbaru kadang tidak muncul, muncul lambat, atau hilang sampai refresh lagi. Ini BUG-02 (kontributor, bersama TEMUAN-010 SW cache yang lebih dominan).
- **Solusi yang Diperlukan:** Switch ke keyset/cursor pagination pada kolom id saja (`id DESC, WHERE id < cursor`) untuk history page, karena id monotonic dan insertion-ordered. Untuk 'newest page' saat refresh, fetch by `id > last-seen-id` bukan offset 0. Ini bikin pagination stable under concurrent inserts.
- **Terkait dengan Bug User:** BUG-02
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-026] chatCompletionOnce ignore max_tokens — auditor/summarizer call bisa return response oversize
- **Severity:** MEDIUM
- **File:** backend/src/services/memoryExtractor.service.js, backend/src/services/modelProvider.service.js
- **Baris:** extractor 401 (auditor max_tokens 600), 479 (summarizer max_tokens 1200); modelProvider 286-333 (hanya baca temperature)
- **Kategori:** LOGIC_ERROR
- **Deskripsi:** `callMemoryAuditor` (baris 401) dan `summarizeFacts` (baris 479) call `chatCompletionOnce` dengan `max_tokens: 600` dan `max_tokens: 1200`. Tapi `chatCompletionOnce` (modelProvider 286-333) hanya baca `temperature` dari opts (baris 290); tak pernah baca/forward `max_tokens` ke provider body. Body = `{model, messages, stream:false}` + optional temperature. Jadi `max_tokens` silently dropped dan provider return default length. Generator route juga pass hanya temperature (benar).
- **Root Cause:** Extractor pass option yang provider helper tidak accept. Tidak ada signature contract atau validation yang flag unknown option.
- **Dampak ke User:** Auditor/summarizer LLM call bisa produksi output jauh lebih panjang dari intended, nambah latency dan token cost background memory maintenance loop. Tidak ada correctness breakage, tapi cost-control intent unmet.
- **Solusi yang Diperlukan:** Forward `max_tokens` (dan param supported lain) di body construction `chatCompletionOnce`, atau hapus field `max_tokens` dari caller untuk avoid implying limit yang tak dienforce. Prefer forwarding supaya cost cap apply.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-027] renderMessages dan appendOlderMessages — ⚠️ DIRETUTE: bukan defect
- **Severity:** MEDIUM → **REFUTED (dihapus dari actionable)**
- **File:** frontend/public/js/pages/story.page.js
- **Baris:** 1280 (renderMessages), 1284-1289 (appendOlderMessages)
- **Kategori:** —
- **Deskripsi:** Temuan awal D-003 klaim kedua renderer treat batch shape identik secara opposit (satu reverse, satu tidak) → newest tidak di bottom setelah refresh. **Verifier adversarial REFUTE**: premise false. Server (messages.routes.js:16 `ORDER BY created_at DESC, id DESC`) return newest-first rows, lalu baris 94 `desc.slice().reverse()` → setiap page yang API return adalah **oldest-first within page**. Docstring apiClient "yields batches newest-first" mengacu urutan BATCHES (window batch newest dulu, lalu batch history progresif lebih lama), BUKAN within-batch order. Dengan oldest-first-per-page array, kedua renderer benar dan konsisten: `renderMessages` forward-append oldest-first (oldest-of-window di DOM top, newest-of-window di bottom, `scrollToBottom(true)` land di newest); `appendOlderMessages` reverse-iterate + `insertBefore(firstChild)` pada page lebih lama juga oldest-first → [oldest-of-page...newest-of-page] lalu [oldest-of-window...] di atasnya. Final DOM konsisten oldest-top→newest-bottom.
- **Solusi yang Diperlukan:** Tidak ada. Catatan: docstring apiClient `loadAllMessages` (baris 128) menyesatkan ("newest-first") — perbaiki wording jadi "oldest-first within each page, newest page first" untuk hindari miskonsepsi future. Non-actionable bug.
- **Terkait dengan Bug User:** (tidak berkontribusi BUG-02)
- **Verifikasi:** [V: REFUTED]

### [TEMUAN-028] synthesizeTts call saat play click tanpa AbortSignal/timeout — loading spinner bisa spin forever
- **Severity:** MEDIUM
- **File:** frontend/public/js/pages/story.page.js, frontend/public/js/api/apiClient.js
- **Baris:** story.page 513-519; apiClient 276-294
- **Kategori:** PERFORMANCE / ROBUSTNESS
- **Deskripsi:** Pada cache miss, `_onTtsPlayOrToggleClick` set button 'loading' lalu `await apiClient.synthesizeTts({ text, voice })` (baris 514). Tidak ada AbortSignal dan tidak ada timeout. `apiClient.synthesizeTts` (276-294) juga tak punya internal timeout. Jika endpoint Edge TTS hang atau connection stall, fetch tak pernah resolve dan bubble stay di state 'loading' (hourglass) indefinite tanpa cara user cancel kecuali klik stop (yang hanya reset button — tidak abort in-flight fetch, karena tidak ada controller tracked untuk call ini).
- **Root Cause:** Tidak ada AbortController wired ke play-click fetch; dead `ttsQueueManager` pipeline punya 10s timeout + retry, tapi live pipeline drop keduanya.
- **Dampak ke User:** Hung TTS request tinggalkan bubble stuck 'Memuat audio…' tanpa auto recovery.
- **Solusi yang Diperlukan:** Bikin AbortController per play click, pass signal ke `synthesizeTts`, enforce fetch timeout (mis. 10-15s) yang abort dan show transient error toast, dan stop/cancel action abort in-flight controller.
- **Terkait dengan Bug User:** BUG-03
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-029] factCountBadge show '0 fakta' setelah setiap send saat story pakai shape memory baru
- **Severity:** MEDIUM
- **File:** frontend/public/js/pages/story.page.js
- **Baris:** 1803-1818 (post-send poll), 1338-1343 (initial load benar), 937-1021 (modal benar)
- **Kategori:** CORRECTNESS
- **Deskripsi:** Post-send fact poll (baris 1803-1818) compute count: `let facts = []; if (Array.isArray(parsed)) facts = parsed; else if (parsed && Array.isArray(parsed.facts)) facts = parsed.facts; factCountBadge.textContent = '${facts.length} fakta'`. Ini hanya handle legacy Array shape dan `{facts:[...]}` shape. Shape memory current (`{user,ai,world,relationship}`) yang dipakai `openMemoryModal` (1334-1343) dan initial-load counter (1338-1343) **tidak punya key `facts`** — jadi `facts` stay `[]` dan badge reset ke '0 fakta' tepat setelah setiap send, meski story punya banyak fakta. Initial load dan memory modal count category array benar; hanya post-send poll salah.
- **Root Cause:** Post-send poll pakai shape handler berbeda dan incomplete dari path initial-load dan modal-open.
- **Dampak ke User:** Counter memory fact visibly drop ke 0 setelah kirim pesan, kontradiksi modal. Bingungkan user apakah memory direkam (overlap BUG-04/05 symptom).
- **Solusi yang Diperlukan:** Extract satu shared count function yang handle ketiga shape (Array, `{facts}`, `{user,ai,world,relationship}`) dan pakai di initial-load, post-send poll, modal-open.
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-030] Snapshot rollback dynamic_memory tak pernah di-refresh antar send → Stop rollback restore memory stale
- **Severity:** MEDIUM
- **File:** frontend/public/js/pages/story.page.js
- **Baris:** 1631-1635 (snapshot dari currentStory), 1295 (currentStory assign sekali), 1803-1818 (poll hanya update badge)
- **Kategori:** CORRECTNESS
- **Deskripsi:** Snapshot rollback Stop/cancel diambil dari `currentStory.dynamic_memory` (baris 1631-1635) — yang di-populate sekali di `loadStoryAndMessages` (baris 1295) dan **tidak pernah di-update** setelah itu. Post-send poll (1803-1818) hanya update text `factCountBadge`, BUKAN `currentStory.dynamic_memory`. Jadi saat user kirim pesan kedua lalu klik Stop, rollback DELETE kirim snapshot dari SEBELUM pesan pertama — bukan state tepat sebelum send ini. Backend restore `dynamic_memory` outdated, yang bisa resurrect fakta yang sudah di-dedup/remove di interim atau fail undo fakta yang di-add oleh send in-flight.
- **Root Cause:** `currentStory.dynamic_memory` diperlakukan immutable setelah initial load; tidak ada path yang refresh setelah send sukses atau setelah rollback prior.
- **Dampak ke User:** Stop/cancel produksi memory state salah — fakta yang user expect remove mungkin persist atau duplicate reappear. Compounds BUG-04.
- **Solusi yang Diperlukan:** Setelah setiap send sukses (SSE done) dan setelah setiap rollback complete, re-fetch story (atau minimal `dynamic_memory`) dan update `currentStory.dynamic_memory` supaya snapshot send berikut reflect latest DB state.
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-031] Timestamp kartu dashboard bypass parseTimestamp UTC handling → relative time melesut TZ lokal
- **Severity:** MEDIUM
- **File:** frontend/public/js/pages/dashboard.page.js
- **Baris:** 309 (new Date pre-parse), 137-148 (parseTimestamp UTC rule)
- **Kategori:** CORRECTNESS
- **Deskripsi:** `parseTimestamp` (137-148) sengaja treat TZ-naive SQLite timestamp sebagai UTC dengan suffix 'Z'. Tapi path render story-card (baris 309) laku `const parsedDate = new Date(story.updated_at)` langsung — pass Date object ke `formatRelativeDate`, yang bikin `parseTimestamp` short-circuit di baris 138 (`if (input instanceof Date) return input`). Jadi TZ-naive string di-parse bare `Date` constructor sebagai LOCAL time, bukan UTC, dan logic UTC yang teliti di-bypass. Label relative-time di kartu dashboard bisa melesut offset UTC user (mis. show '7 jam yang lalu' bukan '0 detik yang lalu' untuk story baru di UTC+7).
- **Root Cause:** Pre-parse dengan `new Date(story.updated_at)` sebelum `formatRelativeDate` mengalahkan UTC normalization `parseTimestamp`.
- **Dampak ke User:** Label 'X jam/hari yang lalu' tidak akurat di dashboard session list, terutama user jauh dari UTC.
- **Solusi yang Diperlukan:** Pass raw string `story.updated_at` langsung ke `formatRelativeDate` (hapus pre-parse `new Date(...)` di baris 309) supaya `parseTimestamp` apply UTC rule konsisten.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED] — verifier catat: backend sudah serialize ke UTC (util/time.js), tapi response lama TZ-naive yang masih di-cache browser tetap butuh rule ini; pre-parse memang mengalahkannya.

### [TEMUAN-032] Generic request() dan synthesizeTts tak punya fetch timeout / AbortController — request bisa hang indefinite
- **Severity:** MEDIUM
- **File:** frontend/public/js/api/apiClient.js
- **Baris:** 13-27 (request), 276-294 (synthesizeTts)
- **Kategori:** ROBUSTNESS
- **Deskripsi:** `request()` (13-27) call `fetch` tanpa signal dan tanpa timeout untuk setiap helper GET/POST/PUT/DELETE (listStories, getStory, updateStory, listMessages, loadAllMessages, dll). `warmupTts` rely solely pada ceiling 25s backend. `synthesizeTts` (276-294) hanya timeout saat caller pass signal — dan live caller di story.page.js (514) pass none. Tidak ada per-request deadline di path generic. Stalled backend connection tinggalkan frontend await forever tanpa user feedback (mis. spinner openMemoryModal, skeleton loadStories, settings PUT).
- **Root Cause:** Tidak ada default AbortController + timeout wrapper di `request()`; signal support hanya di-add ad-hoc ke `synthesizeTts` dan `loadAllMessages`.
- **Dampak ke User:** Stalled API call hang related UI affordance tanpa recovery; app appear frozen.
- **Solusi yang Diperlukan:** Tambah default timeout (mis. 15-30s untuk JSON API, lebih pendek untuk warmup) di `request()` via AbortController, dan caller boleh pass external signal yang compose dengan internal. Surface timeout sebagai typed error supaya page bisa show retry toast.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-033] SSE client (postSSE) tak ada auto-reconnect saat disconnect mid-stream
- **Severity:** MEDIUM
- **File:** frontend/public/js/api/apiClient.js
- **Baris:** 37-112 (postSSE), 101-103 (reject non-abort)
- **Kategori:** ROBUSTNESS
- **Deskripsi:** `postSSE` baca streaming body sekali. Jika `reader.read()` reject untuk alasan selain AbortError (network drop, server crash, proxy idle-timeout closing chunked connection), promise reject (101-103) dan story page catch buka AI Provider Error dialog. Tidak ada retry/resume logic: tidak ada Last-Event-ID tracking, tidak ada exponential backoff reconnect, tidak ada partial-token recovery. SSE `error` event (89-96) adalah server-sent logical error, bukan transport drop, dan di-handle dengan resolve (bukan reconnect). Untuk roleplay generation panjang, transient network blip abort whole response.
- **Root Cause:** Pump treat setiap non-abort reader error sebagai terminal; tidak ada reconnection atau resume protocol.
- **Dampak ke User:** Network hiccup mid-generation lose in-progress AI response dan force user re-send atau pakai fallback dialog.
- **Solusi yang Diperlukan:** Pada non-abort transport error, attempt bounded reconnect (dengan backoff) pakai last token offset / message id jika backend support resumption; minimal retry send sekali sebelum surface error dialog.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-034] Hardcoded CDN ESM import (markdown-it) break PWA offline dan couple app ke host pihak ketiga
- **Severity:** MEDIUM
- **File:** frontend/public/js/core/markdownRenderer.js
- **Baris:** 1 (`import MarkdownIt from 'https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/+esm'`)
- **Kategori:** SECURITY / AVAILABILITY
- **Deskripsi:** Baris 1 import runtime ESM dari public CDN. Service worker tidak cache cross-origin request (sw.js:86 `if (url.origin !== self.location.origin) return;`), jadi markdown-it di-fetch live dari jsdelivr pada setiap load story/dashboard. **Offline PWA mode rusak** untuk page yang render markdown (story page). Juga bikin app dependent pada CDN availability dan supply-chain host (CDN compromise/outage break rendering).
- **Root Cause:** markdown-it di-import dari CDN bukan di-vendor atau install sebagai dependency dan bundle.
- **Dampak ke User:** Story page gagal render AI message offline; CDN outage/latency slow atau break message rendering. Supply-chain risk.
- **Solusi yang Diperlukan:** Vendor markdown-it lokal (install sebagai dependency dan bundle, atau download ESM build ke `/js/vendor/`) dan import dari same-origin supaya SW bisa cache sebagai bagian app shell.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-035] story.html disable user zoom (maximum-scale=1.0, user-scalable=no) — WCAG 1.4.4 violation
- **Severity:** MEDIUM
- **File:** frontend/public/story.html
- **Baris:** 5 (viewport meta)
- **Kategori:** ACCESSIBILITY
- **Deskripsi:** Baris 5: `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />`. Pinch-zoom disable di story page. WCAG 1.4.4 (Resize text) dan 1.4.10 require text remain resizable/reflowable sampai 200%; mencegah zoom gagal ini untuk user low-vision di mobile. Dashboard (index.html:5) benar omit restriksi ini.
- **Root Cause:** Legacy viewport meta copied untuk prevent iOS input zoom, tapi juga block accessibility zoom.
- **Dampak ke User:** User low-vision mobile tidak bisa perbesar text story via pinch-zoom (in-app font slider hanya 14-22px).
- **Solusi yang Diperlukan:** Hapus `maximum-scale=1.0, user-scalable=no`; keep `initial-scale=1.0, viewport-fit=cover`. Jika avoid input-zoom tujuannya, set input `font-size >=16px` saja. (Aksesibilitas — jangan di-simplify away.)
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

---

## DAFTAR TEMUAN — LOW SEVERITY

### [TEMUAN-036] Pre-synthesis fire-and-forget IIFE: concurrency per-response, fire-and-forget tak tracked saat shutdown
- **Severity:** LOW (di-downgrade dari MEDIUM — klaim "tidak ada semaphore global" REFUTED)
- **File:** backend/src/controllers/messages.controller.js, backend/src/services/edgeTts.service.js
- **Baris:** controller 367-379; edgeTts 140-161 (semaphore global), 224-233 (runSynthesize acquire)
- **Kategori:** RACE_CONDITION (parsial) / RELIABILITY
- **Deskripsi:** Temuan awal A-006 klaim "per-response concurrency limit dengan tidak ada global semaphore" sehingga 2 chat = 6 WebSocket risiko 403/500. **Verifier REFUTE klaim semaphore**: `edgeTts.service.js:140-161` sudah implement semaphore counting global `MAX_CONCURRENT=3` dengan `semaphoreCount` + `semaphoreWaiters` (process-global, instance tunggal shared). `runSynthesize` (224-233) wrap setiap WebSocket open dengan `await semaphoreAcquire()` / `finally semaphoreRelease()`. Semua entry point synth funnel melaluinya: `synthesizeText`→`runWithRetry`→`runSynthesize`; `synthesizeSegment`→`runSynthesize`. Pre-synth IIFE (controller 367-379) call `synthesizeText(seg.text, ttsVoice)`, jadi gated semaphore global. Dua chat konkuren tidak bisa buka 6 WebSocket — queue di cap global 3. Sisa klaim yang **valid** (LOW): (1) IIFE fire-and-forget, Promise tak di-tracked, jadi saat SIGTERM pre-synth in-flight WebSocket abandoned mid-flight tanpa cleanup; (2) better-sqlite3 WAL checkpoint mungkin ter-interrupt. Bukan bug concurrency.
- **Root Cause:** Fire-and-forget Promise tidak tracked untuk graceful shutdown (sisa klaim valid); concurrency sudah di-handle.
- **Dampak ke User:** Tidak ada pada concurrency (semaphore ada). Saat shutdown abrupt, in-flight Edge TTS WebSocket leak briefly. Minor.
- **Solusi yang Diperlukan:** Track pre-synth Promise supaya shutdown bisa await/abort. Comment di controller 363-365 yang bilang "concurrency limiter max 3 per response" menyesatkan — sebenarnya global via semaphore; perbaiki comment.
- **Terkait dengan Bug User:** BUG-03 (kontributor minor: pre-synth race dengan frontend fetch, lihat TEMUAN-009 in-flight dedup)
- **Verifikasi:** [V: REFUTED sebagian → downgrade LOW]

### [TEMUAN-037] hardDeleteStory hapus messages tapi tak eksplisit hapus message_tts/voice_presets (andalkan cascade)
- **Severity:** LOW
- **File:** backend/src/controllers/stories.controller.js
- **Baris:** 418-437 (hardDeleteStory transaction)
- **Kategori:** CORRECTNESS / MAINTAINABILITY
- **Deskripsi:** `hardDeleteStory` transaction hapus messages lalu story (422-429). Andalkan FK ON DELETE CASCADE untuk messages→stories (benar) tapi eksplisit pre-delete messages dengan `deleteMessagesStmt` sebelum delete story. Tak pernah eksplisit hapus `message_tts` atau `voice_presets`. Schema define ON DELETE CASCADE pada `message_tts.message_id→messages.id`, `message_tts.story_id→stories.id`, `voice_presets.story_id→stories.id`, jadi dengan `foreign_keys=ON` (database.js:16) cascade seharusnya bersih. TAPI: eksplisit `deleteMessagesStmt.delete` jalan dalam transaction yang sama SEBELUM `deleteStoryStmt`, jadi `message_tts` row yang reference messages di-cascade-delete saat messages dihapus, dan `voice_presets` cascade saat story dihapus. Jadi fungsional benar — NAMUN hanya karena `foreign_keys` pragma ON. Pendekatan campuran (manual messages + andalkan cascade untuk rest) fragile dan asimetris.
- **Root Cause:** Strategi deletion inkonsisten: manual delete untuk messages, implicit cascade untuk message_tts dan voice_presets.
- **Dampak ke User:** Tidak ada hari ini dengan foreign_keys=ON. Latent orphan risk jika pragma pernah toggle atau parallel migration jalan.
- **Solusi yang Diperlukan:** Salah satu: andalkan murni cascade (hapus hanya story, biarkan FK cascade handle messages, message_tts, voice_presets) ATAU hapus semua child table eksplisit. Pilih satu dan apply konsisten.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-038] Index idx_messages_story_created tak cover id DESC tiebreaker yang dipakai list query
- **Severity:** LOW
- **File:** backend/src/db/schema.sql
- **Baris:** 57-58 (index)
- **Kategori:** PERFORMANCE
- **Deskripsi:** List query (messages.routes:12-18) order `created_at DESC, id DESC`. Index `idx_messages_story_created` pada `(story_id, created_at)`. SQLite bisa pakai untuk filter `story_id=?` dan reverse-scan pada `created_at`, tapi secondary `id DESC` ordering tidak ter-cover index, butuh in-memory sort (atau secondary lookup) untuk row yang share `created_at` second. `CURRENT_TIMESTAMP` 1-second resolution, jadi multiple message dalam detik yang sama (umum chat cepat) collide pada `created_at` dan butuh id tiebreaker sort yang index tak bisa satisfy.
- **Root Cause:** Kolom index tak match full ORDER BY clause.
- **Dampak ke User:** Minor: extra sort cost pada message pagination saat banyak message share timestamp second. Tidak user-visible di skala single-user.
- **Solusi yang Diperlukan:** Bikin index `(story_id, created_at DESC, id DESC)` untuk full-cover ORDER BY dan eliminasi secondary sort.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-039] normalizeDynamicMemory diduplikasi di promptBuilder.service.js sebagai parseDynamicMemory — dua copy divergen
- **Severity:** LOW
- **File:** backend/src/services/memoryExtractor.service.js, backend/src/services/promptBuilder.service.js
- **Baris:** extractor 21-64; promptBuilder 41-76
- **Kategori:** MAINTAINABILITY
- **Deskripsi:** `normalizeDynamicMemory` (extractor 21-64) dan `parseDynamicMemory` (promptBuilder 41-76) implement logic migration legacy-array-to-categorized-object yang sama dengan code near-identical tapi dua copy terpisah. Fix apapun ke legacy parser (mis. normalisasi bracket yang dibutuhkan TEMUAN-001) harus di-apply di dua tempat atau dua konsumer diverge. Sudah berbeda subtly (promptBuilder inline category list bukan `VALID_CATEGORIES`). Konstanta tagged-key juga diduplikasi: `TAGGED_KEYS` (extractor:6) vs `REL_TAGGED_KEYS` (promptBuilder:78).
- **Root Cause:** Copy-paste parser logic antar dua service tanpa shared util.
- **Dampak ke User:** Tidak langsung. Maintenance hazard: bug fix di satu copy silent miss yang lain — persis risk normalisasi bracket TEMUAN-001/002.
- **Solusi yang Diperlukan:** Extract satu canonical dynamic-memory parser ke util/ (atau memoryManager.service) dan import di kedua memoryExtractor dan promptBuilder. Share konstanta tagged-key. **Ini prerequisite struktural agar fix TEMUAN-001/002 tak drift.**
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-040] stripReasoningContent jalankan dua pass regex overlap untuk ctrl32 dan bisa match konten user ber-tag think-like
- **Severity:** LOW
- **File:** backend/src/util/text.js (juga frontend textUtils.js mirror)
- **Baris:** 10-21
- **Kategori:** MAINTAINABILITY / CORRECTNESS
- **Deskripsi:** `stripReasoningContent` strip tag `['ctrl32','think','reasoning','thought','analysis']` via loop generic (13-17) lalu dua pass ctrl32-specific lagi (18-19). Loop generic sudah handle ctrl32, jadi 18-19 redundant. Lebih penting: tag `think`,`reasoning`,`thought`,`analysis` adalah kata Inggris umum; jika konten roleplay user legit berisi `<analysis>...</analysis>` sebagai in-story markup (plausible di storytelling app), silent di-strip dari output AI, corrupt prose yang ditampilkan. Regex non-greedy `[\s\S]*?` jadi strip match terpendek, tapi single opening `<analysis>` dengan `</analysis>` kemudian tetap delete semua di antaranya.
- **Root Cause:** Tag whitelist terlalu luas overlap dengan plausible in-story XML-like markup; pass ctrl32 redundant.
- **Dampak ke User:** Rare tapi possible: in-story content pakai nama tag ini silent di-delete dari AI bubble.
- **Solusi yang Diperlukan:** Restrict tag list ke model-specific reasoning tag saja (mis. `<think>` DeepSeek, `<ctrl32>` known model) dan hapus tag kata Inggris generik. Drop baris ctrl32 redundant.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-041] changed-detection compare JSON.stringify capped vs existing yang di-normalize dari raw DB string — order/shape mismatch cause spurious write
- **Severity:** LOW
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 333-337 (changed check)
- **Kategori:** LOGIC_ERROR / EFFICIENCY
- **Deskripsi:** Check `changed` (335-337) compare `JSON.stringify(capped)` terhadap `JSON.stringify(existingMemory)`. `existingMemory` = output `normalizeDynamicMemory(story.dynamic_memory)` yang re-serialize object parsed. Jika DB string punya key order beda, extra whitespace, atau legacy entry yang normalize drop, stringified form beda meski content logical unchanged → trigger redundant UPDATE write (dan re-fire auditor/summarizer di 341-342). Guard `totalBefore/totalAfter` mitigasi case count tapi bukan case shape.
- **Root Cause:** String comparison serialized JSON bukan deep structural comparison; normalize tak canonicalize key order atau drop no-op difference konsisten.
- **Dampak ke User:** Extra DB write dan unnecessary auditor/summarizer LLM call pada turn memory logical unchanged — wasted token dan latency, minor.
- **Solusi yang Diperlukan:** Compare canonical deep-equal array categorized (order-insensitive) bukan `JSON.stringify`, atau canonicalize kedua sisi ke sorted-key compact JSON sebelum compare.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-042] Input extractor di-truncate 2000 char bisa miss perubahan status akhir
- **Severity:** LOW
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 269-270 (slice 2000)
- **Kategori:** CORRECTNESS
- **Deskripsi:** `callExtractor` slice `userMessage` dan `assistantMessage` ke 2000 char sebelum kirim ke extractor LLM. AI reply panjang yang perubahan relationship-status terjadi lewat karakter 2000 tak pernah dilihat extractor.
- **Root Cause:** Fixed 2000-char truncation tanpa prioritisasi tail di mana development baru sering muncul.
- **Dampak ke User:** Perubahan state hubungan di reply panjang tidak tertangkap → memory stale → BUG-05 symptom.
- **Solusi yang Diperlukan:** Pakai budget lebih besar atau sliding, atau include head dan tail message panjang bukan hanya head.
- **Terkait dengan Bug User:** BUG-05
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-043] JSON parse fail silent pada leading prose; tak ada salvage embedded JSON object
- **Severity:** LOW
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 286-303 (parse), 255-264 (stripCodeFences)
- **Kategori:** ROBUSTNESS
- **Deskripsi:** `stripCodeFences` hanya strip ``` fence. Jika extractor LLM prefix JSON dengan prose (mis. 'Berikut memori: {...}'), `JSON.parse(cleaned)` throw, catch log dan return null, dan whole extraction skip. Tidak ada regex extraction first balanced `{...}` block.
- **Root Cause:** Tidak ada fallback extraction embedded JSON object; rely LLM return pure JSON.
- **Dampak ke User:** Intermittent silent extraction failure pada model yang prepend text → memory tidak update → BUG-04/05 staleness.
- **Solusi yang Diperlukan:** Saat raw `JSON.parse` fail, attempt extract first `{...}` substring (balanced-brace scan) dan parse itu sebelum give up. (Catatan: `tryParseStoryJson` di messages.controller sudah implement pola ini untuk chat JSON — bisa reuse.)
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-044] changed-check via JSON.stringify order-sensitive → spurious write
- **Severity:** LOW
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 333-337
- **Kategori:** EFFICIENCY
- **Deskripsi:** Flag `changed` compare `JSON.stringify(capped) !== JSON.stringify(existingMemory)`. Jika dua array berisi string sama dalam order beda, `JSON.stringify` beda dan write di-trigger meski tak ada perubahan semantik. Disjunction `totalAfter !== totalBefore` redundant (total beda imply JSON beda). (Overlap dengan TEMUAN-041 — sisi order-sensitivity spesifik.)
- **Root Cause:** Order-sensitive string comparison unordered fact set.
- **Dampak ke User:** Extra unnecessary DB write dan downstream auditor/summarizer fan-out pada no-op extraction. Minor wear dan LLM cost.
- **Solusi yang Diperlukan:** Compare sorted/normalized fact set (mis. per-category sorted array) bukan raw `JSON.stringify`.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-045] Auditor drop-matching fragile ke internal spacing; tagged-deletion guard prompt-only
- **Severity:** LOW
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 415-429 (auditor dropSet match)
- **Kategori:** ROBUSTNESS
- **Deskripsi:** Auditor bangun `dropSet` dari lowercased+trimmed LLM-suggested string dan match terhadap `f.toLowerCase().trim()`. Internal whitespace beda (double space, tab vs space) cause no-match, jadi fact yang LLM flag untuk delete mungkin survive. Prohibisi hapus tagged fact di-enforce hanya oleh LLM ikuti prompt, bukan oleh kode.
- **Root Cause:** Matching pakai simple trim+lowercase tanpa whitespace normalization; tagged-fact protection prompt-instruction-based, bukan code-enforced.
- **Dampak ke User:** Auditor mungkin fail remove fact intended, atau jika LLM disobey bisa hapus tagged state. Low likelihood tapi undermine memory hygiene.
- **Solusi yang Diperlukan:** Normalize whitespace (collapse run) sebelum compare; eksplisit skip fact yang match tagged pattern di kode bukan trust LLM tidak flag.
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-046] Duplikasi implementasi parser dynamic_memory antar dua service
- **Severity:** LOW
- **File:** backend/src/services/promptBuilder.service.js, backend/src/services/memoryExtractor.service.js
- **Baris:** promptBuilder 41-76; extractor 21-64
- **Kategori:** MAINTAINABILITY
- **Deskripsi:** `parseDynamicMemory` di promptBuilder dan `normalizeDynamicMemory` di extractor implement parse legacy+new-schema yang sama dengan logic migration `KEY: value` yang sama, diduplikasi. Bisa drift independen. (Sama dengan TEMUAN-039 — ditemukan dua cluster, satu entry untuk avoid duplikasi laporan; fix yang sama: extract shared module.)
- **Root Cause:** Tidak ada shared parser module; logic copy-paste.
- **Dampak ke User:** Fix ke migration/dedup logic di satu file mungkin tak reach yang lain, cause prompt builder render fact beda dari cara extractor store.
- **Solusi yang Diperlukan:** Extract satu canonical normalize/parse function ke shared module dan import dari kedua service. (Merge dengan TEMUAN-039 saat eksekusi.)
- **Terkait dengan Bug User:** BUG-04
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-047] Extractor failure hanya di-log; tak ada retry atau backoff pada transient LLM error
- **Severity:** LOW
- **File:** backend/src/services/memoryExtractor.service.js
- **Baris:** 381-389 (call fire-and-forget catch), 281-284 (callExtractor catch)
- **Kategori:** RELIABILITY
- **Deskripsi:** Saat `callExtractor` return null (call error atau parse error) atau `extractAndMergeFacts` throw, failure `console.error/warn`'d dan ditelan. Tidak ada retry, backoff, atau surfacing ke user bahwa memory tidak update untuk turn itu.
- **Root Cause:** Fire-and-forget pattern tanpa retry policy untuk subsystem non-critical tapi state-affecting.
- **Dampak ke User:** Transient provider hiccup silent skip memory extraction untuk turn; perubahan relationship di turn itu tak pernah direkam → BUG-05 staleness tanpa signal.
- **Solusi yang Diperlukan:** Tambah bounded retry dengan backoff untuk transient extractor failure, dan opsional expose non-blocking health flag supaya UI bisa indikasi memory mungkin stale.
- **Terkait dengan Bug User:** BUG-05
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-048] isLikelyValidMp3 reject valid MP3 kecil di bawah 2048 byte — segmen pendek silent dianggap corrupt
- **Severity:** LOW
- **File:** backend/src/services/edgeTts.service.js
- **Baris:** 359-372 (isLikelyValidMp3), 82 (MIN_VALID_MP3_SIZE)
- **Kategori:** LOGIC_ERROR
- **Deskripsi:** `MIN_VALID_MP3_SIZE = 2048` (82). `isLikelyValidMp3` return false jika `buf.length < 2048` (360) sebelum cek magic bytes. MP3 TTS segmen pendek legit (mis. dialogue 1-kata 'Iya.' produksi MP3 valid ID3-tagged di bawah 2KB) gagal size gate, di-treat corrupt, dan tak pernah cache (`synthesizeText` 346-350 log dan return tanpa `cachePut`). Setiap replay segmen pendek re-synthesize. Cek ID3/sync-byte di 362-369 akan benar accept, tapi tak pernah reach karena size short-circuit.
- **Root Cause:** Size floor dipilih untuk reject garbage WebSocket chunk, tapi di-apply sebelum magic-byte check, jadi juga reject genuine short audio. Dua check harus OR'd (valid magic OR size above floor), bukan AND'd dengan size dulu.
- **Dampak ke User:** Segmen dialogue pendek tak pernah cache; replay selalu re-hit Edge TTS. Minor latency replay line pendek; tak affect first-play correctness.
- **Solusi yang Diperlukan:** Reorder: cek magic bytes dulu; hanya fallback ke size floor saat magic bytes absent. Buffer dengan valid ID3 atau MPEG-sync harus accept terlepas size.
- **Terkait dengan Bug User:** BUG-03
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-049] warmup() failure reset warmupPromise ke undefined di .catch, tapi resolved value jadi undefined — caller berikutnya re-trigger warmup
- **Severity:** LOW
- **File:** backend/src/services/edgeTts.service.js
- **Baris:** 392-410 (warmup)
- **Kategori:** RACE_CONDITION / LOGIC_ERROR
- **Deskripsi:** `warmup()` set `warmupPromise = (async () => {...})().catch(err => { ...; warmupPromise = null; })` (394-408). Handler `.catch` return undefined (no return), jadi assigned `warmupPromise` resolve ke undefined, bukan Promise-with-result. Saat async IIFE pending, `warmupPromise` pending Promise (truthy) jadi caller konkuren share — benar. Tapi setelah settle ke undefined, `warmup()` call berikut lihat `warmupPromise` undefined (falsy) dan re-run full 4-voice warmup meski run sebelumnya sukses. Tidak ada sentinel 'successfully warmed'; hanya failure reset. Pada success, `warmupPromise` stay (resolved-to-undefined) yang falsy, jadi guard `if (warmupPromise) return warmupPromise` (393) TIDAK short-circuit warmup() call kedua — re-warm.
- **Root Cause:** Success path tak retain truthy 'warmed' marker; promise resolve ke undefined dan guard falsy biar call berikut re-run. Reset-on-failure logic konflate 'reset untuk retry' dengan 'success juga yield falsy'.
- **Dampak ke User:** warmup() berulang (mis. frontend call `/tts/warmup` setiap page load) re-synthesize 4 warmup voice setiap kali bukan idempotent. Wasted Edge TTS call dan bandwidth setiap refresh — juga kontributor persepsi BUG-01 'cache not active' jika warmup masih in-flight saat notice show.
- **Solusi yang Diperlukan:** Pada success, set `warmupPromise` ke resolved truthy sentinel (mis. resolved Promise resolving ke `true`) supaya guard short-circuit. Hanya reset ke null pada failure. Bedakan 'never run','running','succeeded','failed'.
- **Terkait dengan Bug User:** BUG-01
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-050] synthesizeText bisa return buffer corrupt/too-small dan route kirim sebagai audio/mpeg 200 tanpa cek validitas
- **Severity:** LOW
- **File:** backend/src/routes/tts.routes.js, backend/src/services/edgeTts.service.js
- **Baris:** tts.routes 60-73; edgeTts 345-351 (return buffer meski invalid)
- **Kategori:** VALIDATION
- **Deskripsi:** POST `/api/tts` await `synthesizeText` (61) dan unconditional set `Content-Length` ke `buffer.length` dan `res.end(buffer)` (65, 73). `synthesizeText` (345-351) return `buffer` meski `isLikelyValidMp3(buffer)` false — hanya log warning (349) dan skip `cachePut`, tapi tetap return buffer. Jadi buffer corrupt/kecil reach client sebagai 200 audio/mpeg response. Frontend `new Audio(blob:url).play()` lalu gagal play tanpa backend error signal.
- **Root Cause:** Route trust return value `synthesizeText` sebagai valid audio. `synthesizeText` tak throw pada output corrupt; return saja. Cek validitas hanya cache gate, bukan return gate.
- **Dampak ke User:** Occasional silent playback failure di mana backend return 200 dengan byte non-playable. User klik play, tak terjadi apa2, no error surfaced. Susah diagnose.
- **Solusi yang Diperlukan:** `synthesizeText` throw (atau return null) saat final buffer bukan `isLikelyValidMp3`, setelah retry habis. Di route, treat null/invalid buffer sebagai 500/502 supaya frontend bisa fallback.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-051] Rollback content-fallback lookup hapus pesan user terbaru by content match — bisa hapus message salah pada content identik berulang
- **Severity:** LOW
- **File:** backend/src/routes/messages.routes.js
- **Baris:** 163-179 (fallback lookup), 175 (findLatestUserMessageByContentStmt)
- **Kategori:** VALIDATION
- **Deskripsi:** Saat `user_message_id` absent, rollback endpoint fallback ke `findLatestUserMessageByContentStmt` (175) yang select newest user message dengan `raw_content` match untuk story, lalu hapus (193). Jika user kirim text sama dua kali berturut (umum roleplay: '...', emote berulang), newest match dihapus — yang intended untuk turn baru saja di-abort. TAPI jika abort terjadi setelah message identik KEDUA sudah save, lookup hapus yang kedua sementara yang pertama (stale) remain. Content match tak punya time window guard (mis. hanya message created dalam N detik terakhir).
- **Root Cause:** Content-based fallback lookup tak punya temporal scope. Asumsi newest matching message adalah yang di-rollback, yang break saat message identik ada across turn beda.
- **Dampak ke User:** Rare: pada rollback turn yang user content duplicate turn sebelumnya, message (newer) salah dihapus dan duplicate older stay, tinggalkan stale message di history.
- **Solusi yang Diperlukan:** Scope fallback lookup ke message created dalam window pendek (mis. 30s terakhir) dari request rollback, atau require frontend selalu kirim `user_message_id` (capture dari SSE meta event) dan drop content fallback.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-052] In-process synthCache bounded by count (128) bukan by bytes — unbounded memory jika MP3 size grow
- **Severity:** LOW
- **File:** backend/src/services/edgeTts.service.js
- **Baris:** 34-35 (synthCache Map, MAX_CACHE_SIZE 128)
- **Kategori:** RESOURCE_LEAK
- **Deskripsi:** `synthCache` Map cap `MAX_CACHE_SIZE = 128` entry (34). Tiap entry full MP3 Buffer. Tidak ada byte ceiling. Dengan cap text 5000-char (tts.routes:53), single MP3 ~puluhan KB, jadi 128 entry beberapa MB — acceptable single-user self-hosted. Tapi tak ada guard: jika text length limit berubah atau Edge TTS return high-bitrate audio, memory grow linear dengan entry count only, bukan buffered bytes.
- **Root Cause:** Cache eviction count-based tanpa awareness total cached bytes.
- **Dampak ke User:** Tidak ada current untuk single-user. Latent: future change raise text limit atau voice beda dengan frame lebih besar bisa push memory tak terduga.
- **Solusi yang Diperlukan:** Tambah soft byte ceiling tracked alongside count; evict oldest sampai under kedua limit. Atau dokumentasi asumsi (5000-char text cap) sebagai ceiling di comment `ponytail:`.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-053] Heartbeat interval (15s) vs first-byte timeout (25s) mismatch — heartbeat fire mid-stream pre-token
- **Severity:** LOW
- **File:** backend/src/controllers/messages.controller.js, backend/src/services/modelProvider.service.js
- **Baris:** controller 248-250 (heartbeat 15s); modelProvider 136-139 (FIRST_BYTE_TIMEOUT_MS 25s)
- **Kategori:** LOGIC_ERROR
- **Deskripsi:** `streamChat` set 15s heartbeat write `:\n\n` (249) dan `res.on('close')` clear + abort (251-254). First-byte timeout di modelProvider 25s. Jika provider lambat first token (mis. 20s reasoning), heartbeat fire di 15s dan write comment line ke SSE stream. SSE comment line (`:`) valid dan di-ignore EventSource, jadi bukan breakage — tapi heartbeat fire tanpa token yet. Issue: heartbeat period dan first-byte timeout dipilih independen tanpa align; heartbeat bisa precede first token pada provider lambat, yang strict SSE consumer mungkin log sebagai out-of-band event.
- **Root Cause:** Heartbeat period dan first-byte timeout dipilih independen tanpa align.
- **Dampak ke User:** Negligible untuk EventSource (comment di-ignore). Potential noise di custom parser. Tidak ada functional breakage.
- **Solusi yang Diperlukan:** Align heartbeat fire hanya setelah first token (start interval setelah first token received), atau set heartbeat > first-byte timeout supaya comment tak pernah precede first token.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-054] Generator endpoint tak ada rate limiting dan tak story-scoping — client manapun bisa invoke provider LLM call langsung
- **Severity:** LOW
- **File:** backend/src/routes/generator.routes.js
- **Baris:** 56-110
- **Kategori:** SECURITY / VALIDATION
- **Deskripsi:** POST `/api/generator/character` call `chatCompletionOnce` (74) dengan user-supplied prompt sampai 2000 char. Tidak ada auth, rate limit, story association. Konteks single-user self-hosted low risk, tapi endpoint direct unbounded trigger paid provider LLM call. Combined dengan cap 2000-char bound cost per call, tapi malicious/buggy script bisa hammer. Endpoint juga return normalized character JSON yang lalu di-trust frontend untuk create story. `normalizeGenerated` output tak di-cap ke `STORY_FIELD_MAX_LENGTH` (mis. `ai_personality` 500) — create-story path validate, tapi generator output hanya normalize, tidak length-cap, jadi downstream bisa 413.
- **Root Cause:** Tidak ada access control atau throttling pada provider-invoking endpoint. Boot-time env check (comment 70) ensure config ada tapi bukan caller authorized.
- **Dampak ke User:** Single-user self-hosted: low. Jika port expose di luar localhost, attacker bisa burn provider token. Generated character juga di-inject ke story creation tanpa server-side re-validation length field.
- **Solusi yang Diperlukan:** Self-hosted single-user acceptable; dokumentasi asumsi localhost-only. Jika exposure possible, tambah shared-secret header atau localhost-only bind. Opsional cap `normalizeGenerated` output ke `STORY_FIELD_MAX_LENGTH` untuk avoid downstream 413.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-055] Empty-response path kirim SSE error dan end, tapi pesan user sudah di-insert — tinggalkan user message unanswered di DB
- **Severity:** LOW
- **File:** backend/src/controllers/messages.controller.js, backend/src/routes/messages.routes.js
- **Baris:** controller 290-298 (empty-response); routes 115 (insert user sebelum streamChat)
- **Kategori:** LOGIC_ERROR / CORRECTNESS
- **Deskripsi:** POST `/messages` insert user message (routes 115) SEBELUM `streamChat`. Di `streamChat`, jika provider return empty accumulator (290), controller kirim SSE error 'EMPTY_RESPONSE' dan `res.end()` (291-297) dan return — tidak ada assistant message di-insert. User message remain di DB tanpa paired assistant turn. Saat refresh berikut, user lihat message mereka tanpa AI reply, dan `buildContextPayload` berikut akan include orphan user message ini sebagai recent context, potentially bingungkan model. Sama untuk path provider-error (280-288): user row remain, no assistant.
- **Root Cause:** User message insertion decouple dari assistant message insertion dan tidak di-rollback pada empty-response. Tidak ada cleanup user row pada path empty-response (juga path provider-error).
- **Dampak ke User:** Orphan user message akumulasi di history setelah provider hiccup, polluting short-term context dan show sebagai unanswered message di UI. (Trace SSE-001/SSE-003 juga konfirm: refresh mid-stream identik — backend tak bisa bedakan Stop dari refresh, keduanya AbortError, user row orphan tanpa rollback.)
- **Solusi yang Diperlukan:** Pada path empty-response dan provider-error, hapus user message yang baru di-insert (mirror logic rollback) ATAU insert fallback assistant message supaya turn complete. Prefer hapus user message supaya history bersih, dan biar frontend re-send. Tambahan: register rollback otomatis pada `res 'close'` saat tidak ada assistant tersimpan, agar refresh mid-stream juga bersih (lihat trace SSE-003).
- **Terkait dengan Bug User:** BUG-02
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-056] createStory tak validate panjang user_persona/target_ending/title sebelum insert untuk semua path — language_style cap 80 tak di-enforce saat create
- **Severity:** LOW
- **File:** backend/src/controllers/stories.controller.js, backend/src/db/seed.js
- **Baris:** controller 165-230 (createStory), 175-181 (createRaw cap loop), 148-163 (validateCreatePayload); seed 22-25 (validateLanguageStyle)
- **Kategori:** VALIDATION
- **Deskripsi:** `validateCreatePayload` (148-163) cek required field non-empty string tapi bukan length. `createRaw` (167-174) include title, user_name, user_persona, ai_name, ai_personality, target_ending dan loop cap tiap (175-181). user_persona cap 1000, ai_personality cap 500 — keduanya checked. Jadi semua createRaw field capped. Gap: `language_style` required dan di-validate oleh `validateLanguageStyle` tapi **tak punya length cap** (`STORY_FIELD_MAX_LENGTH` punya `language_style: 80` tapi createRaw tak include language_style, jadi cap 80 tak apply saat create — hanya saat update via generic loop 361-376). `validateLanguageStyle` di seed.js (22-25) **accept any non-empty string** (`typeof value === 'string' && value.trim().length > 0`) — bukan strict allowlist — jadi custom string uncapped bisa di-insert.
- **Root Cause:** createRaw omit language_style dari length-cap loop; di-validate oleh pseudo-allowlist yang ternyata accept custom string.
- **Dampak ke User:** Low: custom language_style over-80-char bisa di-create, bypass cap 80 yang update enforce. Tidak crash, tapi inkonsistensi.
- **Solusi yang Diperlukan:** Include language_style di cap loop createRaw, ATAU konfirmasi `validateLanguageStyle` strict allowlist (tidak — seed.js accept custom) dan cap 80 moot. Safest: tambah language_style ke cap loop.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-057] ttsQueueManager.js dan ttsEngine.js dead code — tak di-import live pipeline, tapi di-precache SW
- **Severity:** LOW
- **File:** frontend/public/js/core/ttsQueueManager.js, frontend/public/js/core/ttsEngine.js, frontend/public/sw.js
- **Baris:** ttsQueueManager 1-625; ttsEngine 1-141; sw 37-38 (precache)
- **Kategori:** MAINTAINABILITY / DEAD_CODE
- **Deskripsi:** story.page.js (satu-satunya page yang TTS) TIDAK import ttsQueueManager atau ttsEngine (import: apiClient, themeManager, markdownRenderer, textUtils; satu-satunya referensi ttsQueueManager comment stale di 217). Live playback pipeline = inline `_ttsAudio = new Audio()` / `_playBlobAsAudio` (story.page 283-527). ttsQueueManager.js (625 baris) dan ttsEngine.js (141 baris) fully dead. Meski begitu sw.js APP_SHELL (37-38) precache keduanya, waste cache storage dan bandwidth setiap install, dan remain maintenance hazard (masih call `window.speechSynthesis`, add pagehide/visibilitychange listener via singleton 611-619 — meski module tak pernah import, listener tak pernah registered). Penting untuk auditor/DeepSeek: **10s timeout + 3x retry yang disebut di brief audit ADA di file ini tapi BUKAN live path** — jangan salah fix file ini untuk BUG-03.
- **Root Cause:** Segment-based playback pipeline di-replace oleh 1-voice-per-story inline pipeline, tapi module lama ditinggal dan masih di-list SW precache.
- **Dampak ke User:** Tidak ada runtime (dead), tapi cache inflate, bingungkan maintainer, dan risk seseorang re-import singleton broken.
- **Solusi yang Diperlukan:** Hapus ttsQueueManager.js dan ttsEngine.js (atau konsolidasi helper masih berguna seperti `parseTaggedSegments` ke live path) dan hapus dari sw.js APP_SHELL.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-058] themeToggle.js import export non-existent dari themeManager.js dan pakai theme 'child' yang dihapus — broken dead module
- **Severity:** LOW
- **File:** frontend/public/js/core/themeToggle.js, frontend/public/js/core/themeManager.js
- **Baris:** themeToggle 5-9 (import), 11-21 (ICON_MAP/LABEL_MAP); themeManager 60 (export singleton), 14-19 (migrate child→coffee), 23/37 (allowlist dark/light/coffee)
- **Kategori:** CORRECTNESS / DEAD_CODE
- **Deskripsi:** themeToggle.js:5-9 import `{ getCurrentTheme, cycleTheme, getThemeMeta }` dari `./themeManager.js`. themeManager.js export hanya `export const themeManager = new ThemeManager()` (60) — tidak ada named export getCurrentTheme/cycleTheme/getThemeMeta. Import bind ke undefined; call (26, 37) throw TypeError. Tambahan ICON_MAP/LABEL_MAP (11-21) referensi theme `child`, yang themeManager migrasi ke `coffee` (14-19, valid set dark/light/coffee di 23/37) — jadi meski import resolve, map stale. Module tak pernah di-import page manapun (grep show hanya themeToggleBtn element ID dan file sendiri), jadi breakage latent.
- **Root Cause:** themeManager di-refactor ke class singleton dengan nama export beda dan theme migration, tapi themeToggle.js tak pernah di-update atau dihapus.
- **Dampak ke User:** Tidak ada current (dead). Jika siapapun import mountThemeToggle crash langsung.
- **Solusi yang Diperlukan:** Hapus themeToggle.js (page wire themeToggleBtn langsung via `themeManager.toggleTheme`) atau rewrite import singleton themeManager dan pakai label dark/light/coffee.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-059] renderMarkdown bypass md.render yang di-override — dialogue class decoration tak pernah apply
- **Severity:** LOW
- **File:** frontend/public/js/core/markdownRenderer.js
- **Baris:** 22-32
- **Kategori:** LOGIC_ERROR
- **Deskripsi:** `md.render` di-monkey-patch (22-27) untuk call `md.parse` + `decorateDialogue` + `md.renderer.render`, tambah class `dialogue` ke inline token yang mulai dengan quote. Tapi `renderMarkdown` (29-32) call `originalRender(text)` — bound ORIGINAL `md.render` yang di-capture di 22 SEBELUM override. Jadi decorated path hanya reach jika caller invoke `md.render(...)` langsung; exported `renderMarkdown` yang dipakai story.page.js (`formatTextWithMarkdown`, 1151) selalu ambil original undecorated. Dialogue styling dead.
- **Root Cause:** `renderMarkdown` ditulis untuk call saved `originalRender` bukan `md.render` yang sekarang di-override, mengalahkan patch.
- **Dampak ke User:** Dialogue line tak visually distinguished (tidak ada CSS class `dialogue`) — silent feature regression.
- **Solusi yang Diperlukan:** `renderMarkdown` call overridden `md.render` (mis. `md.render(text, env)`) supaya `decorateDialogue` jalan, atau pindah decoration ke render rule / function `renderMarkdown` langsung.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-060] Dua method SSE dengan error semantic inkonsisten; sendMessage dead code
- **Severity:** LOW
- **File:** frontend/public/js/api/apiClient.js
- **Baris:** 179-258 (sendMessage), 37-112 (postSSE)
- **Kategori:** MAINTAINABILITY / DEAD_CODE
- **Deskripsi:** apiClient expose dua consumer SSE near-identical: `postSSE` (37-112, dipakai story.page.js) dan `sendMessage` (179-258, tak di-import manapun — grep konfirmasi hanya apiClient.js referensi sendMessage). Diverge error handling: `postSSE` 'error' event RESOLVE promise (91-96, supaya page try-path inspect providerError), `sendMessage` 'error' event REJECT (242-246). `postSSE` juga handle named event (meta/token/done/error) via switch eventName; `sendMessage` parse hanya `data:` line dan treat setiap block sebagai 'message'. Maintain dua implementasi divergen protocol sama = hazard, dan yang unused akan silent rot.
- **Root Cause:** sendMessage API lama; postSSE supersede tapi method lama tak dihapus.
- **Dampak ke User:** Tidak ada runtime (sendMessage unused), tapi future caller pick method salah dapat error behavior beda.
- **Solusi yang Diperlukan:** Hapus sendMessage. Jika semantic reject-on-error pernah butuh, tambah option ke postSSE bukan keep implementasi kedua.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-061] EventBus.emit tak ada try/catch — satu listener throw abort listener sisanya
- **Severity:** LOW
- **File:** frontend/public/js/core/eventBus.js
- **Baris:** 21-25 (emit)
- **Kategori:** ROBUSTNESS
- **Deskripsi:** `EventBus.emit` (21-25) iterasi listener dengan `this.events[event].forEach(l => l(data))` tanpa error isolation. Jika listener N throw, listener N+1..end di-skip (forEach propagate exception). Kontras `ttsQueueManager.emit` (83-87) yang wrap setiap call try/catch. Dua emitter di codebase ikut safety contract beda. Tambahan, karena forEach iterasi live array, listener yang call `EventBus.off(event, itself)` saat emit splice array mid-iteration, cause forEach skip listener berikut.
- **Root Cause:** Tidak ada per-listener error isolation dan tidak ada copy/snapshot array listener sebelum iterasi.
- **Dampak ke User:** Single faulty listener bisa suppress theme-change atau event lain untuk rest app silent.
- **Solusi yang Diperlukan:** Wrap setiap listener call try/catch (match `ttsQueueManager.emit`) dan iterasi shallow copy array supaya off-during-emit safe.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-062] SW APP_SHELL precache bare path tapi page request versioned ?v=N URL — precache tak pernah hit, SWR refetch
- **Severity:** LOW
- **File:** frontend/public/sw.js, frontend/public/story.html, frontend/public/index.html
- **Baris:** sw 28-46 (APP_SHELL); story.html 292 (`story.page.js?v=38`), 12 (`tailwind.output.css?v=17`)
- **Kategori:** PERFORMANCE
- **Deskripsi:** APP_SHELL list bare path seperti `/js/pages/story.page.js` (33) dan `/css/tailwind.output.css` bahkan TIDAK di-list, sementara story.html request `/js/pages/story.page.js?v=38` (292) dan `/css/tailwind.output.css?v=17` (12). Cache key URL-sensitive, jadi bare path yang di-precache tak match request versioned — SWR branch fetch over network saat first load dan hanya cache URL versioned setelahnya. Kerja precache untuk JS file itu wasted. `tailwind.output.css` missing dari APP_SHELL entirely, jadi tak pernah di-precache.
- **Root Cause:** Precache list tak sinkron dengan cache-busting query string yang dipakai HTML.
- **Dampak ke User:** First load setelah install tetap hit network untuk versioned JS/CSS; offline-first intent partial defeated.
- **Solusi yang Diperlukan:** Include exact versioned URL di APP_SHELL (dan bump saat deploy), ATAU drop query string dari HTML dan rely CACHE_VERSION bump untuk invalidasi. Tambah `tailwind.output.css` ke precache list.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-063] No token-aware truncation dynamic_memory di prompt (sisi bytes-per-fact unbounded)
- **Severity:** LOW (di-downgrade dari MEDIUM — klaim "prompt tumbuh tak terbatas" REFUTED sebagian)
- **File:** backend/src/services/promptBuilder.service.js, backend/src/services/memoryExtractor.service.js
- **Baris:** promptBuilder 158-178 (renderDynamicFacts); extractor capMemory 235-253, summarizeFacts 466-476
- **Kategori:** RELIABILITY
- **Deskripsi:** Temuan awal B-MEM-010 klaim "system prompt grows unbounded" dan "only size guard is hard abort 200KB". **Verifier UNCERTAIN → downgrade LOW**: count DI-bounded — `MAX_DYNAMIC_FACTS_TOTAL=60` (extractor:4) di-enforce `capMemory` (235), plus `summarizeFacts` compress saat count >50 (466-476), plus chat window clamp 3-5 exchange (memoryManager 12-19). Hanya **BYTES-PER-FACT** yang unbounded (free-text string, tak ada per-fact length cap). Worst-case prompt body (~18KB at 60 fact × ~120 char + base + 10 row) satu order magnitude di bawah cap 200KB. Reach 200KB butuh ~60 fact rata-rata ~3KB, yang extractor tak produksi (input slice 2000 char, fact biasanya one-line pendek). Jadi architectural gap (tak ada token/byte budget) **valid tapi low-impact**: jika extractor masa depan produksi fact panjang, `assertBodyFits` (modelProvider 23-34) throw 'Request body terlalu besar' dan `shouldTryNextModel` (83) return false → chain hard-abort dengan SSE error, tidak ada graceful degradation.
- **Root Cause:** `renderDynamicFacts` dump setiap fact tanpa budgeting; satu-satunya size guard = hard abort di provider layer. Count di-cap, bytes-per-fact tidak.
- **Dampak ke User:** Long-running story dengan fact free-text panjang bisa hit hard failure di mana AI stop respond entirely (request reject) bukan gracefully degrade context. Tidak ada user-facing recovery path. Low likelihood saat ini.
- **Solusi yang Diperlukan:** Tambah token/char budget untuk section facts: keep tagged state always, lalu fill dengan narrative fact most-recent/important sampai budget, drop oldest narrative duluan. Jangan biar `assertBodyFits` jadi satu-satunya defense. Opsional: per-fact length cap saat extraction.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: UNCERTAIN → downgrade LOW]

## DAFTAR TEMUAN — INFO SEVERITY

### [TEMUAN-064] buildDefaultVoicePresets USER preset pakai AI gender voice_uri_hint dan hardcoded neutral gender_hint
- **Severity:** INFO
- **File:** backend/src/db/seed.js
- **Baris:** 47-75 (buildDefaultVoicePresets), 60-66 (USER preset)
- **Kategori:** MAINTAINABILITY
- **Deskripsi:** USER voice preset (60-66) set `voice_uri_hint` ke `aiPreset.voice` (voice AI) dan `gender_hint` ke `'neutral'` always, ignore user gender aktual. Map `USER_PRESETS_BY_GENDER` (15-20) define pitch per user gender tapi tak pernah apply ke voice selection USER preset — hanya `aiPreset.voice` dipakai. Jadi user perempuan dapat voice hint karakter AI untuk dialogue line mereka sendiri.
- **Root Cause:** USER preset builder copy AI voice config bukan resolve user-gender-appropriate voice.
- **Dampak ke User:** User dialogue segment mungkin di-synthesize dengan voice timbre karakter AI. Mungkin intentional (single shared Edge TTS voice pool) tapi inkonsisten dengan pitch preset per-gender yang didefinisikan tapi unused. Catatan: live TTS pipeline sekarang pakai satu voice per story (story.tts_voice), jadi preset voice_presets itself juga largely vestigial — tapi row tetap di-seed.
- **Solusi yang Diperlukan:** Resolve USER preset `voice_uri_hint` dan `gender_hint` dari user gender (dan `ALLOWED_TTS_VOICES`), atau hapus map `USER_PRESETS_BY_GENDER` yang unused jika shared voice intentional.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-065] Orphan HTML element toolbarTtsBtn dan ttsIndicator dirender tapi tak pernah di-wire story.page.js
- **Severity:** INFO
- **File:** frontend/public/story.html, frontend/public/js/pages/story.page.js
- **Baris:** story.html 67 (toolbarTtsBtn), 260 (ttsIndicator); story.page 605, 640, 1134-1136 (comment removed)
- **Kategori:** MAINTAINABILITY
- **Deskripsi:** story.html masih berisi `<button id="toolbarTtsBtn">` (67) dan `<div id="ttsIndicator">` (260). story.page.js comment (605, 640, 1134-1136) state ini di-remove dan kode tak query lagi (tidak ada `getElementById` untuk toolbarTtsBtn atau ttsIndicator). Mereka render sebagai element inert/decorative — TTS indicator permanently `hidden` via class tapi toolbarTtsBtn adalah button visible non-functional di reading toolbar (klik tak lakukan apa2).
- **Root Cause:** HTML tak di-prune saat TTS toolbar wiring di-remove.
- **Dampak ke User:** Dead button 'Dengarkan Pesan Terakhir' di reading mode yang tak lakukan apa2 saat klik; minor user confusion.
- **Solusi yang Diperlukan:** Hapus toolbarTtsBtn dan ttsIndicator dari story.html, atau re-wire toolbarTtsBtn untuk play latest AI message.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-066] manifest theme_color static #1a1a1a — mismatch light/coffee theme; tidak ada `id` field
- **Severity:** INFO
- **File:** frontend/public/manifest.webmanifest, frontend/public/story.html, frontend/public/index.html
- **Baris:** manifest 11-12 (theme_color/background_color)
- **Kategori:** MAINTAINABILITY / PWA
- **Deskripsi:** `theme_color` dan `background_color` hardcoded #1a1a1a (dark theme) di 11-12, tapi app support dark/light/coffee theme via themeManager. Saat user pilih light atau coffee, chrome status-bar/URL-bar browser mobile tetap show dark #1a1a1a. Manifest juga tak punya field `id` (recommended untuk PWA identity/store listing stability). index.html dan story.html juga hardcode `<meta name="theme-color" content="#1a1a1a">` tanpa JS update saat theme change.
- **Root Cause:** Theme color di-set sekali untuk default dark theme dan tak pernah di-wire ke themeManager change.
- **Dampak ke User:** Visual mismatch antara app theme dan OS chrome pada installed PWA / mobile browser untuk user light/coffee.
- **Solusi yang Diperlukan:** Tambah field `id` ke manifest. Update `<meta name="theme-color">` content dari `themeManager.setTheme` supaya OS chrome ikut active theme.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

### [TEMUAN-067] getFilteredVoices call langFilter(undefined) dan return semua voice (moot — dead code)
- **Severity:** INFO
- **File:** frontend/public/js/core/ttsQueueManager.js
- **Baris:** 103-106 (getFilteredVoices), 621-624 (langFilter)
- **Kategori:** CORRECTNESS / DEAD_CODE
- **Deskripsi:** `getFilteredVoices()` tak ambil parameter tapi call `this.voices.filter((v) => v.lang?.toLowerCase().startsWith(langFilter(lang)))` di mana `lang` undefined. `langFilter(undefined)` return '' (622-623), jadi `startsWith('')` true untuk setiap voice → method return entire voice list terlepas `this.langFilter`. Filter intended tak pernah apply. Moot karena whole module dead (TEMUAN-057), tapi jika di-revive akan silent bypass language filtering.
- **Root Cause:** Method baca bare `lang` identifier bukan `this.langFilter`.
- **Dampak ke User:** Tidak ada (dead code).
- **Solusi yang Diperlukan:** Pakai `this.langFilter` (instance field yang di-set `setLangFilter`) bukan parameter `lang` undefined, atau hapus method bersama module.
- **Terkait dengan Bug User:** Baru ditemukan
- **Verifikasi:** [V: CONFIRMED]

---

## ALUR SISTEM (DOKUMENTASI)

### Alur Chat SSE (end-to-end)

1. **User submit** — `story.page.js` chatForm `submit` handler (1601-1821). `content = messageInput.value.trim()` (1605). Bikin temp user bubble id `temp-${Date.now()}` (1612-1615) append chatList. Set `isAiResponding=true`, show typingIndicator, disable input, swap sendBtn→stop (1621-1625). Snapshot `currentStory.dynamic_memory` ke `memorySnapshot` (1631-1635) untuk rollback nanti. Bikin AbortController (1638). Bikin temp AI bubble id `ai-${Date.now()}` kosong (1641-1645). Init `currentSendState` (1653-1660). Set handler onContinue/onCancel error-dialog (1663-1713). Call `apiClient.postSSE` (1736) dengan onEvent + sendSignal.
2. **apiClient.postSSE buka fetch + parse SSE** — `apiClient.js` (37-112). `fetch(POST /stories/:id/messages, {content}, signal)`. Non-ok → reject. Ok → reader + TextDecoder. `pump()` baca chunk, akumulasi buffer, split `\n\n`. Per block parse `event:`+`data:`. Dispatch `onEvent('meta'|'token'|'done'|'error')`. Pada event `error`: call onEvent, cancel reader, **RESOLVE** (bukan reject) supaya try-path inspect providerError (91-96). AbortError reader → resolve (102,109). Catatan: `sendMessage` (179-258) adalah duplikat parser SSE yang unused — divergen error semantic (TEMUAN-060).
3. **Route POST /messages** — `messages.routes.js` (104-133). `requireStory` (81-88) load story ke `req.story` (snapshot saat request, **tidak reflect** memory extraction turn ini). Validate content non-empty + ≤20000 (105-109). **INSERT user message sinkron** via `insertMessageStmt.run` (115-120) **SEBELUM** streamChat — user message persist unconditional. Lalu `await streamChat({req,res,story,userMessageId,userContent})` (122-129). ⚠️ User row sudah committed; jika streamChat abort/error, user row stay kecuali rollback DELETE dipanggil. Error setelah titik ini → `next(err)` (130-132) kirim JSON 500, tapi response mungkin sudah text/event-stream (header terkirim) → double-render risk.
4. **streamChat set header + meta** — `messages.controller.js` (224-394). Set `text/event-stream`, no-cache, keep-alive, X-Accel-Buffering:no, flushHeaders (231-235). `buildContextPayload(story, userContent)` → messages array (237). `finalModel = env.DEFAULT_MODEL_ID` (239). `sendSse(res,'meta',{model, user_message_id})` (241-244) — **satu-satunya tempat** client dapat `user_message_id`. Set accumulator, AbortController, heartbeat 15s (246-250). `res.on('close')` → clearInterval + abortCtrl.abort() (251-254). Fire saat client disconnect/refresh mid-stream.
5. **buildContextPayload** — `memoryManager.service.js` (29-53). `clampWindow` (30) → window 3-5. `getRecentStmt` fetch window*2 newest (31), reverse ASC, filter empty (32-35). mode `casual`/`default` → renderer (37-40). `messages=[{system}, ...recentAsc]` (42-45). Append `latestUserMessage` jika non-empty (48-50). ⚠️ **CRITICAL**: user row baru dari langkah 3 SUDAH di DB dan SUDAH di `getRecentStmt` result → muncul **DUA KALI** di payload: sekali di recentAsc, sekali di append line 49 (TEMUAN-003). `getRecentStmt` (4-10) juga tak ada id tiebreaker (TEMUAN-017).
6. **renderSystemPrompt** — `promptBuilder.service.js` (195-323). Embed ai_name/user_name/persona/gender/style/ending. Call `buildCurrentContextBlock(story)` (208, 294) — blok KONTEKS SAAT INI yang surface [STATUS]/[AI_PANGGILAN]/[USER_PANGGILAN]/[KONTEKS_PERILAKU] dari relationship tagged fact (105-140). Call `renderDynamicFacts(story.dynamic_memory)` (207, 295-303) — list semua fact under [Tentang User/AI/Dunia/Hubungan]. ⚠️ Titik tunggal di mana memory di-surface ke AI; jika `buildCurrentContextBlock` return `''` (tagged fact tak ada / tanpa bracket match) AI tak dapat behavioral context — akar BUG-05 (TEMUAN-002/007).
7. **streamChatCompletion — fallback chain + first-byte timeout + token stream** — `modelProvider.service.js` (95-126). Iterasi `env.MODEL_CHAIN`. Per slot: body, assertBodyFits, `yield* streamSingleModel` (105). Throw → `shouldTryNextModel` → continue/rethrow (108-115). `streamSingleModel` (196-277): MAX_RETRIES=1, `_fetchWithFirstByteTimeout` race first-read vs 25s. Timeout/hang → retry once → throw → chain advance. Parse SSE `data:` line, `[DONE]` return (255), yield `{type:'token', text}` per delta (264-265). Setelah loop yield `{type:'done'}` (272). ⚠️ AbortError user di-re-wrap jadi `Error('Provider error...')` di catch 218-226 → chain retry saat cancel (TEMUAN-008).
8. **streamChat konsumsi generator, forward token** — `messages.controller.js` (262-271). `for await chunk`: token → `accumulator += chunk.text`, `sendSse('token',{text})` (263-267). done → break (268-270). Catch (272-288): AbortError → clearInterval, res.end, **RETURN tanpa persist assistant** (273-278). Error lain → `sendSse('error',{message,code})`, clearInterval, res.end, return (280-287). Setelah loop: accumulator empty → `sendSse('error',EMPTY_RESPONSE)`, end, return (290-298). ⚠️ Path abort/error/empty: user row dari langkah 3 tetap di DB orphan (TEMUAN-055, trace SSE-001/003).
9. **Post-stream: parse + persist assistant + TTS cache + done** — `messages.controller.js`. `safeParseFromBuffer(accumulator, ai_gender)` (301) → `tryParseStoryJson` (109-152) ekstrak `{full_story, audio_segments}`; fail → `buildFallbackSegmentsFromText` (161-198). `insertMessageStmt.run('assistant', fullStoryText)` (319-325) — assistant persist DI SINI, setelah stream complete. `upsertMessageTts` (340-345). `sendSse('done',{message_id, full_content, audio_segments, used_fallback_parse})` (351-356) — **satu-satunya tempat** client dapat `ai_message_id`. ⚠️ Assistant persist SEBELUM done dikirim → jika done lost, row tetap ada di DB.
10. **Post-done: pre-synth TTS + memory extraction (fire-and-forget)** — `messages.controller.js`. IIFE (367-379) pre-synthesize semua TTS segment batch 3 via `synthesizeText(seg.text, story.tts_voice)` — ⚠️ pakai `story.tts_voice` bukan `seg.voice_config.voice_name`, tapi live pipeline frontend juga pakai `story.tts_voice` jadi **tidak mismatch** (temuan awal C-002 REFUTED). Non-blocking. `extractAndMergeFacts({story, userMessage, assistantMessage: fullStoryText})` (382-390) fire-and-forget `.catch`. `clearInterval(heartbeat); res.end()` (392-393). ⚠️ Memory extraction jalan SETELAH res.end() — jika proses crash antara res.end dan ekstraksi selesai, memory turn itu tak pernah terekam (trace SSE-006). `story` yang dipass = snapshot request-entry (stale) → race clobber (TEMUAN-006).
11. **Client terima done, finalize bubble** — `story.page.js` (1756-1770). `aiMessageId = data.message_id` (1757). `finalContent = sanitizeFinalContent(data.full_content)` (1764) — strip JSON envelope jika parser fall through. `updateBubbleContent(aiBubble, finalContent)` (1765-1766). `setBubbleRealId(aiBubble, aiMessageId)` (1767-1769) — swap temp id → msg-{realId}. PostSSE resolve (1774-1781): jika aborted/finished → return; jika no displayedText + no providerError → 'AI tidak mengembalikan balasan'; jika no providerError → `finishSend()`. finally (1792-1820): set `_factPollTimerId` 5s untuk re-fetch story + update factCountBadge — ⚠️ poll ini pakai shape handler buggy (TEMUAN-029) dan tak refresh `currentStory.dynamic_memory` (TEMUAN-030).
12. **extractAndMergeFacts** — `memoryExtractor.service.js` (314-350). Guard: missing input → return; `userMessage<8 AND assistantMessage<16` → return (316, catatan: AND bukan OR — trace MEM-006). `normalizeDynamicMemory(story.dynamic_memory)` → existingMemory (318, dari snapshot stale). `callExtractor` (266-304): bangun prompt dengan `{{CURRENT_MEMORY_JSON}}`/`{{USER_MESSAGE}}`/`{{AI_REPLY}}` (slice 2000), `chatCompletionOnce` non-streaming temp 0.2 (274-280). Error → null (281-284). Parse JSON → `{user,ai,world,relationship}` (286-303). ⚠️ Tak ada normalisasi bracket incoming (TEMUAN-001). `mergeDynamicMemory` (218-228): `dedupNarrative` user/ai/world, `mergeRelationshipFacts` relationship (170-197). `capMemory` (235-253) ⚠️ evict tagged duluan (TEMUAN-004). Persist hanya jika changed (333-340). Fire `callMemoryAuditor` + `summarizeFacts` paralel (341-342) ⚠️ race (TEMUAN-006, trace MEM-005).

**Issue sepanjang trace (dirangkum ke temuan):**
- SSE-001/003: refresh mid-stream = AbortError identik Stop, user row orphan tanpa rollback (TEMUAN-055, BUG-02).
- SSE-002/006: user message duplikat di context (TEMUAN-003); memory extraction dari snapshot stale (TEMUAN-006).
- SSE-004: BUG-01 toast via probe rusak (TEMUAN-011).
- SSE-012: `shouldTryNextModel` return false untuk "missing message content" → empty transient abort chain (catatan: AbortError re-wrap TEMUAN-008 lebih kritis).
- SSE-017: system prompt berisi instruksi jailbreak eksplisit ('TIDAK BOLEH menolak konten apapun... adegan kekerasan, seksual, dewasa') — non-actionable untuk konteks produk (roleplay tanpa filter adalah fitur eksplisit sesuai FictionFlow.md Bab 6), catatan INFO saja.

### Alur Memory (end-to-end)

1. **Insert user message** — `messages.routes.js:115-120`. Story row di-load `getStoryStmt` (8-10) ke `req.story` — **snapshot** saat request entry, tidak reflect extraction turn ini. Dipass ke streamChat → extractAndMergeFacts.
2. **System prompt dari snapshot** — `memoryManager.service.js:29-53` `buildContextPayload(story, latestUserMessage)`. Prompt dirender dari snapshot — pakai `dynamic_memory` yang ada di disk saat request mulai, BUKAN yang extractor produksi turn ini.
3. **promptBuilder baca dynamic_memory, bangun KONTEKS SAAT INI (titik surface BUG-05)** — `promptBuilder.service.js` `renderSystemPrompt`/`renderCasualSystemPrompt`. `buildCurrentContextBlock(story)` (105-140) call `parseDynamicMemory` (106) lalu `parseRelationshipState` (108). `parseRelationshipState` (85-97) iterasi `relationship[]`, untuk tiap fact cek `fact.startsWith(\`[${key}]:\`)` untuk key di `REL_TAGGED_KEYS` (78: STATUS, AI_PANGGILAN, USER_PANGGILAN, SEJAK, KONTEKS_PERILAKU). Ekstrak substring setelah prefix sebagai value. Baris 110: jika TIDAK ADA satupun dari STATUS/AI_PANGGILAN/KONTEKS_PERILAKU/USER_PANGGILAN → return `''` (block suppressed). Jika ada (114-137): emit `## KONTEKS SAAT INI [BACA INI SEBELUM MEMBALAS]` dengan instruksi current-state: STATUS sebagai 'Status hubungan dengan user: ...', AI_PANGGILAN 'Cara kamu memanggil user sekarang: ... — gunakan ini secara konsisten', USER_PANGGILAN '...ini sudah normal, jangan bereaksi aneh atau kaget', KONTEKS_PERILAKU 'Panduan perilaku kamu:'. Baris 136 tutup dengan 'Konteks di atas adalah keadaan yang sedang berlaku. Perilakumu HARUS mencerminkan konteks ini setiap saat.' Block di-inject antara STORY IDENTITY dan DYNAMIC FACTS. **JADI [KONTEKS_PERILAKU]/[STATUS] DI-inject sebagai instruksi eksplisit — TAPI hanya saat tagged fact ada di dynamic_memory saat prompt-build, DAN dengan bracket prefix yang match.**
4. **DYNAMIC FACTS block render sebagai flat list (surface sekunder BUG-05)** — `renderDynamicFacts` (158-178). Iterasi kategori print `[Tentang Hubungan]` header lalu `  - ${item}` per fact. Tagged fact seperti `[STATUS]: pacaran` **juga di-dump verbatim** ke flat list. Jadi tagged state muncul DUA KALI: sekali sebagai instruksi KONTEKS terstruktur (langkah 3), sekali sebagai bullet raw di DYNAMIC FACTS. Jika blok KONTEKS ter-suppress (parseRelationshipState tak nemu tagged prefix match, mis. fact tanpa bracket), AI hanya lihat state sebagai bullet anonim di antara banyak fact — mudah di-ignore.
5. **LLM stream → parse → persist assistant** — `messages.controller.js` (257-271, 301, 319-325, 340-349, 351-356). Setelah semua ini baru memory extraction jalan.
6. **extractAndMergeFacts guard** — `memoryExtractor.service.js:314-350`. Return early jika input missing (315) atau `userMessage<8 AND assistantMessage<16` (316). Fire-and-forget dari controller:382-390, `.catch` — SSE response SUDAH end (393) sebelum promise resolve, jadi failure hanya di-log. `story` yang dipass = snapshot request-entry (langkah 1).
7. **normalizeDynamicMemory existing** — (318, 21-64). String → JSON.parse (catch → empty). Object non-array (new schema 32-45): push trimmed string per kategori. Array (legacy 48-61): push `${k}: ${v}` (58) — ⚠️ **PRODUKSI `USER_PANGGILAN: kaishi` TANPA BRACKET** — akar BUG-04 (TEMUAN-021). Return `{user,ai,world,relationship}`.
8. **callExtractor bangun prompt** — (321-325, 266-304). Replace `{{CURRENT_MEMORY_JSON}}` dengan `JSON.stringify(existingMemory)` compact, `{{USER_MESSAGE}}`/`{{AI_REPLY}}` slice 2000. Prompt constant (79-160) instruksikan return JSON 4 key (94), max 60 fact (95), dua tipe relationship fact: JENIS 1 tagged `[KUNCI]: nilai` (99-102, keys STATUS/AI_PANGGILAN/USER_PANGGILAN/SEJAK/KONTEKS_PERILAKU, satu-per-kunci, replace-don't-duplicate) dan JENIS 2 narrative (104-106, boleh stack). Baris 102 verbatim: 'Jika memperbarui: HAPUS yang lama, TAMBAH yang baru. Tidak boleh ada dua entri dengan kunci sama.'
9. **chatCompletionOnce → stripCodeFences → JSON.parse** — (274-280, 281-284, 286-303). Non-streaming, temp 0.2. Error → null. `stripCodeFences` (255-264) strip ```json/``` fence. `JSON.parse(cleaned)`; fail → null (300-303). ⚠️ **callExtractor TIDAK apply mergeRelationshipFacts atau dedup apapun** — return raw array yang LLM produksi. LLM di-trust honor 'no duplicate tagged key'. Jika LLM return keduanya `[STATUS]: pacaran` dan `[STATUS]: teman`, callExtractor pass keduanya unchecked (trace MEM-003). ⚠️ Tak ada timeout (TEMUAN-018).
10. **mergeDynamicMemory (mergeRelationshipFacts untuk relationship)** — (328, 218-228, 170-197). `dedupNarrative` (202-210) copy existing, push incoming jika no case-insensitive equal. `mergeRelationshipFacts` (170-197) — **KRUX BUG-04**: bangun `tagged` Map + `narrative` array. Existing (174-182): jika `TAGGED_KEY_PATTERN.test(f)` (`/^\[[A-Z_]+\]:/`, baris 7) ekstrak key via `TAGGED_KEY_EXTRACT` (`/^\[([A-Z_]+)\]/`, 8) → `tagged.set(key,f)`; else if non-empty → narrative. Incoming (184-194): sama, `tagged.set(key,f)` latest-wins (188), narrative case-insensitive dedup (190-193). Return `[...tagged.values(), ...narrative]` (196).
11. **BUG-04 EXACT failure case — double entry [KEY]: value** — Partisi tagged/narrative di `mergeRelationshipFacts` (170-197) diputus **SATU-SATUNYA** oleh `TAGGED_KEY_PATTERN = /^\[[A-Z_]+\]:/` (7) yang mensyaratkan literal bracket prefix `[KEY]:`. Fact relationship yang LLM (atau legacy normalizer) emit **TANPA bracket** — mis. `USER_PANGGILAN: kaishi` (baris 58 legacy path produksi persis ini via `${k}: ${v}`) — TIDAK match `TAGGED_KEY_PATTERN`, jadi 176/186 false dan jatuh ke narrative branch (179-181 / 189-193). Sementara jika fact SAMA juga ada DENGAN bracket sebagai `[USER_PANGGILAN]: kaishi` (dari extraction run beda atau LLM mix format), copy itu masuk `tagged` Map. Narrative dedup (191) compare `USER_PANGGILAN: kaishi`.toLowerCase() terhadap entry narrative lain — **tidak compare terhadap nilai tagged Map**. Hasil: keduanya `[USER_PANGGILAN]: kaishi` (di tagged.values()) dan `USER_PANGGILAN: kaishi` (di narrative) survive ke array final (196), produksi double+ entry yang user report. Split-brain sama terjadi saat LLM emit tagged key dengan casing bracket inkonsisten (mis. `[ USER_PANGGILAN]:` gagal anchor `^`, `[user_panggilan]:` gagal `[A-Z_]+`). **Karena tidak ada langkah normalisasi yang kanonikalisasi `USER_PANGGILAN: x` ↔ `[USER_PANGGILAN]: x` sebelum split, dua format di-treat sebagai fact berbeda.**
12. **capMemory** — (329, 235-253). Flatten semua fact ke `[{cat,f}]` (236-239). Jika `flat.length <= 60` (4) return unchanged (240). Else sort (243-247) by tagged-status only: relationship+`TAGGED_KEY_PATTERN.test` → 0 (keep), else → 1 (trim). `flat.slice(-60)` (249) keep **60 TERAKHIR** — jadi tagged fact (sorted ke front, indeks 0) di-drop PERTAMA oleh `slice(-60)` jika ada >60 tagged (mustahil praktis, hanya 5 key). Rebuild out (250-252). ⚠️ Intent "keep tagged last, never trim" tapi kode lakukan kebalikan — TEMUAN-004.
13. **Persist UPDATE stories.dynamic_memory** — (333-340). `changed = JSON.stringify(capped) !== JSON.stringify(existingMemory) || totalAfter !== totalBefore` (335-337). If changed: `updateMemoryStmt.run(JSON.stringify(capped), story.id)` (340). ⚠️ changed-check pakai existingMemory snapshot (normalized 318 dari request-entry story) — jika extraction konkuren di story sama sudah tulis memory lebih baru, write ini bisa CLOBBER (TEMUAN-006, trace MEM-004).
14. **callMemoryAuditor (≥50 fact)** — (341, 393-439). Fire-and-forget. Re-read dynamic_memory dari DB (395, `getDynamicMemoryStmt`) — lihat capped memory yang baru ditulis, bukan snapshot stale. If `total < 50` return 0 (398). `chatCompletionOnce` AUDITOR_SYSTEM_PROMPT (354-385) minta LLM deteksi obsolete/conflicting/redundant, return per-category drop list. Parse, bangun dropSet (lowercased trimmed), keep fact NOT in dropSet (422-423). If removed>0 write next (430-433). ⚠️ dropSet match (422-423) exact-string equality — TIDAK catch BUG-04 bracket-vs-no-bracket karena `[USER_PANGGILAN]: kaishi` !== `user_panggilan: kaishi` setelah lowercase. **Auditor tak bisa heal BUG-04.**
15. **summarizeFacts (>50 fact)** — (342, 471-513). Fire-and-forget, **CONCURRENT** dengan auditor (spawn 341-342 tanpa await). Re-read DB (473). If `total <= 50` return (476). `chatCompletionOnce` SUMMARIZER_SYSTEM_PROMPT (443-464) yang di-told preserve tagged. Bangun next via `{...memory, ...parsed}` — ⚠️ `parsed.relationship` REPLACE `memory.relationship` entirely (493); narrative relationship fact dari memory yang summarizer omit **permanently hilang** (TEMUAN-020). Re-inject existingTagged (494) + dedup tagged key via `seenTaggedKeys` Set (497-504) — ini collapse duplikat bracketed key (latest wins by filter order). Write next (506). ⚠️ RACE: write 506 bisa interleave dengan write auditor 431 (trace MEM-005) — dua fire-and-forget row sama tanpa koordinasi; last-writer-wins discard kerja yang lain.
16. **Request berikut baca dynamic_memory update ke prompt** — Memory yang diproduksi langkah 6-15 hanya affect request BERIKUTNYA. Pada POST `/messages` berikut, `requireStory` reload story row termasuk `dynamic_memory` yang sekarang update, `buildContextPayload` re-render system prompt, `buildCurrentContextBlock` re-derive KONTEKS SAAT INI. Implikasi BUG-05: jika tagged fact tak pernah ditulis (extractor return null langkah 9, atau LLM omit bracket sehingga parseRelationshipState tak nemu `[KEY]:` prefix), blok KONTEKS stay empty dan AI tak pernah terima instruksi current-state eksplisit — hanya lihat relationship sebagai flat bullet di DYNAMIC FACTS (langkah 4) — gejala 'AI inconsistently uses relationship context'.

### Alur TTS (end-to-end)

1. **User klik `.tts-play-btn`** — `story.page.js` click delegation (537-551); handler `_onTtsPlayOrToggleClick` (429). **TIDAK ADA auto-play** pada AI message baru — SSE `done` handler (1756-1770) hanya render finalContent + set bubble id; tak call fungsi TTS apapun. TTS strictly click-driven. ⚠️ PERLU KLARIFIKASI: BUG-03 target 'audio mulai ≤2s setelah AI selesai render' imply expectation auto-play, tapi tak ada path auto-play. Apakah user klik play manual (BUG-03 = click→audio latency), atau expect auto-narration on done (feature missing)?
2. **Resolve text + voice; set 'loading'** — `story.page.js` (493-512). text dari `data-text` attr (decodeURIComponent) fallback `.msg-content` textContent (494-500). `voice = resolveTtsVoice(story)` (510, def 240-244): `story.tts_voice` jika di `VALID_TTS_VOICES` allowlist else `DEFAULT_TTS_VOICE` id-ID-ArdiNeural. `_setTtsBtnState(group,'loading')` (512). Sync ~0ms.
3. **AWAIT #1: `apiClient.synthesizeTts({text, voice})` — await user-facing terbesar** — `story.page.js:514`. TANPA AbortSignal, TANPA client timeout (apiClient.synthesizeTts 276-294 ignore signal). Await block 'loading' spinner sampai chain network+synthesis return. Estimasi: cache hit ~50-150ms; cold miss 1.5-8s (sub-step bawah); pathological 8-35s jika backend retry/hang (TEMUAN-028, trace TTS-005).
4. **SW intercept POST /api/tts** — `sw.js` fetch listener (81-95) route ke `handleTtsPost` (92-94). `handleTtsPost` (142): `await req.clone().json()` (~1ms), `sha256Hex(text)` via crypto.subtle (~1-3ms), `await cache.match(\`tts:${voice}:${sha256(text)}\`)` (160, ~2-5ms). Cache key = voice + sha256(text). Hit → return cached Response X-Tts-Cache:hit (161-169). Miss → `await fetch(req)` network (174).
5. **Route POST /api/tts** — `tts.routes.js` (47-79). Validate text non-empty (49-52), ≤5000 char (53-55), `resolveVoice` (57), `validateVoiceOrThrow` allowlist 4-voice (58). `t0=Date.now()` (60).
6. **AWAIT #2: `synthesizeText(text, voice)` — backend cache lookup lalu synthesis** — `edgeTts.service.js:61`. `synthesizeText` (322-352): `cacheKey = sha1(text|voice|+0%|+0%|+0Hz)` (332, def 37-49). `cacheGet` (333) — LRU touch via delete+re-set (51-58). If cached & `isLikelyValidMp3` (338) → return <50ms (X-Tts-Cache:hit). Else `cacheEvict` (340) + `await runWithRetry` (345).
7. **AWAIT #3: `runWithRetry` — 4 attempt (1+3 retry)** — (174-203). `maxAttempts=4` (176). Per attempt: `await runSynthesize` (179). Validate `isLikelyValidMp3(buf)` (180) — `MIN_VALID_MP3_SIZE=2048` (82) + ID3/MPEG-sync magic (359-372). Corrupt/empty → lastErr, retry. Throw → classify, retry. Antar attempt: `await setTimeout(retryBackoff(attempt))` (199). `retryBackoff` (168-172) = `400*2^attempt + 0-200ms` jitter. Cumulative worst: (400-600)+(800-1000)+(1600-1800) ≈ 3.4s. Per-attempt ceiling 8s (langkah 10). Worst total ≈ 4×8 + 3.4 ≈ 35s (trace TTS-011).
8. **AWAIT #4: `semaphoreAcquire` — gate global MAX_CONCURRENT=3** — `runSynthesize` (224-233): `await semaphoreAcquire()` (227). Semaphore (140-161): counting, max 3 concurrent WebSocket ke Microsoft. Jika 3 in flight, queue di `semaphoreWaiters` (150) sampai release. Wait = 0ms jika slot bebas; bisa detik saat page-load warmup()+background warmup+prewarm semua kompetisi. `finally` release (231).
9. **AWAIT #5 (KONTRIBUTOR TERBESAR): `_doSynthesize` — Edge TTS WebSocket cold-start** — (235-285). `new Communicate(text,{voice, rate, volume, pitch, connectionTimeout:10000})` (250). `streamPromise` (259-270): async-iterate `comm.stream()` over WebSocket ke Microsoft Edge TTS endpoint, collect audio chunk, `Buffer.concat`. Cold start = WebSocket open + Sec-MS-GEC token auth + DNS + chunk assembly = **1-4s first hit**; warm <500ms. `hardTimeout = 8s` reject (275-277). `await Promise.race([streamPromise, ttsError, hardTimeout])` (279). **INILAH kontributor tunggal terbesar BUG-03 >2s latency pada AI message baru**: first-ever synthesis text itu = cold WebSocket call. ⚠️ Timer hardTimeout tak di-clear saat streamPromise menang (TEMUAN-023).
10. **Buffer return; backend cache + respond** — `synthesizeText cachePut` (347) — in-process Map, MAX_CACHE_SIZE=128 (34-67, LRU yang benar per refutation C-010). `tts.routes` (64-73): set Content-Type audio/mpeg, Content-Length, Cache-Control public max-age=3600, X-Tts-Voice, X-Tts-Elapsed-Ms, X-Tts-Cache hit/miss. `res.end(buffer)` (73). ⚠️ Buffer corrupt/too-small tetap dikirim 200 tanpa cek (TEMUAN-050).
11. **AWAIT #6: SW cache network response + return** — `handleTtsPost` miss path (173-195). `await networkResponse.arrayBuffer()` (178) — body transfer ~10-100ms. `await cache.put(key, cacheableResponse.clone())` (188). Return `new Response(body,...)` (190). ⚠️ SW TTS_CACHE ('fictionflow-tts-v3') tak pernah di-evict — no LRU, no max size (trace TTS-009).
12. **AWAIT #7: `res.blob()` di apiClient** — (293) — Blob construction ~10-50ms. No signal/timeout pada whole fetch (277-282).
13. **`_playBlobAsAudio(blob, group, msgId)` — Blob URL + assign shared Audio** — `story.page.js` (394-427). Pause + revoke previous `_ttsAudio.src` blob URL (396-399). Revoke stale cached url same msgId (404-406). `URL.createObjectURL(blob)` (407). `_ttsCache.set(msgId,{blob,url})` + `_evictOldTtsCacheEntries` (409-410, limit 16, 294). `_ttsAudio.src=url` (412). `_activeTtsBtn=group` (413). onended→`_resetAllTtsBtns` (415-417). onerror→`showTransientError`+reset (418-421). `_setTtsBtnState 'playing'` (422).
14. **AWAIT #8: `_ttsAudio.play()` — MP3 decode + audio output start** — (423). Decode + audio-context warm: first play ~100-400ms, berikut ~50ms. Catch (423-426) show toast 'Audio gagal dimuat' pada rejection — ⚠️ juga fire pada user-abort race, false positive (trace TTS-013). onended reset button; single bubble, **TIDAK ADA queue advance** (ttsQueueManager queue/prefetch unused — TEMUAN-057).
15. **WARMUP PATH W1-W3: loadStoryAndMessages BLOCKING sync warmup voice terpilih** — (1358-1378). loadingChat spinner 'Menyiapkan suara: id-ID' (1360-1367). `await apiClient.warmupTts({voice:settledVoice, wait:true})` (1370) — **BLOCKS sebelum render pesan** (renderMessages 1404). `apiClient.warmupTts` (304-313) fetch POST `/api/tts/warmup?wait=true`. `tts.routes /warmup` (91-139): `await Promise.race([warmupVoice(voice), 25s-timeout])` (105-111). ⚠️ Blocking 25s delay render (TEMUAN-013).
16. **WARMUP PATH W4: `warmupVoice` synthesize FIXED dummy string — cache key tak pernah match real message** — `warmupVoice` (413-415) → `warmupText('Halo, saya siap membantu Anda.', voice)` (385-390) → `synthesizeText(dummyText, voice)`. `cacheKey = sha1(dummyText|voice|+0%×3)`. Real playback `cacheKey = sha1(realMessageText|voice|+0%×3)`. Text beda → key beda → **warmup cache entry TIDAK PERNAH hit oleh real play** (trace TTS-001/006). `warmup()` (392-410) warm 4 voice dengan dummy string sama. ⚠️ `warmupPromise` resolve ke undefined → re-warm setiap load (TEMUAN-049).
17. **WARMUP PATH W5-W6: background warm 3 voice lain + prewarm 3 assistant message terbaru** — background warm (1380-1386): setTimeout fire-and-forget `warmupTts` per voice lain (500ms×(i+1) stagger). `prewarmLatestAssistantTts` (190-204) dipanggil via rAF (1407-1409) SETELAH first paint. Sequential `await apiClient.synthesizeTts` untuk 3 assistant message terbaru (197-203), warm REAL message text di backend+SW cache. Ini bantu replay history tapi **TIDAK cover** AI message baru yang di-generate sesi ini (handler `done` tak ada prewarm — TEMUAN-012). Sequential await share semaphore MAX_CONCURRENT=3 dengan dummy warmup → real-message prewarm bisa queue di belakang dummy warmup yang useless (trace TTS-008).
18. **SW BOOT PROBE P1-P3: probeServiceWorker fire BUG-01 toast setiap refresh** — (1258-1261): `void probeServiceWorker(currentSwV).catch(()=> showTransientError('Cache audio tidak aktif — pemutaran pertama mungkin lebih lambat.'))`. `probeServiceWorker` (138-161): getRegistration, `hasV = scriptURL.includes('?v=38')` (146). `story.html:296` register `/sw.js` TANPA ?v query → active SW scriptURL = `https://host/sw.js` → **hasV ALWAYS false**. `reg.active` exists → `postMessage SKIP_WAITING` (151) → wait 1s controllerchange (152-159). Steady state (no waiting SW), controllerchange tak fire → reject('timeout') → catch → TOAST. BUG-01 root (TEMUAN-011).

**Issue sepanjang trace (dirangkum):**
- TTS-001/006: warmup dummy string tak pernah match real text cache key.
- TTS-002: blocking warmup 25s delay render (TEMUAN-013).
- TTS-003: probe SW rusak → toast setiap refresh (TEMUAN-011).
- TTS-004: ttsQueueManager dead code (TEMUAN-057).
- TTS-005: real synthesizeTts fetch tanpa timeout (TEMUAN-028).
- TTS-007: no prewarm saat AI message baru selesai (TEMUAN-012).
- TTS-008: semaphore contention dummy warmup block real prewarm.
- TTS-009: SW TTS CacheStorage unbounded no eviction.
- TTS-011: runWithRetry worst-case ~35s.
- TTS-013: play() catch over-fire pada abort race.

---

## MASALAH KRITIS DI SISTEM MEMORY (BAGIAN KHUSUS)

Sistem memory adalah kluster cacat terbesar di FictionFlow. BUG-04 dan BUG-05 — dua bug user terberat — berbagi **satu akar struktural yang sama** dan dapat diselesaikan dengan satu perbaikan terpusat. Berikut analisis mendalam per komponen.

### (a) memoryExtractor.service.js — apa yang salah dari prompt dan parsing

**Prompt ekstraksi (verbatim, baris 79-160):** prompt sudah cukup baik secara desain. Ia menjelaskan dua jenis fact relationship, memberi contoh KONTEKS_PERILAKU per skenario, dan eksplisit instruksikan replace-don't-duplicate (baris 102 verbatim: `'Jika memperbarui: HAPUS yang lama, TAMBAH yang baru. Tidak boleh ada dua entri dengan kunci sama.'`). Tiga kelemahan:

1. **Compliance sepenuhnya LLM-dependent, safety-net dedup fragile.** Prompt minta LLM emit `[KUNCI]: nilai` tapi tak ada penegakan. Safety-net `mergeRelationshipFacts` re-dedup by key — TAPI keyed oleh regex exact-bracket (`TAGGED_KEY_PATTERN = /^\[[A-Z_]+\]:/`, baris 7) yang LLM sering langgar. Setiap drift format (tanpa bracket, lowercase, spasi sebelum colon) lolos safety-net.
2. **Mismatch semantik prompt vs kode.** Prompt minta LLM return JSON dengan **4 kunci berisi array** — ambigu apakah LLM harus return FULL updated memory atau hanya DELTA. Kode `mergeDynamicMemory` **union** (merge) incoming ke existing. Jika LLM return full set, union re-add fact unchanged (rely exact-equality dedup catch); jika return hanya delta, union preserve rest. Kedua path terjadi tergantung behavior model → fact set inkonsisten.
3. **Parsing fail silent tanpa salvage.** `stripCodeFences` hanya strip ``` fence. Jika LLM prefix JSON dengan prose ('Berikut: {...}'), `JSON.parse` throw, catch log + return null, whole extraction skip (TEMUAN-043). `chatCompletionOnce` tanpa timeout → hung extractor tak pernah resolve (TEMUAN-018). Input hard-truncate 2000 char → miss status change akhir reply panjang (TEMUAN-042). Tidak ada retry/backoff (TEMUAN-047).

**Kondisi ideal prompt+parsing:**
- Ekstraksi minta LLM return **delta** (hanya fact baru/berubah), bukan full set, untuk eliminasi ambiguity union-vs-replace.
- Setiap fact incoming di-**kanonikalisasi** ke bentuk `[KEY]: value` (untuk known tagged key) sebelum merge — toleran terhadap bracket/case/spacing.
- Parsing punya fallback balanced-brace extraction saat `JSON.parse` fail (seperti `tryParseStoryJson` di controller).
- `chatCompletionOnce` punya timeout + AbortSignal; extractor punya bounded retry dengan backoff.

### (b) memoryManager.service.js — di mana tepatnya dedup gagal dan mengapa double entry bisa terjadi

**Algoritma merge/dedup saat ini (detail):** `mergeDynamicMemory` (218-228) normalize kedua sisi via `normalizeDynamicMemory`, lalu: user/ai/world pakai `dedupNarrative` (202-210) — case-insensitive exact-equality union (existing keep order, incoming append jika no lowercase match); relationship pakai `mergeRelationshipFacts` (170-197) — split existing ke `tagged` Map (keyed by bracket-extracted key) + `narrative` array, proses incoming sama: tagged → `tagged.set(key, f)` (latest wins), narrative → case-insensitive equality dedup. Return `[...tagged.values(), ...narrative]`.

**Titik kegagalan tepat (3 concrete, semua share akar "tak ada normalisasi sebelum split"):**

1. **Regex fragility (TEMUAN-001/005):** `TAGGED_KEY_PATTERN = /^\[[A-Z_]+\]:/` mensyaratkan `[UPPER]` langsung diikuti `:` tanpa spasi, uppercase only. LLM emit `[USER_PANGGILAN] : kaishi`, `[User_Panggilan]: kaishi`, atau `USER_PANGGILAN: kaishi` → gagal regex → classified narrative → ditambah BERSAMA existing bracketed `[USER_PANGGILAN]: kaishi` (di tagged Map). Narrative dedup (190-192) hanya bandingkan terhadap entry narrative lain, **tidak pernah** terhadap nilai tagged Map. **Dua entry untuk key sama survive.**
2. **Legacy migration (TEMUAN-021):** `normalizeDynamicMemory` legacy branch (56-58) emit `${k}: ${v}` **tanpa bracket** — `USER_PANGGILAN: kaishi`. Tak pernah match tagged regex → masuk narrative. Saat extractor baru tambah `[USER_PANGGILAN]: kaishi`, kedua persist sebagai string distinct.
3. **Concurrent writers (TEMUAN-006):** dua extraction overlap masing-masing baca snapshot stale dan overwrite; auditor/summarizer juga write konkuren (341-342) tanpa locking. Tagged fact yang ditulis satu bisa di-duplikat atau regress oleh yang lain. Tambahan: summarizer spread-replace + drifted-tag handling (TEMUAN-020) jadi path keempat.

**Verbatim code snippet penyebab (baris 6-8):**
```js
const TAGGED_KEY_PATTERN = /^\[[A-Z_]+\]:/;
const TAGGED_KEY_EXTRACT = /^\[([A-Z_]+)\]/;
```
dan legacy emit (baris 58):
```js
out[cat].push(k ? `${k}: ${v}` : v);
```

**Race condition baca-tulis `dynamic_memory` concurrent:** Ya (TEMUAN-006). `extractAndMergeFacts` baca `story.dynamic_memory` (snapshot dari `getStoryStmt.get` saat request), await extractor LLM lambat, lalu `updateMemoryStmt.run`. Dua turn konkuren, atau turn overlap auditor/summarizer, berdua baca base sama dan last-write-wins. Tidak ada transaction, compare-and-set, atau per-story mutex. Auditor (395) dan summarizer (473) re-read dari DB tapi spawn bersamaan tanpa koordinasi → yang selesai terakhir overwrite kerja yang lain (trace MEM-005).

**Snapshot rollback disimpan sebelum update? Di mana?** **Tidak** ada snapshot server-side (TEMUAN-019). `extractAndMergeFacts` tulis langsung (340) tanpa persist pre-update value. Rollback route (messages.routes:154-197) restore `dynamic_memory` hanya dari `memory_snapshot` string yang frontend kirim di request body. Jika frontend omit, memory tak bisa restore. Tambahan: frontend snapshot dari `currentStory.dynamic_memory` yang **tak pernah refresh** setelah load (TEMUAN-030) → snapshot stale.

**Batasan 60 fact — fact mana di-evict saat penuh?** `capMemory` (235-253) flatten semua kategori, sort tagged-relationship ke front (comparator 0) dan lainnya ke back (1), lalu ambil `flat.slice(-60)` = **60 TERAKHIR**. Ini **evict front (tagged) PERTAMA** saat total > 60 — kebalikan comment doc "Keep tagged relationship state last... never trim unless absolutely necessary" (TEMUAN-004). Konkret: 5 tagged + 65 narrative → `slice(-60)` drop indeks 0-9 = **semua 5 tagged + 5 narrative**. Summarizer (>50) dan auditor (≥50) biasanya jalan sebelum cap menggigit, tapi burst >60 langsung buang tagged state duluan → AI kehilangan relationship state → BUG-05.

### (c) promptBuilder.service.js — apa yang kurang dari cara memory disajikan ke AI

**Struktur prompt (verbatim section headers, renderSystemPrompt baris 210-322):**
1. `# Role & Objective`
2. `# Batasan Konten`
3. `# Output Format Specification`
4. `# Strict Logic & Voice Rules (Edge TTS V2)`
5. `=== STORY IDENTITY (DO NOT CHANGE) ===`
6. `## KONTEKS SAAT INI [BACA INI SEBELUM MEMBALAS]` (dari `buildCurrentContextBlock`, **empty saat tak ada tagged state**)
7. `=== DYNAMIC FACTS (auto-updated) ===`
8. `=== OUTPUT RULES ===`

(Casual prompt mirror dengan framing casual, 10 section.)

**Bagian yang inject CURRENT STATE eksplisit:** Ya, **conditional**. `buildCurrentContextBlock` (105-140) emit STATUS (dengan SEJAK), AI_PANGGILAN, USER_PANGGILAN, KONTEKS_PERILAKU sebagai dedicated block dengan direktif `Perilakumu HARUS mencerminkan konteks ini setiap saat` (136). TAPI return `''` (empty) kecuali minimal satu dari STATUS/AI_PANGGILAN/KONTEKS_PERILAKU/USER_PANGGILAN ada (110-112). Saat empty, AI tak dapat explicit current-state section, hanya lihat relationship info sebagai baris unemphasized di flat DYNAMIC FACTS list (TEMUAN-002/007).

**dynamic_memory fact disajikan flat atau terstruktur?** Structured-by-category tapi flat within category. `renderDynamicFacts` (158-178) emit `[Tentang User]`/`[Tentang AI]`/`[Tentang Dunia Cerita]`/`[Tentang Hubungan]` header, lalu `- <fact>` line. Tagged fact seperti `[STATUS]: pacaran` muncul sebagai bullet biasa under "Tentang Hubungan" tanpa marking atau prioritas khusus.

**Instruksi cara memanggil user berdasarkan memory?** Hanya di dalam `buildCurrentContextBlock` saat AI_PANGGILAN set: baris 122 `Cara kamu memanggil user sekarang: "..." — gunakan ini secara konsisten` dan USER_PANGGILAN baris 126 `ini sudah normal, jangan bereaksi aneh atau kaget`. Instruksi ini **hilang** saat block empty. DYNAMIC FACTS section sendiri tak punya instruksi padanan.

**Truncation saat prompt mendekati token limit?** Tidak. `renderDynamicFacts` dump semua fact unbounded. `estimateTokens` (memoryManager 59-62) ada tapi tak pernah dipakai budget prompt. Satu-satunya size guard = `assertBodyFits` di modelProvider (200KB serialized body) yang throw dan abort request — tidak ada graceful truncation (TEMUAN-063, LOW karena count di-cap 60 jadi worst-case ~18KB masih di bawah 200KB).

**Short-term window diambil query benar dan urutan tepat?** Query **mostly correct** tapi ORDER BY incomplete. `getRecentStmt` (4-10) pakai `ORDER BY created_at DESC LIMIT ?` lalu `.reverse()`. Tak ada `id DESC` tiebreaker → pesan share 1-second `created_at` (umum user+assistant pair cepat, CURRENT_TIMESTAMP second-resolution) return arbitrary order — nondeterministic dan inkonsisten dengan list endpoint `created_at DESC, id DESC` (TEMUAN-017). Tambahan: user row di-insert sebelum `streamChat`, fetched window sudah include latest user message, yang lalu di-append lagi → duplikat turn user (TEMUAN-003).

**Kondisi ideal prompt surfacing:**
1. `parseRelationshipState` dan `parseDynamicMemory` share **satu** helper normalisasi yang sama dengan extractor merge — sehingga fakta tersimpan kanonik dan read-side parser konsisten.
2. `buildCurrentContextBlock` **selalu** emit current-state section (meski sebagian field kosong), dengan direktif bahwa baris `[KEY]: value` di Tentang Hubungan adalah state binding yang harus dipatuhi + panggil user pakai AI_PANGGILAN. Dekouple direktif dari keberadaan satu tagged field.
3. Tagged state di surface **sekali** sebagai instruksi terstruktur (KONTEKS), **tidak** di-dump lagi sebagai bullet raw di DYNAMIC FACTS (hindari duplikasi + noise).
4. Prompt punya token budget: keep tagged state always, fill narrative most-recent/important sampai budget, drop oldest narrative duluan.
5. Short-term window query pakai `id DESC` tiebreaker deterministik dan tak duplikat user message baru.

**Inti:** BUG-04 (duplikat) dan BUG-05 (state tak di-surface) berdua berakar pada **konvensi bracket `[KEY]: value` yang regex-exact di 3 tempat terpisah tanpa normalisasi**. Fix terpusat = satu helper normalisasi kanonik + satu sumber kebenaran tagged-key, dipakai extractor merge, legacy migration, DAN prompt parser. Setelah fakta disimpan kanonik, dedup collapse otomatis dan KONTEKS SAAT INI selalu ter-surface.

---

## RENCANA EKSEKUSI UNTUK DEEPSEEK V4 PRO

Task diurutkan dari paling prioritas. Task memory (A) dikerjakan duluan karena fix terpusat menyelesaikan BUG-04+BUG-05 sekaligus dan jadi prerequisite banyak task lain. Setiap task: prioritas, file, dependensi, deskripsi perubahan spesifik, kriteria selesai, risiko.

### TASK-001: Extract shared dynamic-memory parser + tagged-key constant (PREREQUISITE)
- **Prioritas:** 1
- **File yang perlu diubah:** `backend/src/services/memoryExtractor.service.js`, `backend/src/services/promptBuilder.service.js`, (baru) `backend/src/util/dynamicMemory.js`
- **Bergantung pada:** —
- **Deskripsi perubahan:** Buat modul baru `backend/src/util/dynamicMemory.js` yang berisi: (1) konstanta `TAGGED_KEYS = ['STATUS','AI_PANGGILAN','USER_PANGGILAN','SEJAK','KONTEKS_PERILAKU']` (sumber tunggal, hapus `TAGGED_KEYS` di extractor:6 dan `REL_TAGGED_KEYS` di promptBuilder:78); (2) fungsi `normalizeDynamicMemory(raw)` yang merupakan gabungan logic `normalizeDynamicMemory` (extractor 21-64) dan `parseDynamicMemory` (promptBuilder 41-76) — handle legacy array `{category,key,value}` dan new object `{user,ai,world,relationship}`, dengan legacy branch emit bentuk **canonical bracketed `[KEY]: value`** untuk key yang (uppercased) ada di `TAGGED_KEYS` (fix TEMUAN-021); (3) fungsi `canonicalizeRelationshipFact(fact)` — deteksi known TAGGED_KEYS terlepas dari bracket/case/spacing via regex toleran `/^\s*\[?\s*(KEY)\s*\]?\s*[:\-]\s*(.*)$/i` (KEY di-match case-insensitive terhadap TAGGED_KEYS set), rewrite ke `[KEY]: value` kanonik; return fact as-is jika bukan tagged. Import `normalizeDynamicMemory` + `canonicalizeRelationshipFact` + `TAGGED_KEYS` di kedua service. Hapus `parseDynamicMemory` di promptBuilder dan `normalizeDynamicMemory` di extractor, ganti panggilan ke shared module.
- **Kriteria selesai:** (a) `grep -r "parseDynamicMemory\|TAGGED_KEYS\|REL_TAGGED_KEYS" backend/src` hanya hit di `util/dynamicMemory.js` + import site; (b) unit test: legacy `[{category:'relationship',key:'USER_PANGGILAN',value:'kaishi'}]` normalize → `['[USER_PANGGILAN]: kaishi']`; (c) `canonicalizeRelationshipFact('USER_PANGGILAN: kaishi')` === `'[USER_PANGGILAN]: kaishi'`; `canonicalizeRelationshipFact('[user_panggilan] : kaishi')` === `'[USER_PANGGILAN]: kaishi'`; `canonicalizeRelationshipFact('AI cemburu')` === `'AI cemburu'` (narrative untouched).
- **Risiko:** Mengubah signature import bisa break caller lain — grep dulu semua pemakai `normalizeDynamicMemory`/`parseDynamicMemory`. Test memoryExtractor.service.test.js yang ada mungkin assert behavior lama — update test.

### TASK-002: Tolerant tagged-fact dedup di mergeRelationshipFacts (fix BUG-04)
- **Prioritas:** 2
- **File yang perlu diubah:** `backend/src/services/memoryExtractor.service.js`
- **Bergantung pada:** TASK-001
- **Deskripsi perubahan:** Di `mergeRelationshipFacts` (170-197), sebelum partisi tagged/narrative, jalankan `canonicalizeRelationshipFact` (dari TASK-001) atas **setiap** fact existing (174-182) dan incoming (184-194). Hapus dependensi pada `TAGGED_KEY_PATTERN`/`TAGGED_KEY_EXTRACT` lokal (7-8) — ganti deteksi tagged dengan cek apakah hasil kanonikalisasi punya prefix `[KEY]:` untuk KEY di TAGGED_KEYS, atau pakai helper `isTaggedFact(f)` dari shared module. Ekstrak key via helper canonical. Tambah **self-dedup array existing** saat load (saat ini existing push verbatim 174-182, duplikat existing survive). Setelah canonical, Map keyed dedup otomatis collapse `USER_PANGGILAN: kaishi` dan `[USER_PANGGILAN]: kaishi` ke satu key. Apply juga kanonikalisasi di `callExtractor` parse loop (290-299) sebelum return, sehingga incoming dari LLM langsung kanonik.
- **Kriteria selesai:** (a) Unit test: existing `['USER_PANGGILAN: kaishi']` + incoming `['[USER_PANGGILAN]: kaishi']` → merge result relationship = `['[USER_PANGGILAN]: kaishi']` (satu entry, bukan dua); (b) existing `['[STATUS]: teman']` + incoming `['[STATUS]: pacaran']` → `['[STATUS]: pacaran']` (latest wins); (c) existing `['[user_panggilan]: x']` + incoming `['USER_PANGGILAN: y']` → `['[USER_PANGGILAN]: y']`; (d) narrative fact `['AI cemburu']` + `['ai cemburu']` → satu entry (case-insensitive dedup existing).
- **Risiko:** Kanonikalisasi mengubah string stored — existing DB row dengan format non-kanonik akan di-rewrite pada extraction berikutnya (acceptable, itu yang diinginkan). Pastikan `changed`-check (333-337) tetap benar setelah canonical (mungkin trigger extra write sekali untuk cleanup — OK).

### TASK-003: Tolerant parseRelationshipState + always-emit KONTEKS SAAT INI (fix BUG-05)
- **Prioritas:** 3
- **File yang perlu diubah:** `backend/src/services/promptBuilder.service.js`
- **Bergantung pada:** TASK-001
- **Deskripsi perubahan:** `parseRelationshipState` (85-97): ganti `fact.startsWith(\`[${key}]:\`)` dengan kanonikalisasi fact via `canonicalizeRelationshipFact` lalu cek prefix — sehingga fact tanpa bracket juga terbaca sebagai state. `buildCurrentContextBlock` (105-140): **hapus gate empty-return** di 110-112; **selalu** emit block `## KONTEKS SAAT INI [BACA INI SEBELUM MEMBALAS]`. Jika tidak ada tagged state sama sekali, emit block dengan fallback direktif: "Belum ada state hubungan yang tercatat. Jika user menunjukkan kedekatan/affection, jangan bertindak seolah itu hal baru — cek fakta di DYNAMIC FACTS untuk konteks hubungan." Saat tagged state ada, emit seperti sekarang (STATUS/SEJAK, AI_PANGGILAN dengan "gunakan konsisten", USER_PANGGILAN dengan "jangan bereaksi aneh", KONTEKS_PERILAKU sebagai panduan perilaku). Tambahan: di `renderDynamicFacts` (158-178), **skip** tagged fact dari list bullet relationship (sudah di-surface di KONTEKS SAAT INI) untuk hindari duplikasi + noise — hanya tampilkan narrative relationship fact sebagai bullet.
- **Kriteria selesai:** (a) Manual test: story dengan `dynamic_memory` berisi `relationship: ['STATUS: pacaran', 'AI_PANGGILAN: sayang']` (tanpa bracket) → system prompt mengandung "Status hubungan dengan user: pacaran" dan "Cara kamu memanggil user sekarang: 'sayang' — gunakan ini secara konsisten" (sebelumnya block empty); (b) story dengan `relationship: []` → block KONTEKS SAAT INI tetap muncul dengan fallback direktif (sebelumnya absen); (c) tagged fact tak muncul dobel di DYNAMIC FACTS bullet; (d) AI reply tidak lagi bilang "udah berani manggil sayang ya?" pada skenario pacaran (verifikasi manual).
- **Risiko:** Prompt sedikit lebih panjang saat tagged state kosong (fallback direktif) — negligible. Pastikan `parseRelationshipState` tak break pada fact non-string/null.

### TASK-004: Fix capMemory direction — keep tagged, trim narrative (fix BUG-05 data-loss)
- **Prioritas:** 4
- **File yang perlu diubah:** `backend/src/services/memoryExtractor.service.js`
- **Bergantung pada:** TASK-001 (pakai helper tagged detection)
- **Deskripsi perubahan:** `capMemory` (235-253): ubah komparator sort sehingga tagged relationship fact di-sort ke **END** (keep), narrative ke **front** (trim). Saat ini `aIsTagged=0` (front) + `slice(-60)` (keep last) = tagged di-drop duluan. Fix: `aIsTagged = tagged ? 1 : 0` (tagged ke back), `slice(-60)` keep tagged. ATAU alternatif: `slice(0, 60)` dengan tagged sorted ke front. Tambah guard eksplisit: tagged fact **tidak pernah** di-trim bahkan jika >60 tagged (mustahil praktis dengan 5 key, tapi defensive). Verifikasi dengan test: 5 tagged + 65 narrative → 5 tagged survive + 55 narrative (drop 10 narrative oldest).
- **Kriteria selesai:** Unit test: 5 tagged `[STATUS]`..`[KONTEKS_PERILAKU]` + 65 narrative → cap result = 60 fact, **semua 5 tagged present**, 55 narrative (10 oldest dropped). Test: 60 narrative + 0 tagged → 60 narrative (no-op). Test: 5 tagged + 5 narrative → 10 (no-op, under cap).
- **Risiko:** Rendah. Logika pure. Pastikan comparator tetap stable sort (V8 stable).

### TASK-005: Serialize dynamic_memory updates per story + server-side snapshot (fix race + rollback)
- **Prioritas:** 5
- **File yang perlu diubah:** `backend/src/services/memoryExtractor.service.js`, `backend/src/routes/messages.routes.js`, (opsional) `backend/src/db/schema.sql` + `migrate.js`
- **Bergantung pada:** TASK-001, TASK-002
- **Deskripsi perubahan:** (a) Tambah in-process mutex per story di memoryExtractor: `const memoryLocks = new Map()` keyed by storyId; `extractAndMergeFacts` acquire lock sebelum read-merge-write, release di finally. (b) Re-read `dynamic_memory` fresh dari DB tepat sebelum merge (bukan pakai snapshot `story` dari request) — mirror auditor:395/summarizer:473. (c) Bungkus read-merge-write dalam `db.transaction(() => {...})` better-sqlite3 (atomic). (d) **Serialize auditor dan summarizer**: ganti `callMemoryAuditor(...); summarizeFacts(...)` (341-342 paralel) jadi `await callMemoryAuditor(story.id).catch(()=>{}); await summarizeFacts(story.id).catch(()=>{});` (sequential). (e) Server-side snapshot: sebelum `updateMemoryStmt.run` (340), simpan pre-update value ke kolom baru `memory_prev` (tambah via migration v7) ATAU side table `memory_snapshots(story_id, snapshot_json, created_at)`. (f) Rollback endpoint (messages.routes:185-199): jika `memory_snapshot` absent di body, restore dari `memory_prev` kolom/side table; **validasi** `memory_snapshot` yang dikirim frontend via `normalizeDynamicMemory` + reject 400 jika tidak valid JSON / bukan shape 4-category (fix TEMUAN-024); hanya persist bentuk normalized.
- **Kriteria selesai:** (a) Unit test: dua `extractAndMergeFacts` konkuren di story sama → tidak clobber, fakta keduanya merge (bukan last-wins); (b) auditor + summarizer sequential (grep: tak ada lagi `callMemoryAuditor(...);\n  summarizeFacts(...)` tanpa await); (c) rollback dengan `memory_snapshot: 'garbage'` → 400; (d) rollback tanpa `memory_snapshot` → restore dari `memory_prev`; (e) migration v7 idempotent.
- **Risiko:** Mutex in-process tak survive multi-process (single-process FictionFlow OK). Migration v7 tambah kolom — test pada DB fresh + DB existing. Transaction better-sqlite3 synchronous bisa block event loop sebentar (acceptable, write cepat).

### TASK-006: Exclude /api/* GET dari SW cache (fix BUG-02 utama)
- **Prioritas:** 6
- **File yang perlu diubah:** `frontend/public/sw.js`
- **Bergantung pada:** —
- **Deskripsi perubahan:** Di fetch handler (81-139), tambah early return sebelum static-asset dan app-shell branch: `if (url.pathname.startsWith('/api/')) return;` (network-only, no caching, no SWR) — kecuali `/api/tts` POST yang sudah di-handle eksplisit di 92-95 (POST, bukan GET, jadi tak terkena). Pertahankan handler TTS-POST (92-95) dan skip non-GET (98). Ini implement intent comment baris 8 yang tak pernah di-code.
- **Kriteria selesai:** (a) Manual: refresh story page setelah kirim pesan → pesan terbaru langsung muncul (sebelumnya butuh refresh kedua); (b) DevTools Application > Cache Storage: tak ada entry `/api/stories/...` atau `/api/stories/:id/messages` di CACHE_VERSION (hanya app shell + TTS cache); (c) SSE (POST) tetap tak di-cache (verifikasi: POST skip di 98).
- **Risiko:** Rendah. Network-only untuk API = behavior yang diharapkan. Pastikan `/api/health` GET juga network-only (acceptable, tak perlu cache).

### TASK-007: Fix probeServiceWorker / hilangkan BUG-01 toast
- **Prioritas:** 7
- **File yang perlu diubah:** `frontend/public/js/pages/story.page.js`, (opsional) `frontend/public/story.html`, `frontend/public/index.html`, `frontend/public/sw.js`
- **Bergantung pada:** —
- **Deskripsi perubahan:** Pendekatan termudah (recommended): **hapus probe + toast sepenuhnya**. Hapus `probeServiceWorker` (138-161), `_currentSwVersion` (169-181), dan call `void probeServiceWorker(currentSwV).catch(...)` (1258-1261). SW self-update via `CACHE_VERSION` bump + `skipWaiting` (install) + `clients.claim` (activate) sudah cukup; toast tidak memberi value (BUG-01 = false alarm). Alternatif jika probe tetap ingin dipertahankan: register SW dengan version query `/sw.js?v=38` (bump saat deploy) DAN di `probeServiceWorker`, bandingkan terhadap konstanta `self.SW_VERSION` yang SW broadcast via `postMessage` (bukan parse scriptURL). Hanya show toast saat `probeServiceWorker` resolve `'missing'`/`'unsupported'`, **swallow `'timeout'`**. Pilih pendekatan hapus (lebih clean).
- **Kriteria selesai:** (a) Manual: refresh story page 10× berturut → **tidak ada** toast 'Cache audio tidak aktif' muncul; (b) `grep "probeServiceWorker\|Cache audio tidak aktif" frontend/public/js` = 0 hit; (c) SW tetap register dan TTS cache berfungsi (verifikasi: play bubble, replay = instant dari SW).
- **Risiko:** Jika SW update tak auto-claim, user mungkin pakai SW lama sampai reload berikut — acceptable untuk single-user (CACHE_VERSION bump + reload solve). Test SW registration tetap jalan.

### TASK-008: Prewarm TTS saat AI message baru selesai + drop dummy warmup (fix BUG-03)
- **Prioritas:** 8
- **File yang perlu diubah:** `frontend/public/js/pages/story.page.js`, `backend/src/services/edgeTts.service.js`, `frontend/public/js/api/apiClient.js`
- **Bergantung pada:** — (independen dari memory task)
- **Deskripsi perubahan:** (a) Di SSE `done` handler `story.page.js` (1756-1770), setelah `sanitizeFinalContent` + `updateBubbleContent`, tambah fire-and-forget `apiClient.synthesizeTts({ text: finalContent, voice: resolveTtsVoice(currentStory) }).catch(()=>{})` supaya backend+SW cache warm sebelum user klik play (fix TEMUAN-012). Pastikan voice = `story.tts_voice` (sama dengan yang akan di-request saat play). (b) Ubah blocking warmup `await apiClient.warmupTts({voice, wait:true})` (1370) jadi **fire-and-forget** `apiClient.warmupTts({voice, wait:false}).catch(()=>{})` — pindah setelah `renderMessages` supaya tak block render (fix TEMUAN-013). (c) Backend `warmupVoice`/`warmup`: ganti dummy string `'Halo, saya siap membantu Anda.'` — karena cache content-addressed by text hash, dummy tak pernah hit real play. Opsi: drop dummy warmup entirely (frontend prewarm real message text via (a) + `prewarmLatestAssistantTts` sudah cover history), ATAU ubah warmup untuk menerima text yang akan di-warm dari frontend (frontend kirim text pesan terbaru). Recommended: drop dummy warmup, rely on real-text prewarm. (d) Fix `warmup()` success path (TEMUAN-049): set `warmupPromise` ke resolved truthy sentinel (`Promise.resolve(true)`) pada success supaya guard short-circuit; hanya reset ke null pada failure. (e) Tambah in-flight dedup di `synthesizeText` (TEMUAN-009): Map `inflight = new Map()` cache-key → `Promise<Buffer>`; pada cache miss, simpan promise, caller konkuren await promise sama, hapus entry saat settle.
- **Kriteria selesai:** (a) Manual: kirim pesan, tunggu AI selesai render, klik play → audio mulai ≤2s (target user); (b) Manual: refresh story page → pesan render langsung (tak tertahan spinner 'Menyiapkan suara'); (c) `grep "Halo, saya siap membantu Anda" backend/src` = 0 hit (dummy dihapus) ATAU warmup kini terima text param; (d) Unit test: dua `synthesizeText` konkuren text+voice sama → satu WebSocket call (bukan dua); (e) `warmup()` dipanggil 2× → hanya synthesize 4 voice sekali (guard short-circuit).
- **Risiko:** Prewarm on `done` nambah 1 Edge TTS call per AI message (acceptable, user akan play anyway). Drop dummy warmup bisa bikin first-ever page load (story baru tanpa history) sedikit lambat saat klik play pertama — mitigasi: prewarm juga first assistant message dari history saat load (sudah ada via `prewarmLatestAssistantTts`). In-flight dedup: pastikan entry dihapus di both resolve+reject (finally) untuk hindari leak.

### TASK-009: TTS play-click timeout + error surface (fix TEMUAN-028)
- **Prioritas:** 9
- **File yang perlu diubah:** `frontend/public/js/pages/story.page.js`, `frontend/public/js/api/apiClient.js`
- **Bergantung pada:** TASK-008 (kalau tidak, prewarm kurangi frekuensi miss tapi timeout tetap perlu)
- **Deskripsi perubahan:** (a) Di `_onTtsPlayOrToggleClick` cache-miss path (512-519): bikin `AbortController` per play click, pass `signal` ke `synthesizeTts`, set timeout 12s yang `controller.abort()` + `showTransientError('Audio gagal dimuat: timeout')`. Clear timeout saat fetch resolve. (b) Track controller di variable module-scope supaya `_onTtsStopClick` / `_onTtsPlayOrToggleClick` ke bubble lain bisa abort in-flight. (c) `apiClient.synthesizeTts` (276-294) sudah accept `signal` — pastikan forward ke fetch (sudah). (d) Fix false-positive toast (trace TTS-013): di `_ttsAudio.play().catch` (423-426), cek `err.name === 'AbortError'` atau flag self-induced stop, skip toast jika ya.
- **Kriteria selesai:** (a) Manual: simulasikan backend hang (kill backend saat loading) → bubble reset dari 'loading' setelah 12s + toast timeout (sebelumnya stuck forever); (b) klik stop saat loading → fetch abort, tak ada toast false-positive; (c) klik bubble lain saat loading → fetch pertama abort, bubble kedua mulai loading.
- **Risiko:** Timeout 12s mungkin terlalu pendek untuk text panjang cold-start — kalau prewarm (TASK-008) jalan, miss jarang. Tuning nilai timeout sesuai pengamatan.

### TASK-010: Stop double-inject user message + id tiebreaker short-term window (fix TEMUAN-003/017)
- **Prioritas:** 10
- **File yang perlu diubah:** `backend/src/services/memoryManager.service.js`
- **Bergantung pada:** —
- **Deskripsi perubahan:** (a) `getRecentStmt` (4-10): tambah `id DESC` tiebreaker → `ORDER BY created_at DESC, id DESC LIMIT ?` (match list endpoint). (b) `buildContextPayload` (29-53): hentikan append `latestUserMessage` di 48-50 karena user row baru sudah di-insert (routes:115) dan sudah di `getRecentStmt` result. Hapus block 47-50. Pastikan caller `streamChat` (messages.controller:237) tetap pass `userContent` untuk extractor (extractAndMergeFacts butuh userMessage) — tapi `buildContextPayload` tak perlu append ke messages array. Alternatif jika ingin tetap "emphasize last message": exclude user row terbaru dari `getRecentStmt` via `WHERE id < ?` (pass new user message id) lalu append. Pilih hapus-append (lebih simple, eliminasi duplikat).
- **Kriteria selesai:** (a) Unit test: setelah insert user message, `buildContextPayload` messages array berisi turn user tepat **sekali** di akhir; (b) Test: dua pesan di-insert dalam detik sama → `getRecentStmt` return urutan `id DESC` deterministik (bukan arbitrary); (c) Manual: AI reply tak lagi over-weight/mengulang pesan user.
- **Risiko:** ⚠️ PERLU KLARIFIKASI (lihat TASK-0010 di PERTANYAAN): apakah double-injection disengaja sebagai "last message emphasis"? Jika ya, pilih alternatif exclude+append. Hapus-append aman jika tak ada intent.

### TASK-011: Rollback otomatis saat disconnect + cleanup orphan user row (fix TEMUAN-055 + trace SSE-001/003)
- **Prioritas:** 11
- **File yang perlu diubah:** `backend/src/controllers/messages.controller.js`, `backend/src/routes/messages.routes.js`
- **Bergantung pada:** —
- **Deskripsi perubahan:** (a) Di `streamChat` `res.on('close')` handler (251-254) dan AbortError catch (273-278): jika **tidak ada** assistant message yang tersimpan (assistantMessageId null), hapus user message yang baru di-insert (`userMessageId`) secara server-side — mirror logic rollback. Tambah flag `assistantSaved = false` yang set true setelah `insertMessageStmt.run` assistant (319); di close/abort handler, jika `!assistantSaved && userMessageId`, jalankan `deleteMessageStmt.run(userMessageId, story.id)` + `deleteMessageTtsByMsgStmt.run(userMessageId)`. Ini bedakan "abort sebelum assistant save" (cleanup) dari "abort setelah assistant save" (biarkan, frontend handle). (b) Path empty-response (290-298) dan provider-error (280-288): sama, hapus user row orphan sebelum `res.end()`. (c) Pastikan tidak double-cleanup jika frontend juga call rollback Stop (idempotent delete — `deleteMessageStmt` sudah no-op jika row tak ada).
- **Kriteria selesai:** (a) Manual: kirim pesan, refresh saat AI masih streaming → setelah refresh, user message **tidak** muncul orphan (sebelumnya muncul tanpa AI reply); (b) Manual: kirim pesan, backend return empty → user message tak persist orphan; (c) Manual: klik Stop setelah AI selesai → assistant message tetap (cleanup tak jalan karena assistantSaved=true); (d) unit test: AbortError sebelum assistant insert → user row dihapus; AbortError setelah assistant insert → user+assistant row tetap.
- **Risiko:** Server-side cleanup + frontend rollback bisa race — idempotent delete aman. Pastikan `deleteMessageStmt` tak throw jika row sudah dihapus frontend. Track `assistantSaved` dengan benar di semua path (insert assistant 319 set true; path abort sebelum itu false).

### TASK-012: AbortError short-circuit di streamSingleModel (fix TEMUAN-008)
- **Prioritas:** 12
- **File yang perlu diubah:** `backend/src/services/modelProvider.service.js`
- **Bergantung pada:** —
- **Deskripsi perubahan:** Di `streamSingleModel` catch (218-226), sebelum re-wrap error, cek `if (callerSignal?.aborted) throw err;` (re-throw AbortError original, preserve name). Ini supaya `shouldTryNextModel` (81) lihat `err.name === 'AbortError'` dan return false → chain stop. Bedakan dari internal-timeout abort: internal timeout (ctl.abort dari setTimeout) tak set callerSignal.aborted, jadi tetap retryable. `callerSignal` = `init.signal` yang di-pass ke `_fetchWithFirstByteTimeout` — pastikan reference tersedia di scope catch (simpan `const callerSignal = init.signal` di awal `streamSingleModel` atau pass explicit).
- **Kriteria selesai:** (a) Manual: konfigurasi chain 2+ slot, kirim pesan, klik Stop saat streaming → backend log "abort" dan **tidak** retry slot berikut (sebelumnya retry); (b) unit test: mock fetch throw AbortError saat callerSignal.aborted → `streamChatCompletion` throw AbortError (bukan Provider error generik); (c) test: internal timeout (callerSignal not aborted) → retry next slot (behavior tetap).
- **Risiko:** Pastikan `callerSignal` reference benar — `_fetchWithFirstByteTimeout` terima `init.signal`, tapi di `streamSingleModel` yang call-nya, `signal` param adalah caller signal. Trace variable scope dengan teliti.

### TASK-013: Refresh currentStory.dynamic_memory + fix factCountBadge (fix TEMUAN-029/030)
- **Prioritas:** 13
- **File yang perlu diubah:** `frontend/public/js/pages/story.page.js`
- **Bergantung pada:** —
- **Deskripsi perubahan:** (a) Extract shared `countFacts(dynamicMemory)` function yang handle 3 shape: Array (legacy, `length`), `{facts:[...]}` (`facts.length`), `{user,ai,world,relationship}` (sum 4 array length). Pakai di initial-load (1338-1343), post-send poll (1803-1818), `openMemoryModal` (990). (b) Post-send poll (1800-1819): selain update `factCountBadge`, juga **update `currentStory.dynamic_memory`** dengan `storyData.dynamic_memory` yang baru di-fetch supaya snapshot rollback send berikut fresh (fix TEMUAN-030). (c) Setelah rollback `handleStopClick`/`onCancel` selesai, re-fetch story dan update `currentStory.dynamic_memory`.
- **Kriteria selesai:** (a) Manual: kirim pesan, tunggu AI selesai → factCountBadge tetap show count benar (sebelumnya reset '0 fakta'); (b) kirim 2 pesan, Stop pesan kedua → rollback restore memory state yang benar (state tepat sebelum send kedua, bukan sebelum send pertama); (c) `grep "Array.isArray(parsed) facts = parsed" frontend/public/js/pages/story.page.js` = 0 (logic lama dihapus).
- **Risiko:** Re-fetch setelah rollback nambah 1 GET — acceptable. Pastikan `currentStory` reference tetap konsisten (jangan reassign object baru yang break closure lain — update property saja).

### TASK-014: Sisa cleanup (LOW/INFO batch — boleh dikerjakan paralel, non-blocking)
- **Prioritas:** 14
- **File yang perlu diubah:** multiple (lihat detail)
- **Bergantung pada:** — (independen)
- **Deskripsi perubahan (batch, masing-masing small):**
  - **TEMUAN-015** server.js: tag TTS error dengan `err.isTtsTransport = true` di edgeTts.service throw site; handler cek properti itu bukan substring.
  - **TEMUAN-016** env.js: pindah `MODEL_FIRST_BYTE_TIMEOUT_MS` parsing ke env.js (clamp/fallback); ganti `process.env.NODE_ENV` di tts.routes dengan `env.NODE_ENV`.
  - **TEMUAN-018** modelProvider: tambah timeout + AbortSignal default ke `chatCompletionOnce`.
  - **TEMUAN-022** modelProvider: unify `[DONE]` dan reader-done — set flag, break, `yield {type:'done'}` sekali setelah loop.
  - **TEMUAN-023** edgeTts: retain hardTimeout timer id, `clearTimeout` di finally saat streamPromise settle.
  - **TEMUAN-026** modelProvider: forward `max_tokens` di `chatCompletionOnce` body, atau hapus dari caller.
  - **TEMUAN-034** frontend: vendor markdown-it lokal (install dependency + bundle, atau download ESM ke `/js/vendor/`), import same-origin.
  - **TEMUAN-035** story.html: hapus `maximum-scale=1.0, user-scalable=no` dari viewport meta.
  - **TEMUAN-038** schema.sql: ubah index jadi `(story_id, created_at DESC, id DESC)`.
  - **TEMUAN-040** util/text.js: restrict tag list ke model-specific (`think`,`ctrl32`), hapus tag kata Inggris generik + pass ctrl32 redundant.
  - **TEMUAN-041/044** memoryExtractor: ganti changed-check `JSON.stringify` jadi deep-equal per-category sorted array.
  - **TEMUAN-043** memoryExtractor: tambah balanced-brace fallback extraction saat `JSON.parse` fail.
  - **TEMUAN-047** memoryExtractor: tambah bounded retry+backoff untuk extractor transient failure.
  - **TEMUAN-048** edgeTts: reorder `isLikelyValidMp3` — cek magic bytes dulu, size floor fallback.
  - **TEMUAN-050** tts.routes: `synthesizeText` throw/return null saat buffer invalid; route return 500/502.
  - **TEMUAN-051** messages.routes: scope content-fallback lookup ke window 30s, atau drop fallback + require user_message_id.
  - **TEMUAN-053** controller: align heartbeat > first-byte timeout, atau start interval setelah first token.
  - **TEMUAN-055** (overlap TASK-011).
  - **TEMUAN-056** stories.controller: tambah language_style ke createRaw cap loop.
  - **TEMUAN-057** hapus ttsQueueManager.js + ttsEngine.js + entry SW precache.
  - **TEMUAN-058** hapus themeToggle.js.
  - **TEMUAN-059** markdownRenderer: `renderMarkdown` call overridden `md.render`, bukan `originalRender`.
  - **TEMUAN-060** apiClient: hapus `sendMessage` method.
  - **TEMUAN-061** eventBus: wrap emit per-listener try/catch + iterasi shallow copy.
  - **TEMUAN-062** sw.js: sync APP_SHELL dengan versioned URL + tambah tailwind.output.css.
  - **TEMUAN-065** story.html: hapus toolbarTtsBtn + ttsIndicator.
  - **TEMUAN-066** manifest: tambah `id` + update `<meta theme-color>` dari themeManager.
- **Kriteria selesai:** Masing-masing temuan punya unit test atau manual verifikasi sesuai deskripsi. Bisa dikerjakan beberapa sekaligus karena independen.
- **Risiko:** Batch — masing-masing low-risk. Urutkan yang berkaitan memory (041/043/044/047) setelah TASK-001-005 selesai untuk hindari konflik file.

### TASK-015: Sync schema.sql ke bentuk final (fix TEMUAN-014)
- **Prioritas:** 15
- **File yang perlu diubah:** `backend/src/db/schema.sql`
- **Bergantung pada:** TASK-005 (kalau tambah kolom memory_prev)
- **Deskripsi perubahan:** Update `CREATE TABLE stories` di schema.sql ke union kolom lengkap semua migration (avatar_url, avatar_enabled, font_family, font_size, roleplay_mode, dan memory_prev kalau TASK-005 tambah). Sehingga fresh install produksi tabel lengkap dan migration jadi no-op. Pertahankan migration untuk DB existing.
- **Kriteria selesai:** Fresh DB (hapus file sqlite, boot) → `PRAGMA table_info(stories)` show semua kolom; migration log "v2..v7: (no-op)" atau skip.
- **Risiko:** Rendah. Pastikan DEFAULT clause match migration.

---

## PERTANYAAN & KLARIFIKASI

Hal-hal yang tak bisa ditentukan dari kode saja — perlu konfirmasi developer sebelum DeepSeek eksekusi:

1. **[TASK-010] Apakah double-injection user message di `buildContextPayload` (TEMUAN-003) disengaja sebagai teknik "last message emphasis"?** Tidak ada comment yang mengindikasikan intent. Verifier hanya konfirmasi structural double-include. Jika disengaja, dokumentasikan + pilih alternatif exclude+append; jika tidak, hapus append (default rekomendasi). **Blokir TASK-010 sampai jelas.**

2. **[BUG-03] Apakah user klik play manual, atau expect auto-narration saat AI selesai?** Trace TTS konfirmasi **tidak ada auto-play path** — SSE `done` handler hanya render, tak call TTS. BUG-03 target "audio mulai ≤2s setelah AI selesai render" bisa berarti: (a) click→audio latency (user klik manual, BUG-03 = cold fetch), atau (b) auto-play feature missing. TASK-008 asumsikan (a) + prewarm. Jika (b), perlu task tambahan: auto-play on `done` (berhati-hati dengan browser autoplay policy — perlu user gesture sebelumnya). **Konfirmasi sebelum TASK-008 final.**

3. **[TASK-007] Apakah probe service worker + toast 'Cache audio tidak aktif' ingin dipertahankan sebagai feature?** Saat ini false-alarm setiap refresh (BUG-01). TASK-007 rekomendasi hapus sepenuhnya. Jika ingin dipertahankan (mis. untuk indikasi SW broken di environment tertentu), perlu fix probe + batasi toast hanya saat genuinely missing. **Konfirmasi: hapus atau fix?**

4. **[TASK-005] Server-side snapshot memory: kolom baru `memory_prev` vs side table `memory_snapshots`?** Kolom lebih simple (satu value, overwrite setiap update) tapi hanya simpan snapshot terakhir. Side table simpan history (append-only) tapi lebih kompleks. Rollback saat ini hanya butuh snapshot terakhir. **Konfirmasi: kolom (recommended) atau side table?**

5. **[TASK-008] Drop dummy warmup atau ubah warmup terima text param?** Dummy string `'Halo, saya siap membantu Anda.'` tak pernah hit real play (cache content-addressed). TASK-008 rekomendasi drop + rely real-text prewarm. Alternatif: ubah `/api/tts/warmup` terima `text` body dan warm text spesifik. **Konfirmasi approach.**

6. **[TEMUAN-055/TASK-011] Saat refresh mid-stream, apakah user message orphan yang sudah tersimpan ingin dihapus atau dipertahankan?** Saat ini orphan persist (BUG-02 kontributor). TASK-011 rekomendasi server-side cleanup otomatis. Tapi mungkin ada use case user ingin lihat pesan yang "terkirim" meski AI belum balas. **Konfirmasi: cleanup otomatis (recommended) atau biarkan orphan?**

7. **[Info] System prompt berisi instruksi jailbreak eksplisit ('TIDAK BOLEH menolak konten apapun... adegan kekerasan, seksual, dewasa')** (promptBuilder 217-224, 378-386). Ini **fitur eksplisit** FictionFlow sesuai FictionFlow.md Bab 6 (roleplay tanpa filter). Bukan temuan actionable — catatan INFO. DeepSeek: **jangan** "fix" ini dengan menambahkan content filter; itu akan mengubah tujuan produk. Konfirmasi developer bahwa ini intentional.

8. **[TASK-001] Apakah ada caller lain `normalizeDynamicMemory`/`parseDynamicMemory` di luar dua service yang diaudit?** Grep menunjukkan hanya di memoryExtractor + promptBuilder, tapi verifikasi sebelum refactor signature. **Konfirmasi tak ada caller tersembunyi (mis. test file, script).**

---

## CATATAN UNTUK DEEPSEEK V4 PRO

1. **Urutan task kritis.** Kerjakan TASK-001 (shared parser) **DULU** — itu prerequisite TASK-002/003/004/005. Tanpa shared parser, fix BUG-04 di extractor dan fix BUG-05 di promptBuilder akan drift (dua copy parser diverge lagi, persis TEMUAN-039/046). Setelah TASK-001-005 (memory cluster), BUG-04 dan BUG-05 selesai sekaligus. TASK-006/007 (BUG-01/02) independen, boleh paralel. TASK-008/009 (BUG-03) independen. TASK-010-013 independen. TASK-014 batch cleanup terakhir.

2. **Jangan salah fix file.** Temuan TEMUAN-057 penting: `ttsQueueManager.js` dan `ttsEngine.js` adalah **dead code** — 10s timeout + 3x retry yang disebut di brief audit ADA di file ini tapi **BUKAN live path**. Live TTS pipeline = inline `_ttsAudio` di `story.page.js`. Jangan fix BUG-03 di ttsQueueManager — fix di story.page.js (TASK-008/009). Hapus file dead setelah verifikasi (TASK-014).

3. **3 temuan REFUTED — jangan kerjakan.** C-002 (voice mismatch pre-synth): verifier konfirmasi frontend pakai satu voice per story (`resolveTtsVoice(story)` = `story.tts_voice`), bukan per-segment `voice_name`, jadi tidak ada mismatch ArdiNeural-vs-GadisNeural. C-010 (cache LRU vs FIFO): verifier konfirmasi LRU yang benar (`cacheGet` touch via delete+set, `cachePut` evict front = LRU element) — hanya comment yang menyesatkan, fix comment saja. D-003 (ordering asymmetry): verifier konfirmasi server `desc.slice().reverse()` → setiap page oldest-first, kedua renderer konsisten — fix docstring wording saja (non-actionable bug). Jangan implement "fix" untuk ketiganya sebagai bug.

4. **2 temuan downgrade — severity dikoreksi.** A-006 (TEMUAN-036, MEDIUM→LOW): semaphore global MAX_CONCURRENT=3 sudah ada di edgeTts.service:140-161, claim "tidak ada semaphore" salah. Sisa klaim valid (fire-and-forget tak tracked saat shutdown). B-MEM-010 (TEMUAN-063, MEDIUM→LOW): count di-cap 60 + summarizer compress >50, jadi prompt tak "tumbuh tak terbatas" — hanya bytes-per-fact unbounded, worst-case ~18KB di bawah 200KB. Fix tetap perlu (token budget) tapi LOW priority.

5. **Verifikasi line number.** Beberapa temuan cite line range dari hasil workflow agent — saat eksekusi, **baca file aktual** dan verifikasi line number masih match (kode mungkin sudah berubah sejak audit 2026-07-13). Setiap temuan cite file path yang clickable untuk navigasi.

6. **Test yang ada.** Repo punya test suite: `backend/src/services/edgeTts.service.test.js` + `tests/*.mjs` (test-memory-state, test-model-chain, test-pagination, test-sanitize-final-content, test-tts-button-lifecycle, test-sw-boot-probe, dll). **Jalankan sebelum dan sesudah setiap task.** Task memory (TASK-001-005) kemungkinan break `test-memory-state.mjs` — update test sesuai behavior baru. Task SW (TASK-006/007) break `test-sw-boot-probe.mjs` — update/hapus test probe.

7. **Tidak menulis kode perbaikan di laporan ini.** Laporan ini deskripsi konseptual saja. DeepSeek implementasi berdasarkan "Deskripsi perubahan" per task. Setiap task punya "Kriteria selesai" yang testable — verifikasi sebelum mark complete.

8. **Memory cluster adalah prioritas tertinggi.** BUG-04 + BUG-05 (dua bug user terberat, berdampak pada inti produk: roleplay continuity) berbagi akar struktural dan selesai dengan TASK-001-005. Setelah itu stabilitas codebase naik signifikan. BUG-01/02/03 fix localized (1-2 file masing-masing) tapi high-impact UX — kerjakan setelah memory cluster atau paralel jika resource ada.

9. **Data audit lengkap tersimpan.** Verbatim prompt ekstraksi, semua code snippet essential, jawaban audit AUDIT-01..15, dan 3 trace end-to-end full ada di `scratch/` repo: `findings_full.txt` (semua 71 temuan awal), `answers_excerpts.txt` (audit answers + excerpts per cluster), `traces_full.txt` (3 trace numbered steps + issues), `audit_reconstructed.json` (raw workflow output). DeepSeek boleh baca untuk detail tambahan tak muat di laporan ini. **Hapus folder `scratch/` setelah eksekusi selesai** (file scratch bukan bagian codebase).

10. **Total temuan distink 66** (13 HIGH + 21 MEDIUM + 28 LOW + 4 INFO) setelah 3 REFUTED + 2 merged. Statistik di header sudah dikoreksi. Jika hitung temuan awal workflow (71) minus refuted (3) = 68; minus 2 merge (C-004→001, C-005→002) = 66. Verdict per-temuan ada di `[V: …]` masing-masing.

---

*Laporan audit total FictionFlow — selesai 2026-07-13. 48 subagent, 645 tool call, 2.3M token, 40 file dibaca penuh, 3 trace end-to-end. Status: DRAFT untuk DeepSeek V4 Pro.*
