import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const EXCLUDE_DIRS = new Set(['node_modules', 'wa-session', '.git']);

let failed = 0;
let checked = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) walk(full);
    } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
      try {
        execSync(`node --check "${full}"`, { stdio: 'pipe', cwd: root });
        checked++;
      } catch (e) {
        failed++;
        process.stdout.write(`FAIL: ${path.relative(root, full)}\n`);
      }
    }
  }
}

walk(root);
process.stdout.write(`\n${checked} files OK, ${failed} files FAILED\n`);
process.exit(failed > 0 ? 1 : 0);
