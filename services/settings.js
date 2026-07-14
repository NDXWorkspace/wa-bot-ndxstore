import { getDb } from './supabase.js';
import { logger } from '../utils/logger.js';

const SETTINGS_KEY = 'bot_settings';

const defaults = {
  jawabDuluan: false,
  ungroup: true,
  aiMode: 0,
};

export const settings = { ...defaults };

let loaded = false;

export async function loadSettings() {
  if (loaded) return;
  const db = getDb();
  if (!db) return;
  try {
    const { data } = await db
      .from('wa_bot_config')
      .select('value')
      .eq('key', SETTINGS_KEY)
      .single();
    if (data?.value && typeof data.value === 'object') {
      Object.assign(settings, defaults, data.value);
      logger.info('Settings', 'Loaded from DB:', JSON.stringify(settings));
    }
  } catch (e) {
    if (!e.message?.includes('relation') && !e.message?.includes('does not exist')) {
      logger.error('Settings', 'Load error:', e.message);
    }
  }
  loaded = true;
}

async function saveToDb() {
  const db = getDb();
  if (!db) return;
  try {
    await db.from('wa_bot_config').upsert({
      key: SETTINGS_KEY,
      value: JSON.parse(JSON.stringify(settings)),
    }, { onConflict: 'key' });
  } catch (e) {
    if (!e.message?.includes('relation') && !e.message?.includes('does not exist')) {
      logger.error('Settings', 'Save error:', e.message);
    }
  }
}

let saveTimer = null;
export function saveSettings() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDb();
  }, 1000);
}

export async function flushSettings() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveToDb();
}
