import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  // The native reader tests must execute the current source, not a stale EXE
  // left by another branch or a previous packaging run.
  const builder = fileURLToPath(new URL('./build-win-asset-helper.mjs', import.meta.url));
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(process.execPath, [builder], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}
