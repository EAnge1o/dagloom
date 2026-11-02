/**
 * Test launcher: enumerate compiled test files and hand them to
 * `node --test` explicitly. Kept version-agnostic because `node --test
 * <glob>` needs Node >= 22 and directory args are unreliable on Windows.
 * Dev-time only — part of `npm test`, not the runtime package.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = path.join(root, 'dist', 'test');
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(testDir, f));

if (files.length === 0) {
  console.error('no compiled tests found in dist/test — run `npm run build` first');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(result.status ?? 1);
