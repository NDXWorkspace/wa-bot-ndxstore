# WA Bot NDXStore

WhatsApp customer-service & order-notification bot untuk **NDXStore** (top up game & Roblox).
Dibangun dengan **whatsapp-web.js** (Puppeteer) + AI via **Groq** dengan fallback **Pollinations**, dan **Supabase** untuk riwayat chat, limit, serta monitor order realtime.

## Fitur

| Fitur | Cara / Detail |
|-------|---------------|
| **Menu angka** | Ketik `menu` atau `0` |
| **Cek status order** | Ketik `cek [username]` atau `1` (query ke API NDXStore) |
| **Produk & harga** | Ketik `2` |
| **Cara order** | Ketik `3` |
| **Info pembayaran** | Ketik `5` |
| **Hubungi CS (handover)** | Ketik `4` atau `cs` → pesan diteruskan ke admin, balasan admin (via reply) diteruskan balik ke user. Ketik `selesai`/`stop` untuk mengakhiri |
| **AI chat** | Kalau AI mode aktif, pesan bebas dijawab AI dengan riwayat percakapan per-user |
| **AI gambar** | Kirim gambar → dianalisa AI (via Pollinations; Groq vision opsional) |
| **Gambar sekali lihat** | Kirim foto/video view-once → bot mengunduh sekali, menyimpan salinan ke `./downloads`, lalu membacanya via AI |
| **Notifikasi order** | Monitor tabel `transactions` Supabase secara realtime → kirim notif ke grup admin + ke customer |

## AI Mode

Bot punya 3 mode (diatur admin lewat `!aimode`):

| Mode | Persona |
|------|---------|
| `0` | Nonaktif — bot hanya melayani menu & command, tidak auto-reply chat bebas |
| `1` | **Bima** — teman santai gaya anak Jakarta (gue-lo) |
| `2` | **NDXStore CS** — customer service profesional & ramah |

Rantai model AI: **Groq** (`llama-3.3-70b-versatile` → `llama-3.1-8b-instant`) → **Pollinations** (`openai` → `llama` → `mistral` → `openai-large`). Endpoint yang gagal di-cooldown sementara supaya request berikutnya langsung lompat ke fallback.

Optimasi AI:
- **Smart routing** — pertanyaan faktual (harga/status/order) hanya memakai model kecil & cepat (70b dilewati) untuk hemat kuota; chat bebas memakai semua tier demi latensi terbaik
- **Abort-on-win** — request ke tier yang kalah langsung dibatalkan begitu ada pemenang, tidak makan kuota sia-sia
- **Token tracking** — pemakaian token per model tercatat, lihat di `GET /metrics` (`promptTokens`, `completionTokens`)
- **Time grounding** — AI tahu hari/tanggal/jam WIB + status jam layanan CS (08.00–22.00)
- **Filter hemat kuota** — pesan gibberish/emoji-only/1 karakter dan duplikat (<15 detik) di-skip tanpa panggil API
- **Auto-resolve `cek`** — `cek [username]` / `cek [TX-/NDX-xxxx]` dijawab langsung dari API NDXStore tanpa AI (nol token), bahkan saat AI mode aktif
- **Fast replies** — kata filler (`ok`, `makasih`, `wkwk`, `oh`, `hmm`, dll) dibalas instan tanpa API call
- **Sentiment escalation** — user marah 2x dalam 10 menit langsung diarahkan ke CS (`ketik "cs"`)
- **Context-aware fallback** — saat semua endpoint AI down, jawaban tetap berguna sesuai intent (order → suruh `cek`, harga → suruh buka web, CS → suruh ketik `cs`)
- **Persona Bima manusia** — bukan CS, ga pernah buka dengan sapaan, pake gue/lu, kadang selipin reaksi personal (jarang, ga tiap pesan)
- **User profile memory** — Bima inget game favorit user + topik terakhir; topik sama 2x+ beruntun dijawab langsung to the point
- **Status proaktif** — user nanya status tanpa username/ID langsung ditanya username-nya ("username ml-nya apa? ntar gw cekin"), bukan disuruh "ketik cek"
- **Reply variation** — jawaban identik beruntun dikasih opener beda biar ga kayak template
- **Trim di batas kalimat** — balasan panjang dipotong di akhir kalimat (220 chars Bima / 400 CS), bukan kepenggal di tengah ide
- **Typing manusiawi** — DM mode Bima delay 2-5 detik + indikator "mengetik" sebelum jawab

## Setup

### 1. Install

```bash
cd wa-bot
npm install
```

### 2. Environment

```bash
cp .env.example .env
```

Isi `.env`:

