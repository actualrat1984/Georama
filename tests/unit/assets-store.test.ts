import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { buildPck, makePng } from '../helpers/pck-synthetic.ts';
import { AssetStoreError, createAssetStore } from '../../electron/assets/store.ts';
import type { AssetStore } from '../../electron/assets/store.ts';

const openStores: AssetStore[] = [];
const fixtures: string[] = [];

async function makeDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    await store.close();
  }
  for (const dir of fixtures.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('asset store vertical 1: builtin positive', () => {
  it('reads a builtin image from the archive with exact bytes and key', async () => {
    const png = makePng({ width: 2, height: 3 });
    const archive = buildPck([{ path: 'res://sprites/synthetic/tree.wonderdraft_image', data: png }]);
    const base = await makeDir('georama-store-v1-');
    const installRoot = path.join(base, 'install');
    await fs.mkdir(installRoot, { recursive: true });
    await fs.writeFile(path.join(installRoot, 'Wonderdraft.pck'), archive);
    const store = await createAssetStore({ installRoot });
    openStores.push(store);
    const img = await store.readImage('symbol', 'res://sprites/synthetic/tree');
    expect(img.key).toBe('pck:res://sprites/synthetic/tree.wonderdraft_image');
    expect(img.info.width).toBe(2);
    expect(img.info.height).toBe(3);
    expect(img.bytes).toEqual(png);
  });
});

describe('asset store vertical 2: user route', () => {
  it('reads a user image from the user data root with exact bytes and key', async () => {
    const png = makePng({ width: 2, height: 3 });
    const base = await makeDir('georama-store-v2-');
    const userDataRoot = path.join(base, 'user');
    await fs.mkdir(path.join(userDataRoot, 'assets', 'synthetic-pack', 'trees'), { recursive: true });
    await fs.writeFile(path.join(userDataRoot, 'assets', 'synthetic-pack', 'trees', 'tree.png'), png);
    const store = await createAssetStore({ userDataRoot });
    openStores.push(store);
    const img = await store.readImage('symbol', 'user://assets/synthetic-pack/trees/tree');
    expect(img.key).toBe('user:synthetic-pack/trees/tree.png');
    expect(img.info.width).toBe(2);
    expect(img.info.height).toBe(3);
    expect(img.bytes).toEqual(png);
  });
});

async function waitForCondition(cond: () => boolean, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`deadline waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fileHandleProto(base: string): Promise<Record<string, unknown>> {
  const probePath = path.join(base, 'probe');
  await fs.writeFile(probePath, 'x');
  const probe = await fs.open(probePath, 'r');
  const proto = Object.getPrototypeOf(probe) as Record<string, unknown>;
  await probe.close();
  return proto;
}

interface MixedFixtures {
  base: string;
  installRoot: string;
  userDataRoot: string;
  builtinA: string;
  builtinB: string;
  userA: string;
  userB: string;
}

async function makeMixedFixtures(prefix: string): Promise<MixedFixtures> {
  const pngA = makePng({ width: 2, height: 3 });
  const pngB = makePng({ width: 4, height: 1 });
  const base = await makeDir(prefix);
  const installRoot = path.join(base, 'install');
  await fs.mkdir(installRoot, { recursive: true });
  const archive = buildPck([
    { path: 'res://sprites/synthetic/tree.wonderdraft_image', data: pngA },
    { path: 'res://sprites/synthetic/rock.wonderdraft_image', data: pngB },
  ]);
  await fs.writeFile(path.join(installRoot, 'Wonderdraft.pck'), archive);
  const userDataRoot = path.join(base, 'user');
  await fs.mkdir(path.join(userDataRoot, 'assets', 'synthetic-pack', 'trees'), { recursive: true });
  await fs.writeFile(path.join(userDataRoot, 'assets', 'synthetic-pack', 'trees', 'tree.png'), pngA);
  await fs.writeFile(path.join(userDataRoot, 'assets', 'synthetic-pack', 'trees', 'bush.png'), pngB);
  return {
    base,
    installRoot,
    userDataRoot,
    builtinA: 'res://sprites/synthetic/tree',
    builtinB: 'res://sprites/synthetic/rock',
    userA: 'user://assets/synthetic-pack/trees/tree',
    userB: 'user://assets/synthetic-pack/trees/bush',
  };
}

describe('asset store vertical 3: global concurrency and close drain', () => {
  it('admits four mixed-source reads and rejects the fifth without IO', async () => {
    const fx = await makeMixedFixtures('georama-store-v3a-');
    const store = await createAssetStore({ installRoot: fx.installRoot, userDataRoot: fx.userDataRoot });
    openStores.push(store);
    const proto = await fileHandleProto(fx.base);
    const origRead = proto['read'] as (...args: never[]) => Promise<unknown>;
    let entered = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    proto['read'] = async function (this: unknown, ...args: never[]): Promise<unknown> {
      entered += 1;
      await gate;
      return origRead.apply(this, args);
    };
    const p1 = store.readImage('symbol', fx.builtinA);
    const p2 = store.readImage('symbol', fx.builtinB);
    const p3 = store.readImage('symbol', fx.userA);
    const p4 = store.readImage('symbol', fx.userB);
    const pending: Array<Promise<unknown>> = [p1, p2, p3, p4];
    try {
      await waitForCondition(() => entered >= 4, 5000, 'four reads to reach IO');
      const fifth = store.readImage('symbol', fx.userA);
      let fifthError: unknown;
      let fifthDone = false;
      fifth.then(
        () => {
          fifthDone = true;
        },
        (error: unknown) => {
          fifthError = error;
          fifthDone = true;
        },
      );
      await waitForCondition(() => fifthDone || entered > 4, 5000, 'fifth to settle or extra IO');
      expect(entered).toBe(4);
      expect(fifthDone).toBe(true);
      expect(fifthError).toBeInstanceOf(AssetStoreError);
      expect((fifthError as AssetStoreError).code).toBe('BUSY');
      pending.push(fifth.catch(() => undefined as never));
    } finally {
      releaseGate();
      proto['read'] = origRead;
      await Promise.allSettled(pending);
    }
  });

  it('close waits for an admitted user read before closing the archive handle', async () => {
    const fx = await makeMixedFixtures('georama-store-v3b-');
    const store = await createAssetStore({ installRoot: fx.installRoot, userDataRoot: fx.userDataRoot });
    openStores.push(store);
    let archiveFd = -1;
    for (const name of await fs.readdir('/proc/self/fd')) {
      try {
        const link = await fs.readlink(`/proc/self/fd/${name}`);
        if (link.endsWith('Wonderdraft.pck')) archiveFd = Number(name);
      } catch {
        /* fd raced closed */
      }
    }
    expect(archiveFd).toBeGreaterThanOrEqual(0);
    const proto = await fileHandleProto(fx.base);
    const origRead = proto['read'] as (...args: never[]) => Promise<unknown>;
    let entered = 0;
    let archiveCloses = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const archiveFdState = async (): Promise<string | null> => {
      try {
        return await fs.readlink(`/proc/self/fd/${archiveFd}`);
      } catch {
        return null;
      }
    };
    proto['read'] = async function (this: unknown, ...args: never[]): Promise<unknown> {
      entered += 1;
      await gate;
      return origRead.apply(this, args);
    };
    const userPending = store.readImage('symbol', fx.userA);
    try {
      await waitForCondition(() => entered >= 1, 5000, 'user read to reach IO');
      const closing = store.close();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(await archiveFdState()).not.toBe(null);
      expect(archiveCloses).toBe(0);
      releaseGate();
      await closing;
      const img = await userPending;
      expect(img.key).toBe('user:synthetic-pack/trees/tree.png');
      expect(await archiveFdState()).toBe(null);
      await expect(store.readImage('symbol', fx.builtinA)).rejects.toMatchObject({ name: 'AssetStoreError' });
    } finally {
      releaseGate();
      proto['read'] = origRead;
      await Promise.allSettled([userPending.catch(() => undefined as never)]);
    }
  });
});

function patchU32BE(bytes: Uint8Array, pos: number, value: number): void {
  bytes[pos] = (value >>> 24) & 0xff;
  bytes[pos + 1] = (value >>> 16) & 0xff;
  bytes[pos + 2] = (value >>> 8) & 0xff;
  bytes[pos + 3] = value & 0xff;
}

function withIhdrWidth(png: Uint8Array, width: number): Uint8Array {
  const copy = Uint8Array.from(png);
  patchU32BE(copy, 16, width);
  patchU32BE(copy, 29, nodeCrc32(copy.subarray(12, 29)) >>> 0);
  return copy;
}

async function openPckLinks(): Promise<string[]> {
  const found: string[] = [];
  for (const name of await fs.readdir('/proc/self/fd')) {
    try {
      const link = await fs.readlink(`/proc/self/fd/${name}`);
      if (link.endsWith('Wonderdraft.pck')) found.push(link);
    } catch {
      /* raced close */
    }
  }
  return found;
}

describe('asset store vertical 4: caps, options and PNG strictness', () => {
  it('rejects non-plain options and bad roots without IO', async () => {
    const png = makePng({ width: 2, height: 3 });
    const base = await makeDir('georama-store-v4a-');
    const installRoot = path.join(base, 'install');
    await fs.mkdir(installRoot, { recursive: true });
    await fs.writeFile(path.join(installRoot, 'Wonderdraft.pck'), buildPck([
      { path: 'res://sprites/synthetic/tree.wonderdraft_image', data: png },
    ]));
    const badOptions: unknown[] = [
      null,
      [],
      (() => undefined) as never,
      new (class {})() as never,
      'root',
      42,
    ];
    for (const options of badOptions) {
      await expect(createAssetStore(options as never)).rejects.toMatchObject({ name: 'AssetStoreError', code: 'ROOT' });
    }
    const throwingGetter = {};
    Object.defineProperty(throwingGetter, 'installRoot', {
      enumerable: true,
      get(): never {
        throw new Error('getter boom');
      },
    });
    await expect(createAssetStore(throwingGetter)).rejects.toMatchObject({ code: 'ROOT' });
    const throwingProto = new Proxy({}, { getPrototypeOf(): never { throw new Error('proto boom'); } });
    await expect(createAssetStore(throwingProto as never)).rejects.toMatchObject({ code: 'ROOT' });
    const badRoots: unknown[] = [
      '',
      'relative',
      '/x\0y',
      '/x\ny',
      `/x${String.fromCharCode(0x7f)}y`,
      `/x${String.fromCharCode(0x85)}y`,
      '//server/x',
      '/a'.repeat(5000),
      123,
      true,
    ];
    for (const root of badRoots) {
      await expect(createAssetStore({ installRoot: root as never })).rejects.toMatchObject({ code: 'ROOT' });
    }
    const loneSurrogate = `/x${String.fromCharCode(0xd800)}y`;
    await expect(createAssetStore({ installRoot: loneSurrogate })).rejects.toMatchObject({ code: 'ROOT' });
    await expect(createAssetStore({ userDataRoot: loneSurrogate })).rejects.toMatchObject({ code: 'ROOT' });
    expect(await openPckLinks()).toEqual([]);
  });

  it('validates the user root before opening the install archive', async () => {
    const base = await makeDir('georama-store-v4b-');
    const installRoot = path.join(base, 'install');
    await fs.mkdir(installRoot, { recursive: true });
    await fs.writeFile(
      path.join(installRoot, 'Wonderdraft.pck'),
      buildPck([{ path: 'res://sprites/synthetic/tree.wonderdraft_image', data: makePng() }]),
    );
    await expect(createAssetStore({ installRoot, userDataRoot: 'not-absolute' })).rejects.toMatchObject({
      name: 'AssetStoreError',
      code: 'ROOT',
    });
    expect(await openPckLinks()).toEqual([]);
  });

  it('keeps the snapshot taken before the first await when options mutate', async () => {
    const pngA = makePng({ width: 2, height: 3 });
    const base = await makeDir('georama-store-v4c-');
    const rootA = path.join(base, 'a');
    await fs.mkdir(rootA, { recursive: true });
    await fs.writeFile(path.join(rootA, 'Wonderdraft.pck'), buildPck([
      { path: 'res://sprites/synthetic/tree.wonderdraft_image', data: pngA },
    ]));
    const options = { installRoot: rootA };
    const pending = createAssetStore(options);
    options.installRoot = '/nonexistent-redirect';
    const store = await pending;
    openStores.push(store);
    const img = await store.readImage('symbol', 'res://sprites/synthetic/tree');
    expect(img.bytes).toEqual(pngA);
  });

  it('accepts null-prototype records and ignores unknown fields', async () => {
    const png = makePng({ width: 2, height: 3 });
    const base = await makeDir('georama-store-v4d-');
    const installRoot = path.join(base, 'install');
    await fs.mkdir(installRoot, { recursive: true });
    await fs.writeFile(path.join(installRoot, 'Wonderdraft.pck'), buildPck([
      { path: 'res://sprites/synthetic/tree.wonderdraft_image', data: png },
    ]));
    const options = Object.assign(Object.create(null), {
      installRoot,
      bogus: 123,
      extra: Symbol('x'),
    });
    const store = await createAssetStore(options);
    openStores.push(store);
    const img = await store.readImage('symbol', 'res://sprites/synthetic/tree');
    expect(img.key).toBe('pck:res://sprites/synthetic/tree.wonderdraft_image');
  });

  it('supports an empty store with zero IO and a working close', async () => {
    const emptyA = await createAssetStore();
    openStores.push(emptyA);
    const emptyB = await createAssetStore({});
    openStores.push(emptyB);
    await expect(emptyA.readImage('symbol', 'res://sprites/synthetic/tree')).rejects.toMatchObject({ code: 'ROOT' });
    await expect(emptyB.readImage('symbol', 'user://assets/p/f')).rejects.toMatchObject({ code: 'ROOT' });
    await emptyA.close();
    await emptyB.close();
    await expect(emptyA.readImage('symbol', 'res://sprites/synthetic/tree')).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('enforces exact byte caps without IO before admission', async () => {
    const png = makePng({ width: 2, height: 3 });
    const base = await makeDir('georama-store-v4e-');
    const userDataRoot = path.join(base, 'user');
    await fs.mkdir(path.join(userDataRoot, 'assets', 'p', 't'), { recursive: true });
    await fs.writeFile(path.join(userDataRoot, 'assets', 'p', 't', 'tree.png'), png);
    const store = await createAssetStore({ userDataRoot });
    openStores.push(store);
    const ref: [string, string] = ['symbol', 'user://assets/p/t/tree'];
    const exact = await store.readImage(ref[0] as never, ref[1], png.length);
    expect(exact.bytes).toEqual(png);
    await expect(store.readImage(ref[0] as never, ref[1], png.length - 1)).rejects.toMatchObject({ code: 'LIMIT' });
    await expect(store.readImage(ref[0] as never, ref[1], 0)).rejects.toMatchObject({ code: 'LIMIT' });
    const big = await store.readImage(ref[0] as never, ref[1], 64 * 1024 * 1024);
    expect(big.bytes).toEqual(png);
    const badCaps: unknown[] = [NaN, Infinity, -Infinity, 1.5, -1, 64 * 1024 * 1024 + 1, '8', true, null, [], {}];
    for (const cap of badCaps) {
      await expect(store.readImage(ref[0] as never, ref[1], cap as never)).rejects.toMatchObject({ code: 'LIMIT' });
    }
    await expect(store.readImage(ref[0] as never, ref[1], Symbol('c') as never)).rejects.toMatchObject({ code: 'LIMIT' });
    const throwingCap = { valueOf(): never { throw new Error('coerce'); } };
    await expect(store.readImage(ref[0] as never, ref[1], throwingCap as never)).rejects.toMatchObject({ code: 'LIMIT' });
    const proto = await fileHandleProto(base);
    const origRead = proto['read'] as (...args: never[]) => Promise<unknown>;
    let entered = 0;
    proto['read'] = async function (this: unknown, ...args: never[]): Promise<unknown> {
      entered += 1;
      return origRead.apply(this, args);
    };
    try {
      await expect(store.readImage(ref[0] as never, ref[1], NaN)).rejects.toMatchObject({ code: 'LIMIT' });
      expect(entered).toBe(0);
    } finally {
      proto['read'] = origRead;
    }
    const ok = await store.readImage(ref[0] as never, ref[1]);
    expect(ok.bytes).toEqual(png);
  });

  it('validates the whole PNG and preserves typed failures without caching', async () => {
    const good = makePng({ width: 2, height: 3 });
    const badCrc = Uint8Array.from(good);
    badCrc[41] ^= 0x01;
    const zeroWidth = withIhdrWidth(good, 0);
    const badSig = Uint8Array.from(good);
    badSig[0] = 0;
    const truncated = good.subarray(0, 20);
    const base = await makeDir('georama-store-v4f-');
    const userDataRoot = path.join(base, 'user');
    const dir = path.join(userDataRoot, 'assets', 'p', 't');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'good.png'), good);
    await fs.writeFile(path.join(dir, 'badcrc.png'), badCrc);
    await fs.writeFile(path.join(dir, 'zerow.png'), zeroWidth);
    await fs.writeFile(path.join(dir, 'badsig.png'), badSig);
    await fs.writeFile(path.join(dir, 'short.png'), truncated);
    const store = await createAssetStore({ userDataRoot });
    openStores.push(store);
    await expect(store.readImage('symbol', 'user://assets/p/t/badcrc')).rejects.toMatchObject({
      name: 'PngError',
      code: 'CRC',
    });
    await expect(store.readImage('symbol', 'user://assets/p/t/zerow')).rejects.toMatchObject({
      name: 'PngError',
      code: 'IHDR',
    });
    await expect(store.readImage('symbol', 'user://assets/p/t/badsig')).rejects.toMatchObject({
      name: 'PngError',
      code: 'SIGNATURE',
    });
    await expect(store.readImage('symbol', 'user://assets/p/t/short')).rejects.toMatchObject({ name: 'PngError' });
    const first = await store.readImage('symbol', 'user://assets/p/t/good');
    const second = await store.readImage('symbol', 'user://assets/p/t/good');
    expect(first.bytes).toEqual(good);
    expect(second.bytes).toEqual(good);
    expect(first.bytes).not.toBe(second.bytes);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.ref)).toBe(true);
    expect(Object.isFrozen(first.info)).toBe(true);
    expect(Object.isFrozen(first.bytes)).toBe(false);
    first.bytes[0] ^= 0xff;
    const third = await store.readImage('symbol', 'user://assets/p/t/good');
    expect(third.bytes).toEqual(good);
  });

  it('rejects a changed archive and never falls back between roots', async () => {
    const pngA = makePng({ width: 2, height: 3 });
    const pngB = makePng({ width: 5, height: 5 });
    const base = await makeDir('georama-store-v4g-');
    const installRoot = path.join(base, 'install');
    await fs.mkdir(installRoot, { recursive: true });
    const leaf = path.join(installRoot, 'Wonderdraft.pck');
    await fs.writeFile(leaf, buildPck([{ path: 'res://sprites/synthetic/tree.wonderdraft_image', data: pngA }]));
    const both = await createAssetStore({ installRoot, userDataRoot: path.join(base, 'user') });
    openStores.push(both);
    const before = await both.readImage('symbol', 'res://sprites/synthetic/tree');
    expect(before.bytes).toEqual(pngA);
    await fs.writeFile(leaf, buildPck([{ path: 'res://sprites/synthetic/tree.wonderdraft_image', data: pngB }]));
    await expect(both.readImage('symbol', 'res://sprites/synthetic/tree')).rejects.toMatchObject({ code: 'CHANGED' });
    const installOnly = await createAssetStore({ installRoot });
    openStores.push(installOnly);
    await expect(installOnly.readImage('symbol', 'user://assets/p/t/tree')).rejects.toMatchObject({ code: 'ROOT' });
    const userOnly = await createAssetStore({ userDataRoot: path.join(base, 'user') });
    openStores.push(userOnly);
    await expect(userOnly.readImage('symbol', 'res://sprites/synthetic/tree')).rejects.toMatchObject({ code: 'ROOT' });
  });

  it('reads every resolver kind and surfaces typed ref errors with free slots', async () => {
    const png = makePng();
    const entries = [
      'res://sprites/synthetic/tree.wonderdraft_image',
      'res://textures/paths/dirt.wonderdraft_image',
      'res://textures/borders/fancy.wonderdraft_image',
      'res://textures/water/lake.wonderdraft_image',
      'res://textures/ground/grass.wonderdraft_image',
      'res://textures/frames/oak.wonderdraft_image',
    ].map((entryPath) => ({ path: entryPath, data: png }));
    const base = await makeDir('georama-store-v4h-');
    const installRoot = path.join(base, 'install');
    await fs.mkdir(installRoot, { recursive: true });
    await fs.writeFile(path.join(installRoot, 'Wonderdraft.pck'), buildPck(entries));
    const store = await createAssetStore({ installRoot });
    openStores.push(store);
    const cases: Array<[string, string, string]> = [
      ['symbol', 'res://sprites/synthetic/tree', 'pck:res://sprites/synthetic/tree.wonderdraft_image'],
      ['path-style', 'res://textures/paths/dirt', 'pck:res://textures/paths/dirt.wonderdraft_image'],
      ['border-style', 'res://textures/borders/fancy', 'pck:res://textures/borders/fancy.wonderdraft_image'],
      ['water-texture', 'lake', 'pck:res://textures/water/lake.wonderdraft_image'],
      ['ground-texture', 'grass', 'pck:res://textures/ground/grass.wonderdraft_image'],
      ['frame-texture', 'oak', 'pck:res://textures/frames/oak.wonderdraft_image'],
    ];
    for (const [kind, reference, key] of cases) {
      const img = await store.readImage(kind as never, reference);
      expect(img.key).toBe(key);
      expect(img.info.width).toBe(2);
      expect(img.bytes).toEqual(png);
    }
    const bad: Array<[unknown, unknown, string]> = [
      ['symbol', 'bogus', 'SCHEME'],
      ['path-style', 'res://nope/x', 'SCHEME'],
      ['border-style', 'res://textures/borders/a/b', 'SEGMENT'],
      ['water-texture', 'a/b', 'NAME'],
      ['ground-texture', '', 'EMPTY'],
      ['frame-texture', `x${'y'.repeat(600)}`, 'TOO_LONG'],
      ['nope', 'x', 'NAME'],
      ['symbol', 123, 'NAME'],
      ['symbol', null, 'NAME'],
      ['symbol', Symbol('r'), 'NAME'],
    ];
    for (const [kind, reference, code] of bad) {
      await expect(store.readImage(kind as never, reference as never)).rejects.toMatchObject({
        name: 'RefError',
        code,
      });
    }
    await expect(store.readImage(Symbol('k') as never, 'x')).rejects.toMatchObject({ name: 'RefError' });
    const closed = await createAssetStore({ installRoot });
    openStores.push(closed);
    await closed.close();
    await expect(closed.readImage('symbol', 'bogus')).rejects.toMatchObject({ name: 'RefError' });
    await expect(closed.readImage('symbol', 'res://sprites/synthetic/tree')).rejects.toMatchObject({
      name: 'AssetStoreError',
      code: 'CLOSED',
    });
    const still = await store.readImage('symbol', 'res://sprites/synthetic/tree');
    expect(still.bytes).toEqual(png);
  });
});

describe('asset store vertical 5: roots, links and close failure', () => {
  it('reads through trailing-slash roots and punctuation names', async () => {
    const png = makePng({ width: 2, height: 3 });
    const base = await makeDir('georama-store-v5a-');
    const installRoot = path.join(base, 'install');
    await fs.mkdir(installRoot, { recursive: true });
    await fs.writeFile(path.join(installRoot, 'Wonderdraft.pck'), buildPck([
      { path: 'res://sprites/synthetic/tree.wonderdraft_image', data: png },
    ]));
    const userDataRoot = path.join(base, 'user');
    const packDir = path.join(userDataRoot, 'assets', 'sample é & co', 'trees');
    await fs.mkdir(packDir, { recursive: true });
    await fs.writeFile(path.join(packDir, 'sample item 1 (old).png'), png);
    const store = await createAssetStore({ installRoot: `${installRoot}/`, userDataRoot: `${userDataRoot}/` });
    openStores.push(store);
    const builtin = await store.readImage('symbol', 'res://sprites/synthetic/tree');
    expect(builtin.bytes).toEqual(png);
    const user = await store.readImage('symbol', 'user://assets/sample é & co/trees/sample item 1 (old)');
    expect(user.key).toBe('user:sample é & co/trees/sample item 1 (old).png');
    expect(user.bytes).toEqual(png);
  });

  it('refuses over-segment user paths, symlinked leaves and FIFOs with typed errors', async () => {
    const png = makePng({ width: 2, height: 3 });
    const base = await makeDir('georama-store-v5b-');
    const userDataRoot = path.join(base, 'user');
    const trees = path.join(userDataRoot, 'assets', 'synthetic-pack', 'trees');
    await fs.mkdir(trees, { recursive: true });
    await fs.writeFile(path.join(trees, 'tree.png'), png);
    await fs.symlink(path.join(trees, 'tree.png'), path.join(trees, 'tree-link.png'));
    execFileSync('mkfifo', [path.join(trees, 'pipe.png')]);
    const store = await createAssetStore({ userDataRoot });
    openStores.push(store);
    const deep = `user://assets/p/${Array.from({ length: 14 }, (_, i) => `s${i}`).join('/')}/f`;
    await expect(store.readImage('symbol', deep)).rejects.toMatchObject({ name: 'AssetFileError', code: 'PATH' });
    await expect(store.readImage('symbol', 'user://assets/synthetic-pack/trees/tree-link')).rejects.toMatchObject({
      name: 'AssetFileError',
      code: 'PATH',
    });
    await expect(store.readImage('symbol', 'user://assets/synthetic-pack/trees/pipe')).rejects.toMatchObject({
      name: 'AssetFileError',
      code: 'TYPE',
    });
    const ok = await store.readImage('symbol', 'user://assets/synthetic-pack/trees/tree');
    expect(ok.bytes).toEqual(png);
  });

  it('surfaces a real-first close failure as typed IO without retry and proves EBADF', async () => {
    const base = await makeDir('georama-store-v5c-');
    const installRoot = path.join(base, 'install');
    await fs.mkdir(installRoot, { recursive: true });
    await fs.writeFile(
      path.join(installRoot, 'Wonderdraft.pck'),
      buildPck([{ path: 'res://sprites/synthetic/tree.wonderdraft_image', data: makePng() }]),
    );
    const require = createRequire(import.meta.url);
    const fsPromises = require('node:fs/promises') as unknown as Record<string, (...args: never[]) => Promise<unknown>>;
    const origOpen = fsPromises['open'] as (...args: never[]) => Promise<unknown>;
    const opened: unknown[] = [];
    fsPromises['open'] = async function (...args: never[]): Promise<unknown> {
      const handle = await origOpen(...args);
      opened.push(handle);
      return handle;
    };
    let store: AssetStore | undefined;
    try {
      store = await createAssetStore({ installRoot });
    } finally {
      fsPromises['open'] = origOpen;
    }
    if (!store) throw new Error('store was not created');
    const current: AssetStore = store;
    const index = openStores.length;
    openStores.push(current);
    let tracked: { fd: number; close: () => Promise<void>; stat: () => Promise<unknown> } | undefined;
    for (const handle of opened) {
      const candidate = handle as { fd: number };
      try {
        const link = await fs.readlink(`/proc/self/fd/${candidate.fd}`);
        if (link.endsWith('Wonderdraft.pck')) {
          tracked = candidate as { fd: number; close: () => Promise<void>; stat: () => Promise<unknown> };
        }
      } catch {
        /* already closed (root dir handle) */
      }
    }
    expect(tracked).not.toBe(undefined);
    const archive = tracked as { fd: number; close: () => Promise<void>; stat: () => Promise<unknown> };
    const realClose = archive.close.bind(archive);
    let closed = false;
    archive.close = async () => {
      if (closed) throw new Error('double close of the archive handle');
      closed = true;
      await realClose();
      const failure = new Error('simulated EIO on archive close') as Error & { code: string };
      failure.code = 'EIO';
      throw failure;
    };
    let attempted = false;
    try {
      const first = current.close();
      const failure = await first.catch((error: unknown) => error);
      attempted = true;
      expect(failure).toBeInstanceOf(Error);
      expect(failure as Error).toMatchObject({ name: 'PckFileError', code: 'IO' });
      expect(current.close()).toBe(first);
      await expect(first).rejects.toMatchObject({ code: 'IO' });
      await expect(archive.stat()).rejects.toMatchObject({ code: 'EBADF' });
      await expect(fs.readlink(`/proc/self/fd/${archive.fd}`)).rejects.toThrow();
    } finally {
      archive.close = realClose;
      openStores.splice(index, 1);
      if (!attempted) await current.close().catch(() => undefined);
    }
  });

  it('closes a user-only store cleanly', async () => {
    const base = await makeDir('georama-store-v5d-');
    const userDataRoot = path.join(base, 'user');
    await fs.mkdir(path.join(userDataRoot, 'assets', 'p'), { recursive: true });
    const store = await createAssetStore({ userDataRoot });
    openStores.push(store);
    await store.close();
    await store.close();
    await expect(store.readImage('symbol', 'user://assets/p/f')).rejects.toMatchObject({ code: 'CLOSED' });
  });
});

