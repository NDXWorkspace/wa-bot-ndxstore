import { getDb } from './supabase.js';
import { logger } from '../utils/logger.js';
import { withRetry, isRelationError } from '../utils/db.js';

const SETTINGS_KEY = 'bot_settings';

const defaults = {
  jawabDuluan: false,
  ungroup: true,
  aiMode: 3, // 3 = Custom AI Umum (otomatis aktif saat WA terhubung), 1 = Bima, 2 = CS, 0 = OFF
  aiName: 'Asisten AI',
  aiStyle: 'santai', // 'santai' | 'ramah' | 'profesional' | 'custom'
  customPrompt: 'Kamu adalah asisten WhatsApp yang cerdas, ramah, asik diajak ngobrol, dan sangat membantu. Jawab setiap pesan secara natural seperti manusia asli di WhatsApp.',
  customKnowledge: '',
  replyPrivate: true,
  replyGroup: 'mention', // 'all' | 'mention' | 'off'
  useStoreData: false,
};

export const settings = { ...defaults };

let loaded = false;

let loadPromise = null;

export async function loadSettings() {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const db = getDb();
    if (!db) return;
    try {
      const { data } = await withRetry(() => db
        .from('wa_bot_config')
        .select('value')
        .eq('key', SETTINGS_KEY)
        .single(), { label: 'Settings:load' });
      if (data?.value && typeof data.value === 'object') {
        Object.assign(settings, defaults, data.value);
        if (data.value.customPrompt === undefined && (!settings.aiMode || settings.aiMode === 0)) {
          settings.aiMode = 3;
        }
        logger.info('Settings', 'Loaded from DB:', JSON.stringify(settings));
      }
    } catch (e) {
      if (!isRelationError(e)) {
        logger.error('Settings', 'Load error:', e.message);
      }
    }
    loaded = true;
  })();
  return loadPromise;
}

async function saveToDb() {
  const db = getDb();
  if (!db) return;
  try {
    await withRetry(() => db.from('wa_bot_config').upsert({
      key: SETTINGS_KEY,
      value: JSON.parse(JSON.stringify(settings)),
    }, { onConflict: 'key' }), { label: 'Settings:save' });
  } catch (e) {
    if (!isRelationError(e)) {
      logger.error('Settings', 'Save error:', e.message);
    }
  }
}

let saveTimer = null;

setInterval(() => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveToDb().catch(() => {});
  }
}, 30000).unref();

export function saveSettings() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDb().catch(() => {});
  }, 1000);
}

export async function flushSettings() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveToDb();
}
