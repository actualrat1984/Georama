import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssetStoreError, createAssetStore } from '../../electron/assets/store.ts';
import type { AssetStore } from '../../electron/assets/store.ts';
import { buildPck, makePng } from '../helpers/pck-synthetic.ts';

const roots: string[] = [];
const stores: AssetStore[] = [];
const builtin = 'res://sprites/synthetic/tree';
const user = 'user://assets/synthetic-pack/trees/tree';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'georama-store-strength-'));
  roots.push(base);
  const png = makePng({ width: 2, height: 3 });
  const installRoot = path.join(base, 'install');
  const userDataRoot = path.join(base, 'user');
  const leaf = path.join(userDataRoot, 'assets', 'synthetic-pack', 'trees', 'tree.png');
  await fs.mkdir(installRoot, { recursive: true });
  await fs.mkdir(path.dirname(leaf), { recursive: true });
  await fs.writeFile(leaf, png);
  await fs.writeFile(path.join(installRoot, 'Wonderdraft.pck'), buildPck([
    { path: `${builtin}.wonderdraft_image`, data: png },
  ]));
  return { base, png, installRoot, userDataRoot, leaf };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('parent image-store contract strength', () => {
  it.each([
    { name: 'one-character root', root: '/' },
    { name: 'exact maximum root', root: '/' + 'a'.repeat(4095) },
    { name: 'punctuation and paired Unicode', root: "/synthetic'% ;🌲" },
    { name: 'normalized trailing slash', root: '/synthetic/' },
  ])('accepts $name lazily without touching that directory', async ({ root }) => {
    const open = vi.spyOn(fs, 'open').mockRejectedValue(new Error('unexpected filesystem open'));
    const store = await createAssetStore({ userDataRoot: root });
    stores.push(store);
    await store.close();
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects exact overlong roots, every control class and non-normalized roots before IO', async () => {
    const open = vi.spyOn(fs, 'open').mockRejectedValue(new Error('unexpected filesystem open'));
    const controls = [...Array.from({ length: 32 }, (_, i) => i),
      ...Array.from({ length: 33 }, (_, i) => 127 + i)];
    const bad = ['', '/' + 'a'.repeat(4096), '/a/../b', '//a', 'relative',
      '/a\ud800b', '/a\udfffb', ...controls.map((c) => `/a${String.fromCharCode(c)}b`)];
    for (const root of bad) {
      let accepted: AssetStore | undefined;
      let error: unknown;
      try { accepted = await createAssetStore({ userDataRoot: root }); }
      catch (e) { error = e; }
      finally { if (accepted) await accepted.close(); }
      expect(error).toBeInstanceOf(AssetStoreError);
      expect(error).toMatchObject({ code: 'ROOT' });
    }
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['pck', 'user'] as const)('forwards exact and lowered caller caps to the %s backend', async (source) => {
    const fx = await fixture();
    const store = await createAssetStore({ installRoot: fx.installRoot, userDataRoot: fx.userDataRoot });
    stores.push(store);
    const ref = source === 'pck' ? builtin : user;
    expect((await store.readImage('symbol', ref, fx.png.length)).bytes).toEqual(fx.png);
    for (const cap of [0, fx.png.length - 1]) {
      await expect(store.readImage('symbol', ref, cap)).rejects.toMatchObject({ code: 'LIMIT' });
    }
    expect((await store.readImage('symbol', ref, fx.png.length + 1)).bytes).toEqual(fx.png);
  });

  it.each(['pck', 'user'] as const)('transfers %s data without allocating a second encoded backing buffer', async (source) => {
    const fx = await fixture();
    const store = await createAssetStore({ installRoot: fx.installRoot, userDataRoot: fx.userDataRoot });
    stores.push(store);
    const probe = await fs.open(fx.leaf, 'r');
    const proto = Object.getPrototypeOf(probe) as Record<string, unknown>;
    await probe.close();
    const original = proto['read'] as (...args: unknown[]) => Promise<unknown>;
    const dataBuffers: Uint8Array[] = [];
    proto['read'] = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const buffer = args[0];
      if (buffer instanceof Uint8Array && buffer.byteLength === fx.png.length) dataBuffers.push(buffer);
      return Reflect.apply(original, this, args) as Promise<unknown>;
    };
    try {
      const image = await store.readImage('symbol', source === 'pck' ? builtin : user, fx.png.length);
      expect(image.bytes).toEqual(fx.png);
      expect(dataBuffers).toHaveLength(1);
      expect(image.bytes.buffer).toBe(dataBuffers[0]!.buffer);
      expect(image.bytes.byteOffset).toBe(dataBuffers[0]!.byteOffset);
      expect(image.bytes.byteLength).toBe(dataBuffers[0]!.byteLength);
    } finally {
      proto['read'] = original;
    }
  });

  it('captures the user root before eager archive IO can mutate caller options', async () => {
    const fx = await fixture();
    const alternate = path.join(fx.base, 'alternate');
    const alternateLeaf = path.join(alternate, 'assets', 'synthetic-pack', 'trees', 'tree.png');
    await fs.mkdir(path.dirname(alternateLeaf), { recursive: true });
    await fs.writeFile(alternateLeaf, makePng({ width: 7, height: 2 }));
    const options = { installRoot: fx.installRoot, userDataRoot: fx.userDataRoot };
    const original = fs.open;
    let changed = false;
    const spy = vi.spyOn(fs, 'open').mockImplementation((...args: Parameters<typeof fs.open>) => {
      if (!changed && args[0] === fx.installRoot) {
        changed = true;
        options.userDataRoot = alternate;
      }
      return Reflect.apply(original, fs, args) as ReturnType<typeof fs.open>;
    });
    let store: AssetStore;
    try { store = await createAssetStore(options); stores.push(store); }
    finally { spy.mockRestore(); }
    expect(changed).toBe(true);
    expect((await store.readImage('symbol', user)).bytes).toEqual(fx.png);
  });
});
