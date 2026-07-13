const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, label, ...args) {
  if (LOG_LEVELS[level] > CURRENT_LEVEL) return;
  const ts = new Date().toISOString();
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  const line = `${ts} [${level.toUpperCase()}] [${label}] ${msg}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  error: (label, ...args) => log('error', label, ...args),
  warn: (label, ...args) => log('warn', label, ...args),
  info: (label, ...args) => log('info', label, ...args),
  debug: (label, ...args) => log('debug', label, ...args),
};
