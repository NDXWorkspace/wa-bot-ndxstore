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

export async function createClient() {
  const puppeteerConfig = await getPuppeteerConfig();

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
    puppeteer: puppeteerConfig,
  });

  client.on('qr', (qr) => {
    console.log('\n[WA] Scan QR code ini dengan WhatsApp Anda:');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('[WA] Authenticated');
  });

  client.on('ready', () => {
    reconnectAttempt = 0;
    reconnectTimer = null;
  });

  client.on('auth_failure', (msg) => {
    console.error('[WA] Auth failure:', msg);
  });

  client.on('disconnected', async (reason) => {
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[WA] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Exiting.`);
      process.exit(1);
      return;
    }

    reconnectAttempt++;
    const jitter = Math.random() * 1000;
    const delay = Math.min(BASE_DELAY * Math.pow(2, reconnectAttempt - 1) + jitter, MAX_DELAY);
    console.warn(`[WA] Disconnected: ${reason} — reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);

    try { await client.destroy(); } catch {}
    client = null;

    reconnectTimer = setTimeout(async () => {
      try {
        const newClient = await createClient();
        newClient.initialize();
      } catch (e) {
        console.error('[WA] Reconnect init failed:', e.message);
      }
    }, delay);
  });

  return client;
}
