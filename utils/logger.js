import { getFileTransport, closeAll } from './logTransport.js';

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
const LOG_FORMAT = (process.env.LOG_FORMAT || 'text').toLowerCase();
const useJson = LOG_FORMAT === 'json';

const COLORS = {
  error: '31',
  warn: '33',
  info: '36',
  debug: '90',
};

const MAX_LINE = 2000;
const SAMPLE_RATE = 10;

const throttleCache = new Map();
const sampleCounters = new Map();

let fileTransport = null;
let errorTransport = null;
let fileEnabled = true;

try {
  fileTransport = getFileTransport('app');
  errorTransport = getFileTransport('error');
} catch {
  fileEnabled = false;
}

export function setLogLevel(level) {
  const num = LOG_LEVELS[level];
  if (num !== undefined) {
    CURRENT_LEVEL = num;
    return true;
  }
  return false;
}

export function getLogLevel() {
  for (const [k, v] of Object.entries(LOG_LEVELS)) {
    if (v === CURRENT_LEVEL) return k;
  }
  return 'info';
}

function color(level, text) {
  const c = COLORS[level] || '0';
  return `\x1b[${c}m${text}\x1b[0m`;
}

function ts() {
  const d = new Date();
  const date = useJson || process.env.LOG_DATE ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ` : '';
  return `${date}${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function formatArg(arg) {
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
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
  if (level !== 'debug') return true;
  if (CURRENT_LEVEL > LOG_LEVELS.debug) {
    const counter = (sampleCounters.get('debug') || 0) + 1;
    sampleCounters.set('debug', counter);
    if (counter % SAMPLE_RATE !== 0) return false;
  }
  return true;
}

function log(level, label, ...args) {
  if (LOG_LEVELS[level] > CURRENT_LEVEL) return;
  if (!shouldSample(level)) return;

  const formatted = args.map(formatArg).join(' ');
  const time = ts();

  const paddedLabel = label.padEnd(12).slice(0, 12);

  if (useJson) {
    const entry = JSON.stringify({
      time,
      level,
      label,
      msg: truncate(formatted, 2000),
      pid: process.pid,
    });
    console.log(entry);
    return;
  }

  const coloredLevel = color(level, `[${time}] [${level.toUpperCase()}]`);
  const coloredLabel = color('info', `[${paddedLabel}]`);
  const line = `${coloredLevel} ${coloredLabel} ${truncate(formatted, MAX_LINE)}`;
  console.log(line);

  if (fileEnabled && fileTransport) {
    const plain = `[${time}] [${level.toUpperCase()}] [${label}] ${truncate(formatted, 5000)}`;
    fileTransport.write(plain);
    if (level === 'error') errorTransport.write(plain);
  }
}

const throttleTimers = new Map();

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

export const logger = {
  error: (label, ...args) => log('error', label, ...args),
  warn: (label, ...args) => log('warn', label, ...args),
  info: (label, ...args) => log('info', label, ...args),
  debug: (label, ...args) => log('debug', label, ...args),
};

export function closeLogger() {
  closeAll();
}