describe('asset store memory bound: four-read encoded-buffer cap', () => {
  it('holds at most four same-size encoded-data buffers across four gated user reads', async () => {
    const png = makePng({ width: 2, height: 3 });
    const base = await makeDir('georama-store-mem-');
    const userDataRoot = path.join(base, 'user');
    await fs.mkdir(path.join(userDataRoot, 'assets', 'synthetic'), { recursive: true });
    for (let i = 0; i < 4; i += 1) {
      await fs.writeFile(path.join(userDataRoot, 'assets', 'synthetic', `image-${i}.png`), png);
    }
    const store = await createAssetStore({ userDataRoot });
    openStores.push(store);
    const nativeOpen = fs.open.bind(fs);
    const NativeArray = globalThis.Uint8Array;
    const releases: Array<() => void> = [];
    let entered = 0;
    let allocations = 0;
    let settled = 0;
    let extraBeforeAnyReturn = false;
    const reads: Array<Promise<unknown>> = [];
    try {
      (fs as unknown as Record<string, unknown>)['open'] = async (...args: unknown[]) => {
        const handle = await (nativeOpen as unknown as (...a: never[]) => Promise<never>)(...(args as never[]));
        if (String((args as unknown[])[0]).endsWith('.png')) {
          const raw = (handle as unknown as { read: (...r: never[]) => Promise<unknown> }).read.bind(handle);
          let armed = true;
          (handle as unknown as { read: (...r: never[]) => Promise<unknown> }).read = async (...r: never[]) => {
            if (armed) {
              armed = false;
              entered += 1;
              await new Promise<void>((resolve) => {
                releases.push(resolve);
              });
            }
            return raw(...r);
          };
        }
        return handle;
      };
      globalThis.Uint8Array = new Proxy(NativeArray, {
        construct(target, args, newTarget) {
          if (args[0] === png.length) {
            allocations += 1;
            if (allocations > 4 && settled === 0) extraBeforeAnyReturn = true;
          }
          return Reflect.construct(target, args, newTarget);
        },
      }) as unknown as Uint8ArrayConstructor;
      for (let i = 0; i < 4; i += 1) {
        reads.push(
          store.readImage('symbol', `user://assets/synthetic/image-${i}`, png.length).then((value) => {
            settled += 1;
            return value;
          }),
        );
      }
      await waitForCondition(() => entered >= 4, 5000, 'four native data reads to reach their gates');
      expect(allocations).toBe(4);
      (releases[0] as () => void)();
      const first = (await Promise.race(reads)) as { bytes: Uint8Array };
      expect(Buffer.from(first.bytes).equals(Buffer.from(png))).toBe(true);
      expect(settled).toBe(1);
      expect(extraBeforeAnyReturn).toBe(false);
      expect(allocations).toBe(4);
    } finally {
      globalThis.Uint8Array = NativeArray;
      (fs as unknown as Record<string, unknown>)['open'] = nativeOpen;
      for (const release of releases) release();
      await Promise.allSettled(reads);
    }
  });
});

