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
| **Notifikasi order** | Monitor tabel `transactions` Supabase secara realtime → kirim notif ke grup admin + ke customer |

## AI Mode

Bot punya 3 mode (diatur admin lewat `!aimode`):

| Mode | Persona |
|------|---------|
| `0` | Nonaktif — bot hanya melayani menu & command, tidak auto-reply chat bebas |
| `1` | **Bima** — teman santai gaya anak Jakarta (gue-lo) |
| `2` | **NDXStore CS** — customer service profesional & ramah |

Rantai model AI: **Groq** (`llama-3.3-70b-versatile` → `llama-3.1-8b-instant`) → **Pollinations** (`openai` → `llama` → `mistral` → `openai-large`). Endpoint yang gagal di-cooldown sementara supaya request berikutnya langsung lompat ke fallback.

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

### 5. Produksi (PM2 / Docker / Render)

```bash
# PM2
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Tersedia juga `Dockerfile` (node 22 + Chrome, dijalankan via `pm2-runtime`) dan `render.yaml` untuk deploy ke Render.

## Command Admin

Semua command admin pakai prefix `!` dan hanya jalan untuk `ADMIN_NUMBER` (atau pesan dari akun bot sendiri).

### Kontrol bot & AI

| Command | Fungsi |
|---------|--------|
| `!help` | Daftar command API admin |
| `!aimode` | Lihat mode AI sekarang |
| `!aimode 0` \| `1` \| `2` | Set mode AI (nonaktif / Bima / NDXStore CS) |
| `!aireset` | Reset riwayat chat percakapan aktif |
| `!clear <n>` | Hapus `n` pesan terakhir yang dikirim bot di chat ini (1–50) |
| `!history [n]` | Lihat `n` riwayat chat terakhir (default 20) |
| `!block` / `!unblock` | Blokir / buka blokir user (kirim di chat user, atau di grup) |
| `!aimodesetting` | Lihat setting `jawab duluan` & `ungroup` |
| `!aimodesetting jd` | Toggle *jawab duluan* (AI sapa customer duluan saat ada order baru) |
| `!aimodesetting uningroup` | Toggle mode grup: hanya balas kalau di-mention/di-reply |
| `!groupid` | Tampilkan Group ID (kirim di dalam grup) |
| `!reply 628xxx <pesan>` | Kirim pesan langsung ke nomor user |

Admin juga bisa **reply** pesan handover yang diteruskan bot untuk membalas user tanpa command.

### Command API NDXStore (butuh `API_PASSWORD`)

| Command | Fungsi |
|---------|--------|
| `!stats` | Statistik transaksi |
| `!orders` | 5 order terbaru |
| `!pending [game]` | Order pending (opsional filter per game) |
| `!detail NDX-XXXX` | Detail satu order |
| `!status NDX-XXXX <STATUS>` | Update status order (`SUCCESS`, `PROCESSING`, `REJECTED`, `PENDING`, `WAITING_PAYMENT`) |

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
