import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AssetFileError, ASSET_FILE_LIMITS, readAssetFile } from '../../electron/assets/open.ts';

const fixtures: string[] = [];
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'georama-asset-file-'));
  fixtures.push(base);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, 'pack'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'pack', 'leaf.png'), 'inside');
  await fs.writeFile(path.join(outside, 'leaf.png'), 'outside-secret');
  return { base, root, outside };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of fixtures.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function fails(promise: Promise<unknown>, code: string) {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(AssetFileError);
    expect((error as AssetFileError).code).toBe(code);
    expect((error as Error).message).not.toContain(os.tmpdir());
    return;
  }
  throw new Error(`expected AssetFileError/${code}`);
}

describe('scoped Linux asset byte reader', () => {
  it('reads exact bytes below the authorized directory without writing them', async () => {
    const { root } = await fixture();
    const data = await readAssetFile(root, 'pack/leaf.png', 6);
    expect(data).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(data)).toBe('inside');
    expect(await fs.readFile(path.join(root, 'pack/leaf.png'), 'utf8')).toBe('inside');
  });
  it('refuses traversal and executable extensions before any filesystem access', async () => {
    const open = vi.spyOn(fs, 'open');
    await fails(readAssetFile('/nonexistent-asset-root', '../outside/leaf.png'), 'PATH');
    await fails(readAssetFile('/nonexistent-asset-root', 'pack/code.gdc'), 'EXTENSION');
    expect(open).not.toHaveBeenCalled();
  });
  it('does not follow a pack directory or final-file symlink outside the root', async () => {
    const { root, outside } = await fixture();
    await fs.symlink(outside, path.join(root, 'linked'));
    await fs.symlink(path.join(outside, 'leaf.png'), path.join(root, 'pack', 'link.png'));
    await fails(readAssetFile(root, 'linked/leaf.png'), 'PATH');
    await fails(readAssetFile(root, 'pack/link.png'), 'PATH');
  });

  it.each([
    '../leaf.png', '/leaf.png', 'a//leaf.png', 'a/./leaf.png', 'a/../leaf.png',
    'a/.hidden/leaf.png', 'a/.wonderdraft_symbols/leaf.png', 'a/leaf.png/',
    'a\\leaf.png', 'a/leaf\0.png', 'a/leaf\n.png', 'a/x:y.png', 'a/x?.png',
    'a/\ud800.png', 'a/\udfff.png', 'a/\ufeff.png', 'a/\u202e.png',
    `${'s/'.repeat(16)}leaf.png`, `${'é'.repeat(128)}.png`,
  ])('refuses hostile relative path %j without I/O', async (relative) => {
    const open = vi.spyOn(fs, 'open');
    const canonicalize = vi.spyOn(fs, 'realpath');
    await fails(readAssetFile('/nonexistent-asset-root', relative), 'PATH');
    expect(open).not.toHaveBeenCalled();
    expect(canonicalize).not.toHaveBeenCalled();
  });
  it.each([null, undefined, 42, '', 'relative', '/a/../b', '/a//b', '/bad\0root'])(
    'rejects malformed root %j', async (root) => {
      await fails(readAssetFile(root as string, 'leaf.png'), 'PATH');
    },
  );
  it.each([-1, 0.5, NaN, Infinity, '8', null, ASSET_FILE_LIMITS.maxBytes + 1])(
    'rejects malformed or raised byte cap %j before I/O', async (cap) => {
      const open = vi.spyOn(fs, 'open');
      await fails(readAssetFile('/missing', 'leaf.png', cap as number), 'LIMIT');
      expect(open).not.toHaveBeenCalled();
    },
  );
  it('pins empty, exact, too-small and global byte limits', async () => {
    const { root } = await fixture();
    expect(Object.isFrozen(ASSET_FILE_LIMITS)).toBe(true);
    expect(ASSET_FILE_LIMITS).toEqual({ maxBytes: 64 * 1024 * 1024, maxPathChars: 4096, maxSegments: 16, maxSegmentBytes: 255 });
    await fails(readAssetFile(root, 'pack/leaf.png', 5), 'LIMIT');
    expect((await readAssetFile(root, 'pack/leaf.png', 6)).length).toBe(6);
    await fs.writeFile(path.join(root, 'pack', 'empty.png'), '');
    expect((await readAssetFile(root, 'pack/empty.png', 0)).length).toBe(0);
    await fails(readAssetFile(root, 'pack/leaf.png', 0), 'LIMIT');
    const huge = await fs.open(path.join(root, 'pack', 'huge.png'), 'w');
    try { await huge.truncate(ASSET_FILE_LIMITS.maxBytes + 1); } finally { await huge.close(); }
    await fails(readAssetFile(root, 'pack/huge.png'), 'LIMIT');
  });
  it('accepts metadata dotfiles, astral names, opaque percent names and the exact segment-byte boundary', async () => {
    const { root } = await fixture();
    const exact = `${'é'.repeat(125)}a.png`;
    expect(Buffer.byteLength(exact)).toBe(255);
    for (const name of ['.wonderdraft_symbols', 'paper.wonderdraft_theme', 'leaf.wonderdraft_image', 'café 😀.png', '%2e%2e.png', exact]) {
      await fs.writeFile(path.join(root, 'pack', name), 'data');
      expect(new TextDecoder().decode(await readAssetFile(root, `pack/${name}`))).toBe('data');
    }
  });
  it('accepts exactly sixteen path segments beneath the root', async () => {
    const { root } = await fixture();
    const dirs = Array.from({ length: 15 }, (_, i) => `level${i}`);
    await fs.mkdir(path.join(root, ...dirs), { recursive: true });
    await fs.writeFile(path.join(root, ...dirs, 'leaf.png'), 'deep');
    expect(new TextDecoder().decode(await readAssetFile(root, [...dirs, 'leaf.png'].join('/')))).toBe('deep');
  });
  it('treats punctuation in an explicitly authorized Linux root as literal path characters', async () => {
    const { base, root } = await fixture();
    const literalRoot = path.join(base, 'authorized:root?*');
    await fs.rename(root, literalRoot);
    expect(new TextDecoder().decode(await readAssetFile(literalRoot, 'pack/leaf.png'))).toBe('inside');
  });
  it('allows an explicitly authorized symlink root, never descendant links including internal ones', async () => {
    const { base, root } = await fixture();
    await fs.symlink(root, path.join(base, 'authorized-root'));
    expect(new TextDecoder().decode(await readAssetFile(path.join(base, 'authorized-root'), 'pack/leaf.png'))).toBe('inside');
    await fs.symlink(path.join(root, 'pack'), path.join(root, 'internal'));
    await fails(readAssetFile(root, 'internal/leaf.png'), 'PATH');
    await fs.symlink(path.join(root, 'absent'), path.join(root, 'dangling.png'));
    await fails(readAssetFile(root, 'dangling.png'), 'PATH');
  });
  it('anchors an already-opened parent even when its pathname is replaced with an outside symlink', async () => {
    const { base, root, outside } = await fixture();
    const actualOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await actualOpen(file, flags, mode);
      if (String(file).startsWith('/proc/self/fd/') && String(file).endsWith('/pack') && !swapped) {
        swapped = true;
        await fs.rename(path.join(root, 'pack'), path.join(base, 'held-pack'));
        await fs.symlink(outside, path.join(root, 'pack'));
      }
      return handle;
    });
    expect(new TextDecoder().decode(await readAssetFile(root, 'pack/leaf.png'))).toBe('inside');
    expect(swapped).toBe(true);
    await fails(readAssetFile(root, 'pack/leaf.png'), 'PATH');
  });
  it('refuses a root replaced with a symlink between canonicalization and open', async () => {
    const { base, root, outside } = await fixture();
    const actualOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file) === root && !swapped) {
        swapped = true;
        await fs.rename(root, path.join(base, 'former-root'));
        await fs.symlink(outside, root);
      }
      return actualOpen(file, flags, mode);
    });
    await fails(readAssetFile(root, 'pack/leaf.png'), 'PATH');
    expect(swapped).toBe(true);
  });
  it('refuses a descriptor whose canonical root identity no longer matches', async () => {
    const { root, outside } = await fixture();
    const canonicalize = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation(async (file) =>
      String(file).startsWith('/proc/self/fd/') ? outside : canonicalize(file));
    await fails(readAssetFile(root, 'pack/leaf.png'), 'PATH');
  });
  it('refuses directories, missing files and unreadable files with path-free typed errors', async () => {
    const { root } = await fixture();
    await fs.mkdir(path.join(root, 'folder.png'));
    await fails(readAssetFile(root, 'folder.png'), 'TYPE');
    await fails(readAssetFile(root, 'absent.png'), 'MISSING');
    const open = vi.spyOn(fs, 'open');
    open.mockRejectedValueOnce(Object.assign(new Error(path.join(root, 'private-fixture')), { code: 'EACCES' }));
    await fails(readAssetFile(root, 'pack/leaf.png'), 'IO');
  });
  it('opens FIFOs nonblocking and rejects them before a read in a real child process', async () => {
    const { root } = await fixture();
    const fifo = path.join(root, 'pack', 'pipe.png');
    execFileSync('mkfifo', [fifo]);
    const source = new URL('../../electron/assets/open.ts', import.meta.url).href;
    const script = `import {readAssetFile,AssetFileError} from ${JSON.stringify(source)};\n` +
      `try{await readAssetFile(${JSON.stringify(root)},'pack/pipe.png');process.exitCode=2;}` +
      `catch(e){if(!(e instanceof AssetFileError)||e.code!=='TYPE')throw e;console.log('TYPE');}`;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 }).trim()).toBe('TYPE');
  });
  it.each(['grow', 'shrink'] as const)('refuses a file that will %s after its first fstat', async (change) => {
    const { root } = await fixture();
    const actualOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await actualOpen(file, flags, mode);
      if (String(file).endsWith('/leaf.png')) {
        const stat = handle.stat.bind(handle);
        let first = true;
        Object.defineProperty(handle, 'stat', { value: async () => {
          const snapshot = await stat({ bigint: true });
          if (first) {
            first = false;
            if (change === 'grow') await fs.appendFile(path.join(root, 'pack', 'leaf.png'), '!');
            else await fs.truncate(path.join(root, 'pack', 'leaf.png'), 0);
          }
          return snapshot;
        } });
      }
      return handle;
    });
    await fails(readAssetFile(root, 'pack/leaf.png', 10), 'IO');
  });
  it.each([null, undefined, 42, {}, [], true])('rejects wrong-typed relative input %j before I/O', async (relative) => {
    const canonicalize = vi.spyOn(fs, 'realpath');
    await fails(readAssetFile('/unused', relative as string), 'PATH');
    expect(canonicalize).not.toHaveBeenCalled();
  });
  it.each(['a', 'leaf.PNG', 'code.gdc', 'image.png.gdc'])('denies unsupported suffix %j before I/O', async (relative) => {
    const canonicalize = vi.spyOn(fs, 'realpath');
    await fails(readAssetFile('/unused', relative), 'EXTENSION');
    expect(canonicalize).not.toHaveBeenCalled();
  });
  it('pins root slash and exact character bounds without reading the real filesystem root', async () => {
    const canonicalize = vi.spyOn(fs, 'realpath');
    canonicalize.mockRejectedValue(Object.assign(new Error('intentional lookup refusal'), { code: 'ENOENT' }));
    const exact = '/' + Array.from({ length: 16 }, () => 'a'.repeat(255)).join('/');
    expect(exact.length).toBe(4096);
    await fails(readAssetFile('/', 'leaf.png'), 'MISSING');
    await fails(readAssetFile(exact, 'leaf.png'), 'MISSING');
    expect(canonicalize).toHaveBeenCalledTimes(2);
    await fails(readAssetFile(exact + 'a', 'leaf.png'), 'PATH');
    expect(canonicalize).toHaveBeenCalledTimes(2);
  });
  it.each([null, undefined, 42, 'failure', false])('wraps wrong-typed filesystem rejection %j into path-free IO', async (error) => {
    const { root } = await fixture();
    vi.spyOn(fs, 'open').mockRejectedValueOnce(error);
    await fails(readAssetFile(root, 'pack/leaf.png'), 'IO');
  });
  it('handles short reads with exact offsets and a one-byte EOF check', async () => {
    const { root } = await fixture();
    const actualOpen = fs.open.bind(fs);
    const calls: number[][] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await actualOpen(file, flags, mode);
      if (String(file).endsWith('/leaf.png')) {
        const read = handle.read.bind(handle);
        Object.defineProperty(handle, 'read', { value: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          calls.push([buffer.length, offset, length, position]);
          return read(buffer, offset, Math.min(length, 1), position);
        } });
      }
      return handle;
    });
    expect(new TextDecoder().decode(await readAssetFile(root, 'pack/leaf.png'))).toBe('inside');
    expect(calls).toEqual([
      [6, 0, 6, 0], [6, 1, 5, 1], [6, 2, 4, 2], [6, 3, 3, 3], [6, 4, 2, 4], [6, 5, 1, 5], [1, 0, 1, 6],
    ]);
  });
  it('rejects a too-large stat before any payload read', async () => {
    const { root } = await fixture();
    const actualOpen = fs.open.bind(fs);
    const reads = vi.fn(() => { throw new Error('payload read must not happen'); });
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await actualOpen(file, flags, mode);
      if (String(file).endsWith('/leaf.png')) Object.defineProperty(handle, 'read', { value: reads });
      return handle;
    });
    await fails(readAssetFile(root, 'pack/leaf.png', 5), 'LIMIT');
    expect(reads).not.toHaveBeenCalled();
  });
  it.each(['size', 'mtimeNs', 'ctimeNs', 'extraRead'] as const)('checks independent post-read observation %s', async (field) => {
    const { root } = await fixture();
    const actualOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await actualOpen(file, flags, mode);
      if (String(file).endsWith('/leaf.png')) {
        const stat = handle.stat.bind(handle);
        let count = 0;
        Object.defineProperty(handle, 'stat', { value: async () => {
          const snapshot = await stat({ bigint: true });
          if (count++ > 0 && field !== 'extraRead') Object.defineProperty(snapshot, field, { value: snapshot[field] + 1n });
          return snapshot;
        } });
        if (field === 'extraRead') {
          const read = handle.read.bind(handle);
          Object.defineProperty(handle, 'read', { value: async (buffer: Uint8Array, offset: number, length: number, position: number) =>
            position === 6 ? { bytesRead: 1, buffer } : read(buffer, offset, length, position) });
        }
      }
      return handle;
    });
    await fails(readAssetFile(root, 'pack/leaf.png', 10), 'IO');
  });
  it('distinguishes growth past the cap from other concurrent changes', async () => {
    const { root } = await fixture();
    const actualOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await actualOpen(file, flags, mode);
      if (String(file).endsWith('/leaf.png')) {
        const stat = handle.stat.bind(handle);
        let first = true;
        Object.defineProperty(handle, 'stat', { value: async () => {
          const snapshot = await stat({ bigint: true });
          if (first) { first = false; await fs.appendFile(path.join(root, 'pack', 'leaf.png'), '!'); }
          return snapshot;
        } });
      }
      return handle;
    });
    await fails(readAssetFile(root, 'pack/leaf.png', 6), 'LIMIT');
  });
  it('refuses operating systems without a native asset backend before filesystem access', async () => {
    const { root } = await fixture();
    const source = new URL('../../electron/assets/open.ts', import.meta.url).href;
    const script = `Object.defineProperty(process,'platform',{value:'darwin'});` +
      `const {readAssetFile,AssetFileError}=await import(${JSON.stringify(source)});` +
      `try{await readAssetFile(${JSON.stringify(root)},'pack/leaf.png');process.exitCode=2;}` +
      `catch(e){if(!(e instanceof AssetFileError)||e.code!=='IO')throw e;console.log('IO');}`;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 }).trim()).toBe('IO');
  });
  it('closes every opened descriptor on success and partial failure; flags are read-only and no-follow', async () => {
    const { constants } = await import('node:fs');
    const { root } = await fixture();
    const actualOpen = fs.open.bind(fs);
    const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      expect(typeof flags).toBe('number');
      const numeric = flags as number;
      expect(numeric & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(numeric & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      const isLeaf = String(file).endsWith('/leaf.png') || String(file).endsWith('/missing.png');
      expect(numeric & constants.O_DIRECTORY).toBe(isLeaf ? 0 : constants.O_DIRECTORY);
      expect(numeric & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC)).toBe(0);
      const handle = await actualOpen(file, flags, mode);
      opened.push(handle);
      return handle;
    });
    await readAssetFile(root, 'pack/leaf.png');
    expect(opened.length).toBe(3);
    for (const handle of opened) await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    opened.length = 0;
    await fails(readAssetFile(root, 'pack/missing.png'), 'MISSING');
    expect(opened.length).toBe(2);
    for (const handle of opened) await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });
});