describe('asset store root capture: caller-thrown store errors normalize to ROOT without IO', () => {
  const codes = ['ROOT', 'LIMIT', 'BUSY', 'CLOSED'] as const;
  const sites = ['installRoot', 'userDataRoot', 'prototype'] as const;
  for (const site of sites) {
    for (const code of codes) {
      it(`normalizes ${code} thrown from ${site} to ROOT without IO`, async () => {
        const localRequire = createRequire(import.meta.url);
        const fsPromises = localRequire('node:fs/promises') as unknown as Record<
          string,
          (...args: never[]) => Promise<unknown>
        >;
        const origOpen = fsPromises['open'] as (...args: never[]) => Promise<unknown>;
        let opens = 0;
        fsPromises['open'] = async (...args: never[]): Promise<unknown> => {
          opens += 1;
          return origOpen(...args);
        };
        try {
          let options: unknown;
          if (site === 'prototype') {
            options = new Proxy(
              {},
              {
                getPrototypeOf(): never {
                  throw new AssetStoreError(code, `caller ${code} from prototype`);
                },
              },
            );
          } else {
            const record: Record<string, unknown> = {};
            Object.defineProperty(record, site, {
              enumerable: true,
              get(): never {
                throw new AssetStoreError(code, `caller ${code} from ${site}`);
              },
            });
            options = record;
          }
          const failure = await createAssetStore(options as never).then(
            () => null,
            (error: unknown) => error,
          );
          expect(failure).toBeInstanceOf(AssetStoreError);
          expect((failure as AssetStoreError).code).toBe('ROOT');
          expect(opens).toBe(0);
        } finally {
          fsPromises['open'] = origOpen;
        }
      });
    }
  }
});
