import ww from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from './utils/logger.js';
const { Client, LocalAuth } = ww;

const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_DELAY = 5000;
const MAX_DELAY = 300000;

let client = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let isReconnecting = false;
let activeReconnectPromise = null;
let reconnectGen = 0;
let onNewClient = null;
let onMaxReconnect = null;
let currentClientRef = null;
let latestQr = null;
let connectionState = 'init'; // init | connecting | authenticated | ready | failed

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
      '/data/data/com.termux/files/usr/bin/google-chrome',
      '/data/data/com.termux/files/usr/bin/google-chrome-stable',
    ] : []),
  ];
  for (const c of candidates) {
    try { await fsp.access(c); return c; } catch {}
  }
  // Scan PATH directories for chromium executables
  const pathSep = process.platform === 'win32' ? ';' : ':';
const pathDirs = (process.env.PATH || '').split(pathSep);
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    for (const dir of pathDirs) {
      if (!dir) continue;
      const full = `${dir}/${name}`;
      try { await fsp.access(full); return full; } catch {}
    }
  }
  return null;
}

async function getPuppeteerConfig() {
  const isAndroid = process.platform === 'linux' && process.arch === 'arm64';
  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-features=LockProfileOnLaunch',
    '--disable-background-networking',
    '--disable-renderer-backgrounding',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    '--hide-scrollbars',
    '--disable-background-timer-throttling',
    ...(isAndroid ? ['--single-process', '--disable-software-rasterizer'] : []),
  ];

  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    try {
      await fsp.access(envPath);
      logger.info('Puppeteer', `Using browser (from env): ${envPath}`);
      return { headless: 'new', executablePath: envPath, args: baseArgs };
    } catch {}
  }

  const detected = await detectBrowser();
  if (detected) {
    logger.info('Puppeteer', `Using browser: ${detected}`);
    return { headless: 'new', executablePath: detected, args: baseArgs };
  }

  logger.error('Puppeteer', 'Chromium tidak ditemukan. Coba: pkg install chromium && which chromium, lalu set hasilnya di .env sebagai PUPPETEER_EXECUTABLE_PATH');
  throw new Error('Chromium/Chrome tidak ditemukan — set PUPPETEER_EXECUTABLE_PATH di .env');
}

function calcDelay(attempt) {
  const jitter = Math.random() * 1000;
  return Math.min(BASE_DELAY * Math.pow(2, attempt - 1) + jitter, MAX_DELAY);
}

function cleanupLockfiles() {
  const sessionDir = path.resolve('./wa-session/session');

  // 1. Kill orphaned processes on Linux by reading SingletonLock first
  if (process.platform === 'linux') {
    const killPidFromLock = (lockPath) => {
      try {
        if (fs.existsSync(lockPath)) {
          const stats = fs.lstatSync(lockPath);
          let pid = null;
          if (stats.isSymbolicLink()) {
            const target = fs.readlinkSync(lockPath);
            const parts = target.split('-');
            pid = parseInt(parts[parts.length - 1], 10);
          } else {
            const content = fs.readFileSync(lockPath, 'utf8').trim();
            const parts = content.split('\n')[0].split(' ');
            pid = parseInt(parts[0], 10);
          }
          if (pid && !isNaN(pid) && pid > 0) {
            execSync(`kill -9 ${pid} 2>/dev/null`);
            logger.info('WA', `Killed orphaned Chrome process (PID: ${pid})`);
            return true;
          }
        }
      } catch {}
      return false;
    };

    const killedRoot = killPidFromLock(path.join(sessionDir, 'SingletonLock'));
    const killedDef = killPidFromLock(path.join(sessionDir, 'Default', 'SingletonLock'));

    // Fallback: safe pkill -f matching wa-session
    if (!killedRoot && !killedDef) {
      try {
        execSync('pkill -f "chrome.*wa-session" 2>/dev/null; pkill -f "chromium.*wa-session" 2>/dev/null');
      } catch {}
    }
  }

  // 2. Clean lock files
  const files = ['lockfile', 'SingletonLock', 'SingletonSocket', 'DevToolsActivePort'];
  for (const f of files) {
    const fp = path.join(sessionDir, f);
    try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); logger.info('WA', `Cleaned stale: ${f}`); } } catch {}
  }
  // Clean Default/ lock files
  const defDir = path.join(sessionDir, 'Default');
  for (const f of ['LOCK', 'SingletonLock', 'SingletonSocket', 'DevToolsActivePort']) {
    const fp = path.join(defDir, f);
    try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); logger.info('WA', `Cleaned stale: Default/${f}`); } } catch {}
  }
}

