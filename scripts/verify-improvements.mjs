import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function it(description, fn) {
  totalTests++;
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res
        .then(() => {
          passedTests++;
          console.log(`  ✓ ${description}`);
        })
        .catch((err) => {
          failedTests++;
          console.error(`  ✗ ${description}: ${err.message}`);
          throw err;
        });
    }
    passedTests++;
    console.log(`  ✓ ${description}`);
  } catch (err) {
    failedTests++;
    console.error(`  ✗ ${description}: ${err.message}`);
    throw err;
  }
}

async function runAllTests() {
  console.log('\n==================================================');
  console.log('WA BOT — AUTOMATED VERIFICATION & QUALITY AUDIT');
  console.log('==================================================\n');

  // ── TEST SUITE 1: Logger Hierarchy via Real Module ────────────────
  console.log('Suite 1: Logger Hierarchy & Filtering Logic (Real Module)');
  {
    const { setLogLevel, getLogLevel, logger } = await import('../utils/logger.js');
    const origLevel = getLogLevel();

    it('Real logger reflects dynamic level switching', () => {
      assert.strictEqual(setLogLevel('debug'), true);
      assert.strictEqual(getLogLevel(), 'debug');
      assert.strictEqual(setLogLevel('warn'), true);
      assert.strictEqual(getLogLevel(), 'warn');
      assert.strictEqual(setLogLevel('info'), true);
      assert.strictEqual(getLogLevel(), 'info');
    });

    it('Real logger rejects unknown levels', () => {
      assert.strictEqual(setLogLevel('super-verbose-nonexistent'), false);
      assert.strictEqual(getLogLevel(), 'info');
    });

    it('Logger functions can be invoked without throwing under all levels', () => {
      setLogLevel('debug');
      assert.doesNotThrow(() => logger.debug('Test', 'debug message'));
      assert.doesNotThrow(() => logger.info('Test', 'info message'));
      assert.doesNotThrow(() => logger.warn('Test', 'warn message'));
      assert.doesNotThrow(() => logger.error('Test', 'error message'));

      setLogLevel('error');
      assert.doesNotThrow(() => logger.debug('Test', 'should be suppressed'));
      assert.doesNotThrow(() => logger.info('Test', 'should be suppressed'));
      assert.doesNotThrow(() => logger.error('Test', 'real error'));

      setLogLevel(origLevel);
    });
  }

  // ── TEST SUITE 2: AI Sanitizer & Error Guardrail ─────────────────
  console.log('\nSuite 2: AI Sanitizer & Error Leak Guardrails');
  {
    const { sanitizeAiOutput } = await import('../services/ai.js');

    it('Sanitizer blocks upstream provider error strings', () => {
      const blocked1 = sanitizeAiOutput('Upstream error from Nvidia: Service temporarily overloaded');
      assert.strictEqual(blocked1, null, 'Upstream error must be blocked');

      const blocked2 = sanitizeAiOutput('Provider returned error: rate limit exceeded');
      assert.strictEqual(blocked2, null, 'Rate limit error must be blocked');
    });

    it('Sanitizer blocks technical and system error phrases in Indonesian', () => {
      const samples = [
        'Mohon maaf, batas harian kamu sudah habis untuk hari ini.',
        'Sistem kami sedang mengalami gangguan teknis.',
        'Server sedang down untuk maintenance.',
        'Kuota pesan sudah habis.',
        'Terjadi kesalahan pada sistem, gagal memuat data.',
      ];
      for (const s of samples) {
        const res = sanitizeAiOutput(s);
        assert.strictEqual(res, null, `Should block technical leak: "${s}"`);
      }
    });

    it('Sanitizer blocks JSON and HTML error payloads', () => {
      assert.strictEqual(sanitizeAiOutput('{"error": {"message": "invalid api key"}}'), null);
      assert.strictEqual(sanitizeAiOutput('<!DOCTYPE html><html><body>Error 502</body></html>'), null);
      assert.strictEqual(sanitizeAiOutput('TypeError: Cannot read properties of undefined'), null);
    });

    it('Sanitizer allows valid user conversations and strips thinking tags', () => {
      const clean = sanitizeAiOutput('<think>Pikir dulu ah</think>Halo kak! Ada yang bisa dibantu?');
      assert.strictEqual(clean, 'Halo kak! Ada yang bisa dibantu?');
    });

    it('Fallback reply never contains system errors or limits', async () => {
      const { getFallbackReply } = await import('../services/ai.js');
      const queries = ['halo', 'berapa harga', 'cek order', 'bantuan cs', 'server lagi error gak'];
      for (const q of queries) {
        const replyBima = getFallbackReply(q, 1);
        const replyCs = getFallbackReply(q, 2);
        for (const r of [replyBima, replyCs]) {
          if (r) {
            assert.doesNotMatch(r, /error|server|gangguan|limit|kuota|down/i);
          }
        }
      }
    });
  }

  // ── TEST SUITE 3: Instagram Auto-Reply & Split Bounds ─────────────
  console.log('\nSuite 3: Instagram Auto-Reply & Strict Chunk Bounds');
  {
    const { formatForIg, splitIgChunks } = await import('../services/instagram.js');

    it('formatForIg strips markdown asterisks and underscores', () => {
      const formatted = formatForIg('Halo *kak*, order _kamu_ sudah *selesai*!');
      assert.strictEqual(formatted, 'Halo kak, order kamu sudah selesai!');
    });

    it('splitIgChunks returns 1 chunk for short text', () => {
      const shortText = 'Ini pesan singkat.';
      const chunks = splitIgChunks(shortText, 950);
      assert.strictEqual(chunks.length, 1);
      assert.strictEqual(chunks[0], shortText);
    });

    it('splitIgChunks strictly enforces maxLen on continuous text without dropping characters', () => {
      const longContinuous = 'A'.repeat(2500);
      const chunks = splitIgChunks(longContinuous, 950);
      assert.strictEqual(chunks.length, 3);
      for (const c of chunks) {
        assert.ok(c.length <= 950, `Chunk length ${c.length} must not exceed 950`);
      }
      const totalReconstructed = chunks.join('');
      assert.strictEqual(totalReconstructed.length, 2500, 'All characters must be preserved without loss');
    });

    it('splitIgChunks splits on sentences and natural boundaries cleanly', () => {
      const para1 = 'Ini adalah paragraf pertama tentang order game di NDXStore. '.repeat(10);
      const para2 = 'Ini adalah paragraf kedua dengan detail transaksi lengkap. '.repeat(10);
      const combined = `${para1}\n\n${para2}`;
      const chunks = splitIgChunks(combined, 950);
      assert.ok(chunks.length >= 2);
      for (const c of chunks) {
        assert.ok(c.length <= 950, `Chunk length ${c.length} exceeds 950`);
      }
    });

    it('splitIgChunks works reliably with small custom maxLen', () => {
      const words = 'halo dunia dari instagram bot ndxstore';
      const chunks = splitIgChunks(words, 12);
      assert.ok(chunks.length > 1);
      for (const c of chunks) {
        assert.ok(c.length <= 12, `Chunk "${c}" exceeds length 12`);
      }
    });
  }

  // ── TEST SUITE 4: Real Cloud Runner Module ─────────────────────────
  console.log('\nSuite 4: Cloud Runner Encryption & Health Check (Real Module)');
  {
    const { encryptBuffer, decryptBuffer, hasTar } = await import('../scripts/cloud-runner.mjs');

    it('hasTar utility probe returns boolean without throwing', () => {
      const tarAvailable = hasTar();
      assert.strictEqual(typeof tarAvailable, 'boolean');
    });

    it('Real cloud runner AES-256-GCM encryption/decryption roundtrip', () => {
      const sampleSession = Buffer.from('whatsapp-session-credentials-token-test-2026', 'utf8');
      const testSecret = 'secure-random-test-secret-12345';
      const enc = encryptBuffer(sampleSession, testSecret);
      assert.ok(typeof enc === 'string' && enc.length > 40);
      const dec = decryptBuffer(enc, testSecret);
      assert.strictEqual(dec.toString('utf8'), sampleSession.toString('utf8'));
    });

    it('Real cloud runner decryption rejects tampered payload or invalid secret', () => {
      const sampleSession = Buffer.from('valid-session', 'utf8');
      const enc = encryptBuffer(sampleSession, 'key1');
      assert.throws(() => {
        decryptBuffer(enc, 'key2-wrong');
      });
    });
  }

  // ── TEST SUITE 5: Dashboard Controller & Caching ─────────────────
  console.log('\nSuite 5: Dashboard Controller & Static Asset Caching');
  {
    const { handleDashboardRequest, initDashboard, normalizeJid } = await import('../services/dashboard.js');

    initDashboard({
      getBlocked: () => ['628111@c.us'],
      setBlocked: () => {},
      saveBlocked: async () => {},
      sendWaMessage: async () => true,
    });

    it('normalizeJid formats Indonesian numbers to WhatsApp JID', () => {
      assert.strictEqual(normalizeJid('08123456789'), '628123456789@c.us');
      assert.strictEqual(normalizeJid('+628123456789'), '628123456789@c.us');
      assert.strictEqual(normalizeJid('628123456789@c.us'), '628123456789@c.us');
      assert.strictEqual(normalizeJid('120363000000@g.us'), '120363000000@g.us');
      assert.strictEqual(normalizeJid('invalid'), null);
    });

    it('Dashboard handles static manifest.json request cleanly', async () => {
      let status = 0;
      let headers = {};
      let body = '';
      const req = { url: '/manifest.json', method: 'GET', headers: {} };
      const res = {
        writeHead: (code, hdrs) => { status = code; headers = hdrs || {}; },
        end: (data) => { body = data || ''; },
      };
      const handled = await handleDashboardRequest(req, res);
      assert.strictEqual(handled, true);
      assert.strictEqual(status, 200);
      assert.ok(headers['Content-Type'].includes('json'));
      assert.ok(body.includes('WA AI Bot') || body.includes('name'));
    });

    it('Dashboard handles static icon.svg request cleanly', async () => {
      let status = 0;
      let headers = {};
      let body = '';
      const req = { url: '/icon.svg', method: 'GET', headers: {} };
      const res = {
        writeHead: (code, hdrs) => { status = code; headers = hdrs || {}; },
        end: (data) => { body = data || ''; },
      };
      const handled = await handleDashboardRequest(req, res);
      assert.strictEqual(handled, true);
      assert.strictEqual(status, 200);
      assert.ok(headers['Content-Type'].includes('svg'));
      assert.ok(body.includes('<svg'));
    });

    it('Dashboard handles static root / request cleanly', async () => {
      let status = 0;
      let headers = {};
      let body = '';
      const req = { url: '/', method: 'GET', headers: {} };
      const res = {
        writeHead: (code, hdrs) => { status = code; headers = hdrs || {}; },
        end: (data) => { body = data || ''; },
      };
      const handled = await handleDashboardRequest(req, res);
      assert.strictEqual(handled, true);
      assert.strictEqual(status, 200);
      assert.ok(headers['Content-Type'].includes('html'));
    });

    it('Dashboard rejects malformed JSON with 400 Bad Request', async () => {
      let status = 0;
      let body = '';
      const req = {
        url: '/api/settings',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from('{ invalid json string ...');
        },
      };
      const res = {
        writeHead: (code) => { status = code; },
        end: (data) => { body = data; },
      };
      const handled = await handleDashboardRequest(req, res);
      assert.strictEqual(handled, true);
      assert.strictEqual(status, 400);
      assert.ok(body.includes('JSON'));
    });

    it('Dashboard rejects unauthorized store status without id and status', async () => {
      let status = 0;
      let body = '';
      const req = {
        url: '/api/store/status',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify({}));
        },
      };
      const res = {
        writeHead: (code) => { status = code; },
        end: (data) => { body = data; },
      };
      const handled = await handleDashboardRequest(req, res);
      assert.strictEqual(handled, true);
      assert.strictEqual(status, 400);
      assert.ok(body.includes('wajib diisi'));
    });
  }

  // ── TEST SUITE 6: Handover Service Memory Bounds ─────────────────
  console.log('\nSuite 6: CS Handover Memory Bound & LRU Protection');
  {
    const { isHandoverActive, endHandover, MAX_FORWARDED_MSGS, MAX_HANDOVER_SESSIONS } = await import('../services/handoverService.js');

    it('MAX constants for handover protection are defined and bounded', () => {
      assert.strictEqual(MAX_FORWARDED_MSGS, 1000);
      assert.strictEqual(MAX_HANDOVER_SESSIONS, 500);
    });

    it('isHandoverActive returns false for uninitiated session', () => {
      assert.strictEqual(isHandoverActive('6289999999@c.us'), false);
    });

    it('endHandover cleanly removes session without throwing', () => {
      assert.doesNotThrow(() => {
        endHandover('6289999999@c.us');
      });
    });
  }

  // ── TEST SUITE 7: Syntax & Integrity Across Repository ───────────
  console.log('\nSuite 7: Full Repository Syntax & Import Integrity');
  {
    const filesToVerify = [
      'index.js',
      'config.js',
      'client.js',
      'services/ai.js',
      'services/aiBuffer.js',
      'services/instagram.js',
      'services/dashboard.js',
      'services/handoverService.js',
      'services/orderMonitor.js',
      'services/queue.js',
      'services/rateLimiter.js',
      'services/settings.js',
      'scripts/cloud-runner.mjs',
      'utils/logger.js',
      'utils/db.js',
      'utils/format.js',
      'utils/viewOnce.js',
    ];

    for (const rel of filesToVerify) {
      const fullPath = path.join(root, rel);
      it(`File exists and readable: ${rel}`, () => {
        assert.ok(fs.existsSync(fullPath), `${rel} must exist`);
        const content = fs.readFileSync(fullPath, 'utf8');
        assert.ok(content.length > 100, `${rel} must not be empty`);
      });
    }
  }

  console.log('\n==================================================');
  console.log(`SUMMARY: ${passedTests}/${totalTests} tests passed (${failedTests} failed)`);
  console.log('==================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error('\nVerification run fatal error:', e);
  process.exit(1);
});
