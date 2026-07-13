import 'dotenv/config';

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL || 'https://jlfrtyyjxkmdetdbeakv.supabase.co',
    key: process.env.SUPABASE_KEY || '',
  },
  groupId: process.env.GROUP_ID || '',
  adminNumber: process.env.ADMIN_NUMBER || '',
  apiPassword: process.env.API_PASSWORD || '',
  aiKey: process.env.AI_API_KEY || '',
  aiApiBase: process.env.AI_API_BASE || 'https://openrouter.ai/api/v1',
  aiModel: process.env.AI_MODEL || 'mistralai/mistral-7b-instruct:free',
};
