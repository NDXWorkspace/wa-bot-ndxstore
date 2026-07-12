import 'dotenv/config';

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL || 'https://jlfrtyyjxkmdetdbeakv.supabase.co',
    key: process.env.SUPABASE_KEY || '',
  },
  groupId: process.env.GROUP_ID || '',
  adminNumber: process.env.ADMIN_NUMBER || '',
};