async function createClientCore() {
  cleanupLockfiles();
  const puppeteerConfig = await getPuppeteerConfig();

  const sessionPath = path.resolve('./wa-session/session');
  const hasSession = fs.existsSync(sessionPath);
  logger.info('WA', hasSession ? 'Session tersimpan — auth otomatis' : 'Scan QR code untuk login pertama');

  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
    puppeteer: puppeteerConfig,
  });

  connectionState = 'connecting';

  c.on('qr', (qr) => {
    latestQr = qr;
    logger.info('WA', 'Scan QR code (atau buka /qr di browser)');
    if (process.env.LOG_CONSOLE !== 'false') {
      qrcode.generate(qr, { small: true });
    }
  });

  c.on('authenticated', () => {
    latestQr = null;
    connectionState = 'authenticated';
    logger.info('WA', 'Authenticated');
  });

  c.on('ready', () => {
    latestQr = null;
    connectionState = 'ready';
    reconnectAttempt = 0;
    isReconnecting = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    logger.info('WA', 'Client ready');
  });

  c.on('auth_failure', (msg) => {
    connectionState = 'failed';
    logger.error('WA', 'Auth failure:', msg);
  });

  c.on('disconnected', async (reason) => {
    connectionState = 'disconnected';
    if (isReconnecting) return;
    logger.warn('WA', `Disconnected: ${reason}`);
    if (reason === 'LOGOUT') {
      logger.warn('WA', 'Manual logout detected — NOT reconnecting');
      return;
    }
    reconnect(c).catch(() => {});
  });

  return c;
}

async function reconnect(oldClient) {
  if (activeReconnectPromise) return activeReconnectPromise;

  activeReconnectPromise = (async () => {
    isReconnecting = true;
    reconnectGen++;
    const myGen = reconnectGen;

    try { await oldClient.destroy().catch(() => {}); } catch {}

    while (reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
      if (myGen !== reconnectGen) return;

      reconnectAttempt++;
      const delay = calcDelay(reconnectAttempt);
      logger.warn('WA', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);

      await new Promise(resolve => { reconnectTimer = setTimeout(resolve, delay); });

      if (myGen !== reconnectGen) return;

      try {
        const newClient = await createClientCore();

        if (myGen !== reconnectGen) {
          try { await newClient.destroy().catch(() => {}); } catch {}
          return;
        }

        client = newClient;
        currentClientRef = newClient;
        if (onNewClient) onNewClient(newClient);

        const initPromise = newClient.initialize();
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('init timeout')), 60000));
        await Promise.race([initPromise, timeout]).catch(e => {
          if (myGen === reconnectGen) {
            logger.error('WA', `Reconnect init failed:`, e.message);
          }
        });

        if (myGen !== reconnectGen) {
          try { await newClient.destroy().catch(() => {}); } catch {}
          return;
        }

        return;
      } catch (e) {
        if (myGen !== reconnectGen) return;
        logger.error('WA', `Reconnect attempt ${reconnectAttempt} failed:`, e.message);
      }
    }

    logger.error('WA', `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`);
    if (typeof onMaxReconnect === 'function') {
      onMaxReconnect();
    } else {
      process.exit(1);
    }
  })();

  try {
    await activeReconnectPromise;
  } finally {
    activeReconnectPromise = null;
    isReconnecting = false;
  }
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

export function setOnMaxReconnect(fn) {
  onMaxReconnect = fn;
}

export function getConnectionState() {
  return connectionState;
}

let lastMonitorState = '';
export function startConnectionMonitor(intervalMs = 60000) {
  return setInterval(() => {
    const state = connectionState;
    const client = getCurrentClient();
    const wid = client?.info?.wid?.user;
    const now = `${state}|${wid || ''}`;
    if (now !== lastMonitorState) {
      logger.info('WA', state === 'ready' ? `✓ ${wid || ''}` : `${state}`);
      lastMonitorState = now;
    }
    if (state === 'failed' || state === 'disconnected' || (state === 'connecting' && !wid)) {
      logger.warn('WA', `reconnecting (${state})`);
      lastMonitorState = now;
      if (client && !isReconnecting) {
        reconnect(client).catch(() => {});
      }
    }
  }, intervalMs);
}

export async function initWithRetry(initialClient, maxAttempts = 20) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await Promise.race([
        initialClient.initialize(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('init timeout')), 60000)),
      ]);
      return;
    } catch (e) {
      logger.error('WA', `Init attempt ${attempt}/${maxAttempts} failed:`, e.message || 'unknown');
      if (attempt >= maxAttempts) throw e;
      const delay = Math.min(5000 * Math.pow(2, attempt - 1) + Math.random() * 1000, 300000);
      logger.warn('WA', `Retrying init in ${Math.round(delay / 1000)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
