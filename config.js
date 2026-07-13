import 'dotenv/config';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_KEY', 'ADMIN_NUMBER'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[Config] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  groupId: process.env.GROUP_ID || '',
  adminNumber: process.env.ADMIN_NUMBER || '',
  apiPassword: process.env.API_PASSWORD || '',
  aiKey: process.env.AI_API_KEY || '',
  aiApiBase: process.env.AI_API_BASE || 'https://text.pollinations.ai',
  aiModel: process.env.AI_MODEL || 'openai',
  groqKey: process.env.GROQ_API_KEY || '',
};

console.log('[Config] Validated. Admin:', config.adminNumber);
