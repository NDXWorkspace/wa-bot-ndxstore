import { execSync } from 'child_process';
import ww from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { logger } from './utils/logger.js';
import { config } from './config.js';
const { Client, LocalAuth } = ww;

const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_DELAY = 5000;
const MAX_DELAY = 300000;
const RECONNECT_COOLDOWN_MS = 120000; // 2 menit cooldown antar siklus

let client = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let activeReconnectPromise = null;
let reconnectGen = 0;
let onNewClient = null;
let onReadyCallback = null;
let onMaxReconnect = null;
let currentClientRef = null;
let latestQr = null;
let latestPairingCode = null;
let latestPairingCodeTs = 0;
let runtimePairingNumber = config.pairingNumber || '';
let connectionState = 'init';
let wasReady = false;
let pairingLock = null;

// ─── Login watchdog — anti hang sunyi ────────────────────────────────────
// Kalau WA Web tidak menerbitkan event qr/code/authenticated SAMA SEKALI
// dalam masa tenggang (mis. halaman macet), initWithRetry/monitor tidak akan
// bereaksi (mereka hanya retry saat init GAGAL / setelah pernah ready).
// Watchdog ini memicu re-init otomatis agar bot tidak diam selamanya.
let lastLoginEventTs = Date.now();
let loginWatchdogTimer = null;
const LOGIN_GRACE_MS = 4 * 60 * 1000;

export function triggerReconnect() {
  const c = getCurrentClient();
  if (c && !activeReconnectPromise) {
    reconnectAttempt = 0;
    reconnect(c).catch(() => {});
  }
}

export function startLoginWatchdog() {
  stopLoginWatchdog();
  logger.info('WA', 'Watchdog login aktif (re-init otomatis jika tanpa qr/code 4 menit).');
  loginWatchdogTimer = setTimeout(() => {
    loginWatchdogTimer = null;
    const c = getCurrentClient();
    if (c?.info?.wid?.user || wasReady) return; // sudah auth/ready — aman
    if (Date.now() - lastLoginEventTs < LOGIN_GRACE_MS) {
      startLoginWatchdog(); // ada progress (qr/code refresh) — perpanjang
      return;
    }
    logger.error('WA', 'Login hang: tanpa event qr/code selama 4 menit — re-init otomatis...');
    triggerReconnect();
    startLoginWatchdog();
  }, LOGIN_GRACE_MS + 30000);
  if (loginWatchdogTimer.unref) loginWatchdogTimer.unref();
}

export function stopLoginWatchdog() {
  if (loginWatchdogTimer) {
    clearTimeout(loginWatchdogTimer);
    loginWatchdogTimer = null;
  }
}

export function getLatestQr() {
  return latestQr;
}

// Pairing code login (alternatif scan QR). Kode 8 karakter, refresh otomatis
// tiap ±3 menit oleh whatsapp-web.js. Berlaku saat PAIRING_NUMBER diisi dan
// belum ada sesi tersimpan.
export function getLatestPairingCode() {
  if (!latestPairingCode) return null;
  return { code: latestPairingCode, generatedAt: latestPairingCodeTs, phoneNumber: runtimePairingNumber || null };
}

