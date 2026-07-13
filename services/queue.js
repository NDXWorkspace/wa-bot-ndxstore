import { getDb } from './supabase.js';
import { logger } from '../utils/logger.js';

const DAILY_LIMIT_DEFAULT = 50;

export async function checkDailyLimit(userJid) {
  const db = getDb();
  if (!db) return { allowed: true };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await db
      .from('wa_user_limits')
      .select('message_count, last_reset_date, max_per_day')
      .eq('user_number', userJid)
      .single();

    if (error?.code === 'PGRST116') {
      await db.from('wa_user_limits').insert({
        user_number: userJid,
        message_count: 1,
        last_reset_date: today,
        max_per_day: DAILY_LIMIT_DEFAULT,
      });
      return { allowed: true, remaining: DAILY_LIMIT_DEFAULT - 1 };
    }

    if (data) {
      if (data.last_reset_date !== today) {
        await db.from('wa_user_limits').update({
          message_count: 1,
          last_reset_date: today,
        }).eq('user_number', userJid);
        return { allowed: true, remaining: (data.max_per_day || DAILY_LIMIT_DEFAULT) - 1 };
      }
      if (data.message_count >= (data.max_per_day || DAILY_LIMIT_DEFAULT)) {
        return { allowed: false, remaining: 0 };
      }
      await db.from('wa_user_limits').update({
        message_count: data.message_count + 1,
      }).eq('user_number', userJid);
      return { allowed: true, remaining: (data.max_per_day || DAILY_LIMIT_DEFAULT) - data.message_count - 1 };
    }
  } catch (e) {
    if (!e.message?.includes('relation') && !e.message?.includes('does not exist')) {
      logger.error('Queue', 'Daily limit error:', e.message);
    }
  }
  return { allowed: true };
}
