import ww from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fsp from 'fs/promises';
const { Client, LocalAuth } = ww;

const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_DELAY = 5000;
const MAX_DELAY = 300000;

let client = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let isReconnecting = false;
let onNewClient = null;

async function getPuppeteerConfig() {
  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
  ];

  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    try {
      await fsp.access(envPath);
      console.log(`[Puppeteer] Using browser (from env): ${envPath}`);
      return { headless: true, executablePath: envPath, args: baseArgs };
    } catch {}
  }

  const candidates = [
    '/data/data/com.termux/files/usr/bin/chromium',
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];

  for (const candidate of candidates) {
    try {
      await fsp.access(candidate);
      console.log(`[Puppeteer] Using browser: ${candidate}`);
      return { headless: true, executablePath: candidate, args: baseArgs };
    } catch {}
  }

  console.log('[Puppeteer] No local browser found, using puppeteer default');
  return { headless: true, args: baseArgs };
}

function calcDelay(attempt) {
  const jitter = Math.random() * 1000;
  return Math.min(BASE_DELAY * Math.pow(2, attempt - 1) + jitter, MAX_DELAY);
}

async function createClientCore() {
  const puppeteerConfig = await getPuppeteerConfig();
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
    puppeteer: puppeteerConfig,
  });

  c.on('qr', (qr) => {
    console.log('\n[WA] Scan QR code ini dengan WhatsApp Anda:');
    qrcode.generate(qr, { small: true });
  });

  c.on('authenticated', () => {
    console.log('[WA] Authenticated');
  });

  c.on('ready', () => {
    reconnectAttempt = 0;
    isReconnecting = false;
    console.log('[WA] Client ready');
  });

  c.on('auth_failure', (msg) => {
    console.error('[WA] Auth failure:', msg);
  });

  c.on('disconnected', async (reason) => {
    if (isReconnecting) return;
    console.warn(`[WA] Disconnected: ${reason}`);
    reconnect(c);
  });

  return c;
}

async function reconnect(oldClient) {
  if (isReconnecting) return;
  isReconnecting = true;

  try { try { await oldClient.destroy(); } catch {} } catch {}

  while (reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempt++;
    const delay = calcDelay(reconnectAttempt);
    console.warn(`[WA] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);

    await new Promise(resolve => { reconnectTimer = setTimeout(resolve, delay); });

    try {
      client = await createClientCore();
      if (onNewClient) onNewClient(client);
      client.initialize();
      isReconnecting = false;
      return;
    } catch (e) {
      console.error(`[WA] Reconnect attempt ${reconnectAttempt} failed:`, e.message);
    }
  }

  console.error(`[WA] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Exiting.`);
  isReconnecting = false;
  process.exit(1);
}

export async function createClient(setupHandler) {
  if (client) return client;
  onNewClient = setupHandler || null;
  client = await createClientCore();
  return client;
}
