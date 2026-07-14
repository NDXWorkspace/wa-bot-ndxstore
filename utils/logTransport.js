import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_DIR = process.env.LOG_DIR || './logs';
const MAX_DAYS = 7;
const CHECK_INTERVAL = 3600000;
const KEEP_FILES = 7;

export class RotatingFileTransport {
  constructor(prefix = 'app') {
    this.prefix = prefix;
    this.dir = LOG_DIR;
    this.stream = null;
    this.currentDate = '';
    this.lastCleanup = 0;
  }

  _getDate() {
    return new Date().toISOString().slice(0, 10);
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    } catch {}
  }

  _rotate() {
    const date = this._getDate();
    if (date === this.currentDate && this.stream) return;
    if (this.stream) {
      try { this.stream.end(); } catch {}
    }
    this.currentDate = date;
    this._ensureDir();
    const filePath = path.join(this.dir, `${this.prefix}-${date}.log`);
    try {
      this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    } catch {}
    this._cleanup();
  }

  _cleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < CHECK_INTERVAL) return;
    this.lastCleanup = now;
    try {
      if (!fs.existsSync(this.dir)) return;
      const files = fs.readdirSync(this.dir)
        .filter(f => f.startsWith(this.prefix + '-') && f.endsWith('.log'))
        .sort()
        .reverse();
      for (const f of files.slice(KEEP_FILES)) {
        try { fs.unlinkSync(path.join(this.dir, f)); } catch {}
      }
    } catch {}
  }

  write(line) {
    this._rotate();
    if (this.stream) {
      try { this.stream.write(line + '\n'); } catch {}
    }
  }

  close() {
    if (this.stream) {
      try { this.stream.end(); } catch {}
      this.stream = null;
    }
  }
}

const files = {};

export function getFileTransport(name) {
  if (!files[name]) files[name] = new RotatingFileTransport(name);
  return files[name];
}

export function closeAll() {
  for (const f of Object.values(files)) f.close();
}
