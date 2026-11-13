import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const verify = fileURLToPath(new URL('../../scripts/verify-win-portable.mjs', import.meta.url));
const entries = {
  electron: 'electron.exe',
  main: 'resources/app/dist-electron/main.cjs',
  renderer: 'resources/app/dist/renderer/index.html',
  assetHelper: 'resources/app/out/windows/georama-win-asset-read.exe',
  selectedHelper: 'resources/app/out/windows/georama-win-selected-read.exe',
};

async function withSyntheticPreview(check: (dir: string, manifest: {
  schema: number;
  kind: string;
  authenticated: boolean;
  electron: string;
  hashes: Record<string, { path: string; sha256: string }>;
}) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'georama-portable-manifest-'));
  try {
    const hashes: Record<string, { path: string; sha256: string }> = {};
    for (const [key, relative] of Object.entries(entries)) {
      const bytes = Buffer.from(`synthetic-${key}`);
      const filename = path.join(dir, ...relative.split('/'));
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes);
      hashes[key] = { path: relative, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    const manifest = { schema: 2, kind: 'unsigned-developer-preview', authenticated: false,
      electron: '44.9.3', hashes };
    await check(dir, manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeManifest(dir: string, value: object): Promise<void> {
  await writeFile(path.join(dir, 'georama-manifest.json'), JSON.stringify(value));
}

function verifyPreview(dir: string) {
  return spawnSync(process.execPath, [verify, dir], { encoding: 'utf8', timeout: 10_000 });
}

describe('unsigned Windows developer-preview manifest', () => {
  it('accepts intact copied bytes but rejects changes to either native helper', async () => {
    await withSyntheticPreview(async (dir, manifest) => {
      await writeManifest(dir, manifest);
      const intact = verifyPreview(dir);
      expect(intact.status).toBe(0);
      expect(intact.stdout).toContain('NOT publisher-authenticated');

      for (const key of ['assetHelper', 'selectedHelper'] as const) {
        const filename = path.join(dir, ...entries[key].split('/'));
        await writeFile(filename, 'tampered');
        const altered = verifyPreview(dir);
        expect(altered.status).not.toBe(0);
        expect(altered.stderr).toContain(`Package checksum mismatch: ${key}`);
        // The next iteration must start with a valid manifest and package.
        const original = Buffer.from(`synthetic-${key}`);
        await writeFile(filename, original);
      }
    });
  });

  it('requires an explicit unsigned-preview manifest and rejects authenticity claims', async () => {
    await withSyntheticPreview(async (dir, manifest) => {
      for (const changed of [
        { ...manifest, kind: 'release' },
        { ...manifest, authenticated: true },
        { ...manifest, schema: 1 },
      ]) {
        await writeManifest(dir, changed);
        const attempt = verifyPreview(dir);
        expect(attempt.status).not.toBe(0);
        expect(attempt.stderr).toContain('Unexpected portable package manifest');
      }
    });
  });
});
