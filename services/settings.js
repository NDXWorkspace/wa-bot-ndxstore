import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { getDb } from './supabase.js';
import { logger } from '../utils/logger.js';
import { withRetry, isRelationError } from '../utils/db.js';

const SETTINGS_KEY = 'bot_settings';
const LOCAL_SETTINGS_PATH = path.resolve('./wa-session/settings.json');

const envKeys = {
  groqKey: config.groqKey,
  geminiKey: config.geminiKey,
  openrouterKey: config.openrouterKey,
};

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
  groqKey: '',
  geminiKey: '',
  openrouterKey: '',
};

export const settings = { ...defaults };

export function syncKeysToConfig() {
  config.groqKey = (settings.groqKey || '').trim() || envKeys.groqKey;
  config.geminiKey = (settings.geminiKey || '').trim() || envKeys.geminiKey;
  const rawOr = (settings.openrouterKey || '').trim();
  if (rawOr) {
    config.openrouterKey = rawOr.startsWith('sk-or-')
      ? rawOr
      : /^[a-f0-9]{64}$/i.test(rawOr)
        ? `sk-or-v1-${rawOr}`
        : rawOr;
  } else {
    config.openrouterKey = envKeys.openrouterKey;
  }
}

let loaded = false;

let loadPromise = null;

async function loadFromLocalFile() {
  try {
    const raw = await fs.readFile(LOCAL_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      Object.assign(settings, defaults, parsed);
      syncKeysToConfig();
      return true;
    }
  } catch {}
  return false;
}

async function saveToLocalFile() {
  try {
    await fs.mkdir(path.dirname(LOCAL_SETTINGS_PATH), { recursive: true });
    await fs.writeFile(LOCAL_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    logger.debug('Settings', 'Local file save error:', e.message);
  }
}

export async function loadSettings() {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await loadFromLocalFile();
    const db = getDb();
    if (!db) {
      loaded = true;
      return;
    }
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
        syncKeysToConfig();
        logger.info('Settings', 'Loaded from DB:', JSON.stringify({ ...settings, groqKey: settings.groqKey ? '***' : '', geminiKey: settings.geminiKey ? '***' : '', openrouterKey: settings.openrouterKey ? '***' : '' }));
        await saveToLocalFile();
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
  syncKeysToConfig();
  await saveToLocalFile();
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
  syncKeysToConfig();
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
