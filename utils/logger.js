import { getFileTransport, closeAll } from './logTransport.js';

/* ─── Log levels ──────────────────────────────────────────── */
const LOG_LEVELS = { fatal: 4, error: 3, warn: 2, info: 1, debug: 0, trace: -1 };
let CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
const LOG_FORMAT = (process.env.LOG_FORMAT || 'text').toLowerCase();
const useJson = LOG_FORMAT === 'json';
const COLORIZE = process.env.LOG_COLOR !== 'false';

/* ─── ANSI color map ──────────────────────────────────────── */
const COLORS = {
  fatal: '1;31',
  error: '31',
  warn: '33',
  info: '36',
  debug: '90',
  trace: '2;37',
};

const SYMBOLS = {
  fatal: '!!',
  error: '✗',
  warn: '⚠',
  info: '•',
  debug: '›',
  trace: '·',
};

/* ─── Limits & sampling ───────────────────────────────────── */
const MAX_LINE = 2000;
const SAMPLE_RATE = parseInt(process.env.LOG_SAMPLE_RATE || '10', 10);
const sampleCounters = new Map();

/* ─── File transports ─────────────────────────────────────── */
let fileTransport = null;
let errorTransport = null;
let traceTransport = null;
let fileEnabled = true;

try {
  fileTransport = getFileTransport('app');
  errorTransport = getFileTransport('error');
  traceTransport = getFileTransport('trace');
} catch {
  fileEnabled = false;
}

/* ─── Alert webhook (Discord / Telegram / generic) ────────── */
const ALERT_WEBHOOK = process.env.LOG_ALERT_WEBHOOK || '';
let alertCooldown = 0;

