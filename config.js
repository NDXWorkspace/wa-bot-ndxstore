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
  apiBase: e('API_BASE') || 'https://ndxstoreid.vercel.app',
  aiApiBase: e('AI_API_BASE') || 'https://text.pollinations.ai',
  aiModel: e('AI_MODEL') || 'openai',
  groqKey: e('GROQ_API_KEY'),
  groqVisionModel: e('GROQ_VISION_MODEL'),
  groqUrl: e('GROQ_URL') || 'https://api.groq.com/openai/v1/chat/completions',
  aiApiBackup: e('AI_API_BACKUP') || 'https://keylessai.thryx.workers.dev/v1',
  notifiedPath: e('NOTIFIED_PATH') || './.notified.json',
};

if (process.env.LOG_CONSOLE !== 'false') {
  console.log('Config OK. Admin:', config.adminNumber.replace(/\d(?=\d{4})/g, '*'));
}
