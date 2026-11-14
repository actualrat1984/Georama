import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { SelectedFileError } from '../../electron/data/selected-file.ts';
import * as selected from '../../electron/data/selected-file.ts';
import * as text from '../../src/core/assets/asset-json.ts';
import { readSelectedConfigFile } from '../../electron/data/config-file.ts';

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'config-strength-'));
  roots.push(root);
  const file = path.join(root, 'owned.json');
  await fs.writeFile(file, '{}');
  return { root, file };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it('forwards opaque filename spellings unchanged and admits selected map suffix JSON', async () => {
  const { root } = await fixture();
  const names = ['caf\u00e9.json', 'cafe\u0301.json', '%2e%2e.json', 'sp ace.json', 'back\\slash.json', 'colon:name.json', '.hidden.json', 'data.wonderdraft_map'];
  for (let i = 0; i < names.length; i++) {
    await fs.writeFile(path.join(root, names[i]!), JSON.stringify({ mapRoots: [`/invented/marker-${i}`] }));
  }
  const reader = vi.spyOn(selected, 'readSelectedDataFile');
  for (let i = 0; i < names.length; i++) {
    const filename = path.join(root, names[i]!);
    expect(await readSelectedConfigFile(filename)).toEqual({ mapRoots: [`/invented/marker-${i}`] });
    expect(reader).toHaveBeenNthCalledWith(i + 1, filename, 65536);
  }
  expect(reader).toHaveBeenCalledTimes(names.length);
});
it('does not trim a refused filename into an existing selected file', async () => {
  const { file } = await fixture();
  const opener = vi.spyOn(fs, 'open');
  await expect(readSelectedConfigFile(file + ' ')).rejects.toBeInstanceOf(SelectedFileError);
  await expect(readSelectedConfigFile(file + ' ')).rejects.toMatchObject({ code: 'EXTENSION' });
  expect(opener).not.toHaveBeenCalled();
});
it('awaits an explicit real-close entry event and reporting gate before decoding', async () => {
  const { file } = await fixture();
  let release!: () => void;
  let notify!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { notify = r; });
  const open = fs.open.bind(fs);
  let nativeRead: FileHandle['read'] | undefined;
  vi.spyOn(fs, 'open').mockImplementation(async (p, flags, ...rest) => {
    const h = await open(p as string, flags as number, ...(rest as []));
    if (p === file) {
      const close = h.close.bind(h);
      nativeRead = h.read.bind(h);
      Object.defineProperty(h, 'close', { configurable: true, value: async () => {
        await close();
        notify();
        await gate;
      } });
    }
    return h;
  });
  const decoder = vi.spyOn(text, 'decodeAssetText');
  const promise = readSelectedConfigFile(file);
  try {
    await entered;
    await tick();
    expect(decoder).not.toHaveBeenCalled();
    await expect(nativeRead!(new Uint8Array(1), 0, 1, 0)).rejects.toMatchObject({ code: 'EBADF' });
  } finally {
    release();
    await promise;
  }
  expect(decoder).toHaveBeenCalledTimes(1);
});
