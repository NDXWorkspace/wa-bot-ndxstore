import 'dotenv/config';

const e = (key) => (process.env[key] || '').trim();

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_KEY', 'ADMIN_NUMBER'];
const missing = REQUIRED.filter(k => !e(k));
if (missing.length > 0) {
  console.error(`[Config] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

export const config = {
  supabase: {
    url: e('SUPABASE_URL'),
    key: e('SUPABASE_KEY'),
  },
  groupId: e('GROUP_ID'),
  adminNumber: e('ADMIN_NUMBER'),
  apiPassword: e('API_PASSWORD'),
  apiBase: e('API_BASE') || 'https://ndxstoreid.vercel.app',
  aiKey: e('AI_API_KEY'),
  aiApiBase: e('AI_API_BASE') || 'https://text.pollinations.ai',
  aiModel: e('AI_MODEL') || 'openai',
  groqKey: e('GROQ_API_KEY'),
  groqVisionModel: e('GROQ_VISION_MODEL'),
};

console.log('Config OK. Admin:', config.adminNumber.replace(/.(?=.{4})/g, '*'));