async function sendAlert(level, label, message) {
  if (!ALERT_WEBHOOK) return;
  const now = Date.now();
  if (now - alertCooldown < 30000) return;
  alertCooldown = now;
  const payload = { level, label, message, time: new Date().toISOString(), pid: process.pid };
  try {
    await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {}
}

/* ─── Helpers ─────────────────────────────────────────────── */
export function setLogLevel(level) {
  const num = LOG_LEVELS[level];
  if (num !== undefined) { CURRENT_LEVEL = num; return true; }
  return false;
}

export function getLogLevel() {
  for (const [k, v] of Object.entries(LOG_LEVELS)) {
    if (v === CURRENT_LEVEL) return k;
  }
  return 'info';
}

function color(level, text) {
  if (!COLORIZE) return text;
  const c = COLORS[level] || '0';
  return `\x1b[${c}m${text}\x1b[0m`;
}

function ts() {
  const d = new Date();
  const date = useJson || process.env.LOG_DATE
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
    : '';
  return `${date}${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function tsISO() {
  return new Date().toISOString();
}

function formatArg(arg) {
  if (arg instanceof Error) {
    const stack = arg.stack || `${arg.name}: ${arg.message}`;
    return stack.split('\n').slice(0, 12).join('\n');
  }
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg === 'object') {
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }
  return String(arg);
}

function truncate(msg, maxLen) {
  if (!msg || msg.length <= maxLen) return msg || '';
  return msg.slice(0, maxLen) + '...';
}

function shouldSample(level) {
  if (level !== 'trace' && level !== 'debug') return true;
  const key = level;
  if (CURRENT_LEVEL > LOG_LEVELS[level]) return false;
  if (SAMPLE_RATE > 0) {
    const counter = (sampleCounters.get(key) || 0) + 1;
    sampleCounters.set(key, counter);
    if (counter % SAMPLE_RATE !== 0) return false;
  }
  return true;
}

function extractMeta(args) {
  if (args.length === 0) return { meta: null, rest: args };
  const last = args[args.length - 1];
  if (last && typeof last === 'object' && !(last instanceof Error) && !Array.isArray(last)) {
    return { meta: last, rest: args.slice(0, -1) };
  }
  return { meta: null, rest: args };
}

/* ─── Core log function ───────────────────────────────────── */
function log(level, label, ...args) {
  if (LOG_LEVELS[level] > CURRENT_LEVEL) return;
  if (!shouldSample(level)) return;

  const { meta, rest } = extractMeta(args);
  const formatted = rest.map(formatArg).join(' ');
  const time = ts();
  const paddedLabel = (label || '').padEnd(8).slice(0, 8);

  /* JSON format */
  if (useJson) {
    const entry = JSON.stringify({
      time, level, label,
      msg: truncate(formatted, 2000),
      ...(meta ? { meta } : {}),
      pid: process.pid,
    });
    console.log(entry);
    return;
  }

  /* Console */
  if (process.env.LOG_CONSOLE !== 'false') {
    const sym = SYMBOLS[level] || '?';
    const metaStr = meta ? ` ${color('trace', JSON.stringify(meta))}` : '';
    const line = `${color(level, sym)} ${color(level, `[${paddedLabel}]`)} ${truncate(formatted, MAX_LINE)}${metaStr}`;
    console.log(line);
  }

  /* File transport */
  if (fileEnabled && fileTransport) {
    const plain = `[${time}] [${level.toUpperCase()}] [${label}] ${truncate(formatted, 5000)}`;
    fileTransport.write(plain);
    if (level === 'error' || level === 'fatal') {
      errorTransport.write(plain);
    }
    if (level === 'trace') {
      traceTransport.write(plain);
    }
  }

  /* Alert webhook for critical levels */
  if ((level === 'fatal' || level === 'error') && ALERT_WEBHOOK) {
    sendAlert(level, label, truncate(formatted, 1000));
  }
}

/* ─── Throttle ────────────────────────────────────────────── */
const throttleTimers = new Map();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, last] of throttleTimers) {
    if (now - last > 60000) throttleTimers.delete(key);
  }
  for (const [key, count] of sampleCounters) {
    if (count > 1000) sampleCounters.set(key, count % 100);
  }
}, 60000);
cleanupTimer.unref();

export function throttle(key, ms = 10000) {
  const now = Date.now();
  const last = throttleTimers.get(key);
  if (last && now - last < ms) return false;
  throttleTimers.set(key, now);
  return true;
}

export function throttleLog(level, label, key, msg, ms = 10000) {
  if (throttle(key, ms)) {
    log(level, label, msg);
  }
}

/* ─── Performance timers ──────────────────────────────────── */
const perfTimers = new Map();

function startTime(label) {
  const id = `${label}::${Math.random().toString(36).slice(2, 6)}`;
  perfTimers.set(id, { label, start: process.hrtime.bigint() });
  log('trace', 'Timer', `start: ${label} [${id}]`);
  return id;
}

function endTime(id) {
  const entry = perfTimers.get(id);
  if (!entry) return;
  perfTimers.delete(id);
  const elapsed = Number(process.hrtime.bigint() - entry.start) / 1e6;
  const label = `${entry.label} [${id.slice(-4)}]`;
  log('debug', 'Timer', `${label} — ${elapsed.toFixed(2)}ms`);
  return elapsed;
}

/* ─── Health heartbeat ────────────────────────────────────── */
let healthInterval = null;

function startHeartbeat(intervalMs = 300000) {
  if (healthInterval) clearInterval(healthInterval);
  healthInterval = setInterval(() => {
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const uptime = process.uptime();
    const days = Math.floor(uptime / 86400);
    const hrs = Math.floor((uptime % 86400) / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    log('info', 'Health', `RSS ${rssMB}MB · Heap ${heapMB}MB · Up ${days}d ${hrs}h ${mins}m`);
  }, intervalMs);
  healthInterval.unref();
}

function stopHeartbeat() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

/* ─── Startup banner ──────────────────────────────────────── */
function printBanner() {
  const pkg = { name: 'wa-bot', version: '2.0.0' };
  const banner = `
 ╔═══════════════════════════════════════╗
 ║  ${(pkg.name || 'App').padEnd(35)} ║
 ║  v${(pkg.version || '').padEnd(34)} ║
 ║  PID: ${String(process.pid).padEnd(32)} ║
 ║  Node: ${process.version.padEnd(32)} ║
 ║  Time: ${tsISO().padEnd(32)} ║
 ║  Level: ${(getLogLevel() || 'info').padEnd(31)} ║
 ╚═══════════════════════════════════════╝`;
  console.log(color('info', banner));
}

/* ─── Public logger object ────────────────────────────────── */
export const logger = {
  fatal: (label, ...args) => log('fatal', label, ...args),
  error: (label, ...args) => log('error', label, ...args),
  warn: (label, ...args) => log('warn', label, ...args),
  info: (label, ...args) => log('info', label, ...args),
  debug: (label, ...args) => log('debug', label, ...args),
  trace: (label, ...args) => log('trace', label, ...args),

  time: (label) => startTime(label),
  timeEnd: (id) => endTime(id),

  startHeartbeat,
  stopHeartbeat,
  printBanner,
};

/* ─── Child logger factory ────────────────────────────────── */
export function createLogger(label) {
  return {
    fatal: (...args) => log('fatal', label, ...args),
    error: (...args) => log('error', label, ...args),
    warn: (...args) => log('warn', label, ...args),
    info: (...args) => log('info', label, ...args),
    debug: (...args) => log('debug', label, ...args),
    trace: (...args) => log('trace', label, ...args),
    time: (lbl) => startTime(`${label}:${lbl}`),
    timeEnd: (id) => endTime(id),
    getLabel: () => label,
  };
}

/* ─── Close ───────────────────────────────────────────────── */
export function closeLogger() {
  stopHeartbeat();
  closeAll();
}