export function getLoginDetails() {
  const c = getCurrentClient();
  const wid = c?.info?.wid?.user || null;
  const pushname = c?.info?.pushname || null;
  return {
    state: wid ? 'ready' : connectionState,
    connected: Boolean(wid),
    waNumber: wid,
    waName: pushname,
    qr: wid ? null : latestQr,
    pairingCode: wid ? null : latestPairingCode,
    pairingNumber: runtimePairingNumber || null,
    pairingGeneratedAt: latestPairingCodeTs || null,
  };
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
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const pathDirs = (process.env.PATH || '').split(pathSep);
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    for (const dir of pathDirs) {
      if (!dir) continue;
      const full = path.join(dir, name);
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
    '--enable-features=NetworkService,NetworkServiceInProcess',
    ...(isAndroid ? ['--single-process', '--disable-software-rasterizer', '--disable-features=PartitionConnections'] : []),
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

  logger.error('Puppeteer', 'Chromium tidak ditemukan. Coba: pkg install chromium && which chromium, lalu set hasilnya di .env sebagai PUPPETEER_EXECUTABLE_PATH');
  throw new Error('Chromium/Chrome tidak ditemukan — set PUPPETEER_EXECUTABLE_PATH di .env');
}

function calcDelay(attempt) {
  const jitter = Math.random() * 1000;
  return Math.min(BASE_DELAY * Math.pow(2, attempt - 1) + jitter, MAX_DELAY);
}

function cleanupLockfiles() {
  const sessionDir = path.resolve('./wa-session/session');

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
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
            logger.info('WA', `Killed orphaned Chrome process (PID: ${pid})`);
            return true;
          }
        }
      } catch {}
      return false;
    };

    const killedRoot = killPidFromLock(path.join(sessionDir, 'SingletonLock'));
    const killedDef = killPidFromLock(path.join(sessionDir, 'Default', 'SingletonLock'));

    if (!killedRoot && !killedDef) {
      try {
        execSync('pkill -f "chrome.*wa-session" 2>/dev/null; pkill -f "chromium.*wa-session" 2>/dev/null');
      } catch {}
    }
  }

  const files = ['lockfile', 'SingletonLock', 'SingletonSocket', 'DevToolsActivePort'];
  for (const f of files) {
    const fp = path.join(sessionDir, f);
    try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); logger.info('WA', `Cleaned stale: ${f}`); } } catch {}
  }
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
  const activePairNum = runtimePairingNumber || config.pairingNumber || '';
  logger.info('WA', hasSession ? 'Session tersimpan — auth otomatis'
    : activePairNum ? `Login via kode pairing untuk ${activePairNum}`
    : 'Scan QR code untuk login pertama');

  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
    puppeteer: puppeteerConfig,
    // Pairing-code login: kalau nomor pairing aktif, WA Web memakai kode
    // 8 karakter (event 'code') sebagai pengganti QR. Tanpa ini → QR biasa.
    ...(activePairNum
      ? { pairWithPhoneNumber: { phoneNumber: activePairNum, showNotification: true } }
      : {}),
  });

  connectionState = 'connecting';
  lastLoginEventTs = Date.now();
  startLoginWatchdog();

  c.on('qr', (qr) => {
    latestQr = qr;
    lastLoginEventTs = Date.now();
    logger.info('WA', 'Scan QR code (atau buka /qr di browser)');
    if (process.env.LOG_CONSOLE !== 'false') {
      qrcode.generate(qr, { small: true });
    }
  });

  c.on('code', (code) => {
    latestPairingCode = code;
    latestPairingCodeTs = Date.now();
    lastLoginEventTs = Date.now();
    const pretty = String(code).replace(/(.{4})(.{4})/, '$1-$2');
    logger.info('WA', `Pairing code: ${pretty} — masukkan di WA → Perangkat Tertaut → Tautkan dgn nomor telepon (atau buka /qr / panel /admin)`);
  });

  c.on('authenticated', () => {
    latestQr = null;
    latestPairingCode = null;
    lastLoginEventTs = Date.now();
    stopLoginWatchdog();
    connectionState = 'authenticated';
    logger.info('WA', 'Authenticated');
  });

  c.on('ready', () => {
    latestQr = null;
    latestPairingCode = null;
    lastLoginEventTs = Date.now();
    stopLoginWatchdog();
    connectionState = 'ready';
    wasReady = true;
    reconnectAttempt = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    logger.info('WA', 'Client ready');
    if (onReadyCallback) onReadyCallback(c);
  });

  c.on('auth_failure', (msg) => {
    connectionState = 'failed';
    logger.error('WA', 'Auth failure:', msg);
  });

  c.on('disconnected', async (reason) => {
    connectionState = 'disconnected';
    logger.warn('WA', `Disconnected: ${reason}`);
    if (reason === 'LOGOUT') {
      logger.warn('WA', 'Manual logout detected — NOT reconnecting');
      return;
    }
    if (!activeReconnectPromise) {
      reconnect(c).catch(() => {});
    }
  });

  return c;
}

