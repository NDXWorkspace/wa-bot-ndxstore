import 'dotenv/config';

const e = (key) => (process.env[key] || '').trim();

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_KEY', 'ADMIN_NUMBER'];
const missing = REQUIRED.filter(k => !e(k));
if (missing.length > 0) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

export const config = {
  port: Number(e('PORT')) || 3000,
  // Bind HTTP server (panel + health). Default localhost-only.
  // Isi 0.0.0.0 kalau perlu diakses dari luar (wajib pasang ADMIN_TOKEN).
  host: e('HOST') || '127.0.0.1',
  // Token panel admin (header x-admin-token / ?token=). Kosong = tanpa auth
  // (aman selama HOST localhost). Wajib diisi kalau HOST=0.0.0.0.
  adminToken: e('ADMIN_TOKEN'),
  logDir: e('LOG_DIR') || './logs',
  supabase: {
    url: e('SUPABASE_URL'),
    key: e('SUPABASE_KEY'),
  },
  groupId: e('GROUP_ID'),
  adminNumber: e('ADMIN_NUMBER'),
  // Nomor WA akun bot untuk login via pairing code (format 628xxx, tanpa +).
  // Kosong = login via scan QR seperti biasa.
  pairingNumber: e('PAIRING_NUMBER').replace(/[^0-9]/g, ''),
  apiPassword: e('API_PASSWORD'),
  // Token bot untuk /api/admin/* (header x-bot-token). Nilainya HARUS SAMA
  // dengan BOT_API_TOKEN di Vercel. Lihat ndxstoreid/docs/bot-auth.md.
  botToken: e('NDX_BOT_TOKEN'),
  // Cookie sesi login Google owner untuk /api/admin/* (NextAuth).
  // Contoh isi: "next-auth.session-token=AAA...; __Secure-next-auth.session-token=AAA..."
  // Cara ambil: login di ndxstoreid.vercel.app via Chrome → F12 → Application →
  // Cookies → copy semua cookie jadi satu string "nama=nilai; nama=nilai".
  ndxSession: e('NDX_SESSION'),
  apiBase: e('API_BASE') || 'https://ndxstoreid.vercel.app',
  aiApiBase: e('AI_API_BASE') || 'https://text.pollinations.ai',
  aiModel: e('AI_MODEL') || 'openai',
  groqKey: e('GROQ_API_KEY'),
  groqVisionModel: e('GROQ_VISION_MODEL'),
  groqUrl: e('GROQ_URL') || 'https://api.groq.com/openai/v1/chat/completions',
  openrouterKey: (() => {
    const raw = e('OPENROUTER_API_KEY');
    if (!raw) return '';
    if (raw.startsWith('sk-or-')) return raw;
    if (/^[a-f0-9]{64}$/i.test(raw)) return `sk-or-v1-${raw}`;
    return raw;
  })(),
  openrouterModel: e('OPENROUTER_MODEL') || 'nvidia/nemotron-3-ultra-550b-a55b:free',
  openrouterUrl: e('OPENROUTER_URL') || 'https://openrouter.ai/api/v1/chat/completions',
  aiApiBackup: e('AI_API_BACKUP') || 'https://keylessai.thryx.workers.dev/v1',
  notifiedPath: e('NOTIFIED_PATH') || './.notified.json',
  // Instagram Official Graph API / Webhook
  igAccessToken: (() => {
    const raw = e('IG_ACCESS_TOKEN');
    if (!raw) return '';
    if (raw.startsWith('IGA') || raw.startsWith('EAA')) return raw;
    try {
      const dec = Buffer.from(raw, 'base64').toString('utf8').trim();
      if (dec.startsWith('IGA') || dec.startsWith('EAA')) return dec;
    } catch {}
    return raw;
  })(),
  igAccountId: e('IG_ACCOUNT_ID') || 'me',
  igVerifyToken: e('IG_VERIFY_TOKEN') || 'ndxstore_ig_verify_2026',
  igAppSecret: e('IG_APP_SECRET'),
  igGraphBase: e('IG_GRAPH_BASE'),
  igPollIntervalMs: e('IG_POLL_INTERVAL_MS') !== '' ? Number(e('IG_POLL_INTERVAL_MS')) : 15000,
  igAiMode: Number(e('IG_AI_MODE')) || 0,
};

if (process.env.LOG_CONSOLE !== 'false') {
  console.log('Config OK. Admin:', config.adminNumber.replace(/\d(?=\d{4})/g, '*'));
}

// Keamanan: binding non-localhost tanpa ADMIN_TOKEN = panel + /api/* + /qr
// terbuka ke publik. Tolak konfigurasi berbahaya ini saat boot.
{
  const host = config.host;
  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLocal && !config.adminToken) {
    throw new Error(
      `HOST=${host} di-expose ke jaringan tapi ADMIN_TOKEN kosong — /admin, /api/*, dan /qr akan terbuka publik. ` +
      'Isi ADMIN_TOKEN di .env dulu (token acak panjang).'
    );
  }
}

// Kredensial: RLS schema hanya mengizinkan role service_role. Key anon/
// publishable ditolak DB → semua fitur DB mati diam-diam. Deteksi dini.
try {
  const parts = String(config.supabase.key || '').split('.');
  if (parts.length === 3) {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (payload.role && payload.role !== 'service_role') {
      console.error(
        `Config ERROR: SUPABASE_KEY memakai role "${payload.role}" — schema butuh service_role. ` +
        'Ganti dengan service_role key (Supabase Dashboard → Settings → API). Fitur DB tidak akan jalan dengan key ini.'
      );
    }
  }
} catch {}
