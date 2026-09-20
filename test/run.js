/**
 * Test entry point.
 *
 * `node --test <glob>` only understands glob patterns from Node 22 on, and
 * shells disagree about expanding them, so the file list is built here and
 * handed to the runner explicitly. Works the same on every supported version
 * and on every platform.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(dir, name));

if (!files.length) {
  console.error('no test files found');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