async function reconnect(oldClient) {
  if (activeReconnectPromise) return activeReconnectPromise;

  activeReconnectPromise = (async () => {
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
        let initTimer;
        const timeout = new Promise((_, reject) => {
          initTimer = setTimeout(() => reject(new Error('init timeout')), 60000);
        });
        try {
          await Promise.race([initPromise, timeout]);
        } catch (e) {
          if (myGen === reconnectGen) {
            logger.error('WA', `Reconnect init failed:`, e.message?.slice(0, 120));
          }
          try { await newClient.destroy().catch(() => {}); } catch {}
          throw e;
        } finally {
          clearTimeout(initTimer);
        }

        if (myGen !== reconnectGen) {
          try { await newClient.destroy().catch(() => {}); } catch {}
          return;
        }

        reconnectAttempt = 0;
        return;
      } catch (e) {
        if (myGen !== reconnectGen) return;
        logger.error('WA', `Reconnect attempt ${reconnectAttempt} failed:`, e.message);
      }
    }

    // Max attempts — tunggu cooldown before next cycle
    logger.error('WA', `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Cooldown ${RECONNECT_COOLDOWN_MS / 1000}s.`);
    await new Promise(r => setTimeout(r, RECONNECT_COOLDOWN_MS));
    reconnectAttempt = 0;

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

export function setOnReady(fn) {
  onReadyCallback = fn;
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

    // Hanya reconnect kalo pernah ready sebelumnya (bukan initial startup)
    if (!wasReady) return;

    if (state === 'failed' || state === 'disconnected' || (state === 'connecting' && !wid)) {
      logger.warn('WA', `reconnecting (${state})`);
      lastMonitorState = now;
      if (client && !activeReconnectPromise) {
        reconnect(client).catch(() => {});
      }
    }
  }, intervalMs);
}

export async function initWithRetry(initialClient, maxAttempts = 20) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let initTimer;
      await Promise.race([
        initialClient.initialize(),
        new Promise((_, reject) => {
          initTimer = setTimeout(() => reject(new Error('init timeout')), 60000);
        }),
      ]).finally(() => clearTimeout(initTimer));
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

export function normalizePairingNumber(raw) {
  let digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  else if (digits.startsWith('8') && digits.length >= 9 && digits.length <= 13) digits = '62' + digits;
  if (digits.length < 9 || digits.length > 16) return '';
  return digits;
}

async function restartClientFresh(clearSessionDir = false) {
  reconnectGen++;
  const myGen = reconnectGen;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const old = currentClientRef;
  if (old) {
    try { await old.destroy().catch(() => {}); } catch {}
  }
  if (clearSessionDir) {
    cleanupLockfiles();
    const sessRoot = path.resolve('./wa-session');
    try {
      await fsp.rm(sessRoot, { recursive: true, force: true });
      logger.info('WA', 'Session folder ./wa-session dihapus bersih');
    } catch (e) {
      logger.warn('WA', 'Gagal hapus folder session:', e.message);
    }
  }
  latestQr = null;
  latestPairingCode = null;
  latestPairingCodeTs = 0;
  wasReady = false;
  connectionState = 'connecting';

  const newClient = await createClientCore();
  if (myGen !== reconnectGen) {
    try { await newClient.destroy().catch(() => {}); } catch {}
    return null;
  }
  client = newClient;
  currentClientRef = newClient;
  if (onNewClient) onNewClient(newClient);

  newClient.initialize().catch((e) => {
    logger.error('WA', 'Fresh client init error:', e.message?.slice(0, 120));
  });
  return newClient;
}