| Variable | Wajib? | Keterangan |
|----------|--------|------------|
| `SUPABASE_URL` | **Wajib** | URL project Supabase |
| `SUPABASE_KEY` | **Wajib** | Supabase `service_role` key (riwayat chat, limit, config, order monitor) |
| `ADMIN_NUMBER` | **Wajib** | Nomor WhatsApp admin (format `628xxx` atau `+628xxx`) |
| `GROUP_ID` | Opsional | ID grup notifikasi order (dapatkan dengan kirim `!groupid` di grup) |
| `API_PASSWORD` | Opsional | Password admin API NDXStore (untuk command `!stats`/`!status` dll) |
| `AI_API_KEY` | Opsional | API key untuk endpoint AI kustom (jika ada) |
| `AI_API_BASE` | Opsional | Base URL AI kustom (default `https://text.pollinations.ai`) |
| `AI_MODEL` | Opsional | Nama model di `AI_API_BASE` (default `openai`) |
| `GROQ_API_KEY` | Opsional | Groq API key (prefix `gsk_`) untuk AI utama yang lebih cepat/pintar |
| `PAIRING_NUMBER` | Opsional | Nomor WA akun bot (format `628xxx`, tanpa `+`) untuk login via **pairing code** — tanpa scan QR. Kosong = login via scan QR |
| `GROQ_VISION_MODEL` | Opsional | Model multimodal Groq untuk gambar. Kosong = gambar diproses via Pollinations |
| `LOG_LEVEL` | Opsional | `error` \| `warn` \| `info` \| `debug` (default `info`) |
| `PORT` | Opsional | Port health-check HTTP (default `3000`) |

> `config.js` akan `exit(1)` kalau salah satu variabel **Wajib** kosong.

### 3. Database

Jalankan `supabase-schema.sql` di Supabase Dashboard → SQL Editor (atau `node scripts/migrate-schema.mjs`). Tabel yang dipakai: `transactions`, `wa_chat_history`, `wa_user_limits`, `wa_bot_config`, `wa_handover_sessions`.

### 4. Jalankan

```bash
npm start          # produksi
npm run dev        # dev, auto-reload (node --watch)
```

Scan QR code yang muncul di terminal dengan WhatsApp (Linked Devices). Sesi disimpan di `./wa-session` jadi tidak perlu scan ulang tiap restart.

**Login tanpa scan (pairing code):** isi `PAIRING_NUMBER` di `.env` dengan nomor WA akun bot, lalu restart. Kode 8 karakter muncul di terminal dan di `http://localhost:<PORT>/qr` (juga tersedia sebagai JSON di `/code`). Di HP: WhatsApp → Perangkat Tertaut → *Tautkan dengan nomor telepon* → masukkan kode. Kode refresh otomatis tiap ±3 menit.

### 5. Produksi (PM2 / Docker / Render)

```bash
# PM2
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Tersedia juga `Dockerfile` (node 22 + Chrome, dijalankan via `pm2-runtime`) dan `render.yaml` untuk deploy ke Render.

## Panel Admin (localhost)

Semua konfigurasi bot lewat panel web, **bukan via chat**. Buka setelah bot jalan:

```
http://localhost:<PORT>/admin
```

Yang bisa dilakukan dari panel:

| Fitur | Keterangan |
|-------|------------|
| Status | WA (terhubung/tidak + nomor), DB, uptime, mode AI (auto-refresh 10 detik) |
| Mode AI | OFF / Bima / CS + toggle jawab-duluan & ungroup |
| Kirim pesan | Kirim WA langsung ke nomor (`628xxx`/`08xxx`) |
| Blokir | Daftar + blokir/unblock user per nomor |
| Toko — statistik | Total transaksi, revenue, pending |
| Toko — pending | Order pending + filter game |
| Toko — order | Cari `NDX-XXXX` + update status |
| AI metrics | Calls, errors, avg response, token per model |
| Riwayat | 20 chat terakhir + reset history per nomor |
| Log level | error / warn / info / debug |

Server HTTP bind ke `HOST` (default `127.0.0.1` = hanya dari PC ini). Kalau `HOST=0.0.0.0` (mis. di Render), **wajib** isi `ADMIN_TOKEN` — panel & `/api/*` butuh header `x-admin-token` (panel otomatis minta token & simpan di browser).

Admin tetap bisa **reply** pesan handover yang diteruskan bot (quote pesan forward) untuk membalas user langsung dari WA.

## Health Check

`GET http://localhost:<PORT>/` mengembalikan JSON status (`200` kalau WA & DB terhubung, `503` kalau degraded):

```json
{ "status": "ok", "wa": "connected", "db": "connected", "uptime": 12345, "botUptime": 678, "aiMode": 1 }
```

## Aturan & Catatan

- Bot pakai `whatsapp-web.js` (**unofficial**) — risiko ban WA tetap ada kalau disalahgunakan. **Jangan** untuk blast/spam.
- Balasan chat di-throttle (cooldown per user + antrian kirim ~1.2s) dan dibatasi **50 pesan/user/hari** untuk mengurangi risiko ban.
- Bot **tidak memulai chat bebas** ke user — **kecuali** notifikasi order (order baru / pembayaran dikonfirmasi) yang memang dikirim otomatis ke customer & grup admin oleh order monitor.
- Untuk 24/7, jalankan di VPS/Raspberry Pi dengan PM2 (auto-restart saat crash, cap memori 500M).
