import 'dotenv/config';

const e = (key) => (process.env[key] || '').trim();

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_KEY', 'ADMIN_NUMBER'];
const missing = REQUIRED.filter(k => !e(k));
if (missing.length > 0) {
  console.error(`[Config] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

export const config = {
  port: Number(e('PORT')) || 3000,
  logDir: e('LOG_DIR') || './logs',
  supabase: {
    url: e('SUPABASE_URL'),
    key: e('SUPABASE_KEY'),
  },
  groupId: e('GROUP_ID'),
  adminNumber: e('ADMIN_NUMBER'),
  apiPassword: e('API_PASSWORD'),
  apiBase: e('API_BASE') || 'https://ndxstoreid.vercel.app',
  aiApiBase: e('AI_API_BASE') || 'https://text.pollinations.ai',
  aiModel: e('AI_MODEL') || 'openai',
  groqKey: e('GROQ_API_KEY'),
  groqVisionModel: e('GROQ_VISION_MODEL'),
  groqUrl: e('GROQ_URL') || 'https://api.groq.com/openai/v1/chat/completions',
};

console.log('Config OK. Admin:', config.adminNumber.replace(/.(?=.{4})/g, '*'));
