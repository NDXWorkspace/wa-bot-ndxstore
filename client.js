import ww from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
const { Client, LocalAuth } = ww;

let client = null;
let reconnectAttempt = 0;

export function getClient() {
  return client;
}

function getPuppeteerConfig() {
  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
  ];

  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[Puppeteer] Using browser (from env): ${envPath}`);
    return { headless: true, executablePath: envPath, args: baseArgs };
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

  let executablePath = null;
  for (const path of candidates) {
    if (fs.existsSync(path)) {
      executablePath = path;
      break;
    }
  }

  const config = { headless: true, args: baseArgs };
  if (executablePath) {
    config.executablePath = executablePath;
    console.log(`[Puppeteer] Using browser: ${executablePath}`);
  } else {
    console.log('[Puppeteer] No local browser found, using puppeteer default');
  }
  return config;
}

export async function createClient() {
  const puppeteerConfig = getPuppeteerConfig();

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
  });

  client.on('auth_failure', (msg) => {
    console.error('[WA] Auth failure:', msg);
  });

  client.on('disconnected', (reason) => {
    const delay = Math.min(5000 * Math.pow(2, reconnectAttempt), 300000);
    reconnectAttempt++;
    console.warn(`[WA] Disconnected: ${reason} — reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})`);
    setTimeout(() => client.initialize(), delay);
  });

  return client;
}
