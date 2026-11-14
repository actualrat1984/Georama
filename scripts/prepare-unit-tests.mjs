import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Rebuild BOTH native helpers on Windows. A stale EXE left by a prior branch
// must never make a failing security test appear green.
if (process.platform === 'win32') {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const name of ['build-win-asset-helper.mjs', 'build-win-selected-helper.mjs']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`Required Windows helper build failed: ${name}`);
      process.exit(result.status ?? 1);
    }
  }
}
