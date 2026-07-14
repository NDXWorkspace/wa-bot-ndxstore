import ww from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fsp from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './utils/logger.js';
const execAsync = promisify(exec);
const { Client, LocalAuth } = ww;

const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_DELAY = 5000;
const MAX_DELAY = 300000;

let client = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let isReconnecting = false;
let onNewClient = null;
let currentClientRef = null;
let latestQr = null;

// Latest pending QR string (null once authenticated) — served at /qr for headless login.
export function getLatestQr() {
  return latestQr;
}

export async function detectBrowser() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    try { await fsp.access(envPath); return envPath; } catch {}
  }
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const isAndroid = process.platform === 'linux' && process.arch === 'arm64';
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    ...(isWin ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ] : []),
    ...(isMac ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ] : []),
    ...(isAndroid ? [
      '/data/data/com.termux/files/usr/bin/chromium',
      '/data/data/com.termux/files/usr/bin/chromium-browser',
    ] : []),
  ];
  for (const c of candidates) {
    try { await fsp.access(c); return c; } catch {}
  }
  return null;
}

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
      logger.info('Puppeteer', `Using browser (from env): ${envPath}`);
      return { headless: true, executablePath: envPath, args: baseArgs };
    } catch {}
  }

  const detected = await detectBrowser();
  if (detected) {
    logger.info('Puppeteer', `Using browser: ${detected}`);
    return { headless: true, executablePath: detected, args: baseArgs };
  }

  // Android/Termux: try 'which chromium' before giving up
  if (process.platform === 'linux' && process.arch === 'arm64') {
    try {
      const { stdout } = await execAsync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null');
      const p = stdout?.trim();
      if (p) {
        logger.info('Puppeteer', `Using Chromium: ${p}`);
        return { headless: true, executablePath: p, args: baseArgs };
      }
    } catch {}
    logger.error('Puppeteer', 'Chromium tidak ditemukan. Install: pkg install chromium');
    throw new Error('Chromium not found for Termux/Android. Run: pkg install chromium');
  }
  logger.info('Puppeteer', 'No local browser found, using puppeteer default');
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
    latestQr = qr;
    console.log('\n[WA] Scan QR code ini dengan WhatsApp Anda (atau buka /qr di browser):');
    qrcode.generate(qr, { small: true });
  });

  c.on('authenticated', () => {
    latestQr = null;
    logger.info('WA', 'Authenticated');
  });

  c.on('ready', () => {
    latestQr = null;
    reconnectAttempt = 0;
    isReconnecting = false;
    logger.info('WA', 'Client ready');
  });

  c.on('auth_failure', (msg) => {
    logger.error('WA', 'Auth failure:', msg);
  });

  c.on('disconnected', async (reason) => {
    if (isReconnecting) return;
    logger.warn('WA', `Disconnected: ${reason}`);
    if (reason === 'LOGOUT') {
      logger.warn('WA', 'Manual logout detected — NOT reconnecting');
      return;
    }
    reconnect(c);
  });

  return c;
}

async function reconnect(oldClient) {
  if (isReconnecting) return;
  isReconnecting = true;

  try { await oldClient.destroy().catch(() => {}); } catch {}

  while (reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempt++;
    const delay = calcDelay(reconnectAttempt);
    logger.warn('WA', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);

    await new Promise(resolve => { reconnectTimer = setTimeout(resolve, delay); });

    try {
      const newClient = await createClientCore();
      client = newClient;
      currentClientRef = newClient;
      if (onNewClient) onNewClient(newClient);
      const initPromise = newClient.initialize();
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('init timeout')), 45000));
      await Promise.race([initPromise, timeout]).catch(e => {
        logger.error('WA', `Reconnect init issue:`, e.message);
        // Don't throw — init might complete later after QR scan
      });
      isReconnecting = false;
      return;
    } catch (e) {
      logger.error('WA', `Reconnect attempt ${reconnectAttempt} failed:`, e.message);
    }
  }

  logger.error('WA', `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Exiting.`);
  isReconnecting = false;
  process.exit(1);
}

export async function createClient(setupHandler) {
  if (client) return client;
  onNewClient = setupHandler || null;
  client = await createClientCore();
  currentClientRef = client;
  return client;
}

export function getCurrentClient() {
  return currentClientRef;
}
