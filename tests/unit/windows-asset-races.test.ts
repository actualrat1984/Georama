import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readAssetFile } from '../../electron/assets/open.ts';
import { configureWindowsAssetHelper } from '../../electron/assets/windows-read.ts';

const fixtures: string[] = [];
beforeAll(() => {
  if (process.platform === 'win32') configureWindowsAssetHelper(fileURLToPath(new URL('../../', import.meta.url)));
});
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe.skipIf(process.platform !== 'win32')('Windows adversarial asset open and substitution', () => {
  it('never yields outside-root contents while a directory is replaced by a junction', async () => {
    // Resolve runner TEMP aliases, while the test still creates and races its own junction.
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'georama-asset-race-')));
    fixtures.push(base);
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    const pack = path.join(root, 'pack');
    const parked = path.join(base, 'parked');
    await fs.mkdir(pack, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(pack, 'leaf.png'), 'INSIDE');
    await fs.writeFile(path.join(outside, 'leaf.png'), 'OUTSIDE-SECRET');

    for (let round = 0; round < 12; round++) {
      const attempt = readAssetFile(root, 'pack/leaf.png', 32)
        .then((bytes) => ({ bytes, error: undefined }), (error: { code?: string }) => ({ bytes: undefined, error }));
      let renamed = false;
      try {
        try {
          await fs.rename(pack, parked);
          renamed = true;
          await fs.symlink(outside, pack, 'junction');
          await fs.rm(pack, { recursive: true, force: true });
        } catch (error) {
          // An already-held no-delete-share handle should block replacement.
          expect(['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EEXIST']).toContain(
            (error as NodeJS.ErrnoException).code,
          );
        }
      } finally {
        if (renamed) {
          await fs.rm(pack, { recursive: true, force: true });
          await fs.rename(parked, pack);
        }
      }
      const result = await attempt;
      if (result.bytes !== undefined) {
        expect(new TextDecoder().decode(result.bytes)).toBe('INSIDE');
      } else {
        expect(['PATH', 'MISSING', 'IO']).toContain(result.error?.code);
      }
    }
    expect(await fs.readFile(path.join(outside, 'leaf.png'), 'utf8')).toBe('OUTSIDE-SECRET');
  }, 35_000);
});
