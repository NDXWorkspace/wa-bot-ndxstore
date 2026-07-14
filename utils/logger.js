const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

const COLORS = {
  error: '31',  // red
  warn: '33',   // yellow
  info: '36',   // cyan
  debug: '90',  // gray
};

function color(level, text) {
  const c = COLORS[level] || '0';
  return `\x1b[${c}m${text}\x1b[0m`;
}

function ts() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function log(level, label, ...args) {
  if (LOG_LEVELS[level] > CURRENT_LEVEL) return;
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = color(level, `[${ts()}] [${level.toUpperCase()}]`) + ` [${color('info', label)}] ${msg}`;
  console.log(line);
}

export const logger = {
  error: (label, ...args) => log('error', label, ...args),
  warn: (label, ...args) => log('warn', label, ...args),
  info: (label, ...args) => log('info', label, ...args),
  debug: (label, ...args) => log('debug', label, ...args),
};
