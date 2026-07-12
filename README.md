# WA Bot NDXStore

WhatsApp bot untuk NDXStore — powered by whatsapp-web.js + Google Gemini AI.

## Cara Pakai

### 1. Install

```bash
cd wa-bot
npm install
```

### 2. Setup Environment

```bash
cp .env.example .env
```

Isi `.env`:

| Variable | Wajib? | Keterangan |
|----------|--------|------------|
| `GEMINI_API_KEY` | Wajib | Google Gemini API key (free tier, daftar di https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | Opsional | Fallback AI, daftar di https://openrouter.ai/keys |
| `SUPABASE_KEY` | Opsional | Supabase `service_role` key (untuk simpan riwayat chat & limit) |
| `ADMIN_NUMBER` | Wajib | Nomor WhatsApp admin (format: 628xxx) |
| `NDXSTORE_API_URL` | Opsional | URL backend NDXStore (default: http://localhost:3000) |

### 3. Setup Database (Opsional — untuk riwayat chat & limit)

Jalankan `supabase-schema.sql` di Supabase Dashboard → SQL Editor.

### 4. Jalankan Bot

```bash
npm start
```

Scan QR code yang muncul di terminal dengan WhatsApp Anda (WhatsApp Web).

### 5. Production dengan PM2

```bash
npm install -g pm2
pm2 start index.js --name wa-bot
pm2 save
pm2 startup
```

## Aturan Bot

| Aturan | Detail |
|--------|--------|
| ✅ **Balas hanya pesan masuk** | Bot tidak pernah kirim pesan duluan |
| ✅ **Skip grup/broadcast/status** | Pesan dari grup, channel, broadcast, status diabaikan |
| ✅ **Delay 3 detik** | Antar balasan ada jeda 3 detik untuk hindari ban |
| ✅ **Limit harian** | Maks 50 pesan per user per hari (bisa diubah via `/limit`) |
| ✅ **Auto-restart** | Pakai PM2, restart otomatis kalau crash |

## Fitur

| Fitur | Cara |
|-------|------|
| **Menu angka** | Ketik `menu` atau `0` |
| **Cek status order** | Ketik `cek [username]` atau `1` |
| **Produk & harga** | Ketik `2` |
| **Cara order** | Ketik `3` |
| **Hubungi CS** | Ketik `4` atau `cs` |
| **Info pembayaran** | Ketik `5` |
| **Tanya AI** | Tanya bebas, dijawab AI dengan riwayat chat |
| **Handover ke admin** | User kirim `cs` → bot forward ke admin |
| **Kontrol bot** | Admin kirim command dari WA |

## Command Admin

| Command | Fungsi |
|---------|--------|
| `/status` | Lihat status bot |
| `/pause` | Pause bot (skip semua non-admin) |
| `/resume` | Resume bot |
| `/limit 628xxx 100` | Set limit harian user |
| `/clear 628xxx` | Hapus riwayat chat user |
| `/cs 628xxx` | Aktifkan handover untuk user |
| `/close 628xxx` | Tutup handover |

## Catatan Penting

- Bot menggunakan `whatsapp-web.js` (unofficial) — resiko ban WA tetap ada jika disalahgunakan
- **JANGAN** gunakan untuk blast/spam ke nomor yang tidak dikenal
- Bot hanya membalas pesan masuk, tidak pernah memulai chat
- Untuk 24/7, jalankan di VPS/Raspberry Pi dengan PM2