export async function requestDynamicPairingCode(rawPhone) {
  const cleanPhone = normalizePairingNumber(rawPhone);
  if (!cleanPhone) {
    throw new Error('Nomor WhatsApp tidak valid (contoh: 081234567890 atau 6281234567890)');
  }

  if (pairingLock) return pairingLock;

  pairingLock = (async () => {
    try {
      const c = getCurrentClient();
      const alreadyConnected = Boolean(c?.info?.wid?.user);

      // Jika sudah pakai nomor yang sama dan kode masih baru (<2 menit), kembalikan langsung
      if (!alreadyConnected && runtimePairingNumber === cleanPhone && latestPairingCode && (Date.now() - latestPairingCodeTs < 120000)) {
        return { code: latestPairingCode, phoneNumber: cleanPhone, generatedAt: latestPairingCodeTs };
      }

      runtimePairingNumber = cleanPhone;
      latestPairingCode = null;
      latestPairingCodeTs = 0;

      // Coba minta pairing code langsung di page aktif tanpa restart browser jika memungkinkan
      if (!alreadyConnected && c?.pupPage && !c.pupPage.isClosed()) {
        try {
          logger.info('WA', `Meminta kode pairing langsung untuk ${cleanPhone}...`);
          let directTimer;
          const directCode = await Promise.race([
            c.requestPairingCode(cleanPhone, true, 180000),
            new Promise((_, rej) => {
              directTimer = setTimeout(() => rej(new Error('direct pairing timeout')), 12000);
            }),
          ]).finally(() => clearTimeout(directTimer));

          if (directCode && typeof directCode === 'string' && directCode.length >= 6) {
            latestPairingCode = directCode;
            latestPairingCodeTs = Date.now();
            lastLoginEventTs = Date.now();
            logger.info('WA', `Kode pairing berhasil dibuat untuk ${cleanPhone}: ${directCode}`);
            return { code: directCode, phoneNumber: cleanPhone, generatedAt: latestPairingCodeTs };
          }
        } catch (e) {
          logger.info('WA', `Direct requestPairingCode gagal (${e.message}), re-init dengan pairWithPhoneNumber...`);
        }
      }

      // Jika sudah login ke akun lain atau page belum siap, restart client dengan nomor baru
      await restartClientFresh(alreadyConnected);

      // Tunggu sampai event 'code' muncul (maks 25 detik)
      const startWait = Date.now();
      while (Date.now() - startWait < 25000) {
        if (latestPairingCode) {
          return { code: latestPairingCode, phoneNumber: cleanPhone, generatedAt: latestPairingCodeTs };
        }
        await new Promise(r => setTimeout(r, 500));
      }

      return {
        code: latestPairingCode || null,
        phoneNumber: cleanPhone,
        pending: !latestPairingCode,
        message: 'Sedang menyiapkan sesi WhatsApp, kode pairing akan muncul dalam beberapa detik.',
      };
    } finally {
      pairingLock = null;
    }
  })();

  return pairingLock;
}

export async function switchToQrMode() {
  runtimePairingNumber = '';
  latestPairingCode = null;
  latestPairingCodeTs = 0;
  const c = getCurrentClient();
  const alreadyConnected = Boolean(c?.info?.wid?.user);
  if (!alreadyConnected && latestQr) {
    return { qr: latestQr, pending: false };
  }
  await restartClientFresh(alreadyConnected);
  const startWait = Date.now();
  while (Date.now() - startWait < 15000) {
    if (latestQr) return { qr: latestQr, pending: false };
    await new Promise(r => setTimeout(r, 500));
  }
  return { qr: latestQr || null, pending: !latestQr };
}

export async function logoutAndResetWa() {
  runtimePairingNumber = '';
  const c = getCurrentClient();
  if (c) {
    try { await c.logout().catch(() => {}); } catch {}
  }
  await restartClientFresh(true);
  return { ok: true };
}
