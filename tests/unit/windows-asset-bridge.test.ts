import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { configureWindowsAssetHelper, readWindowsAsset } from '../../electron/assets/windows-read.ts';

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}
function childProcess() {
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

beforeAll(() => configureWindowsAssetHelper(fileURLToPath(new URL('../../', import.meta.url))));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('bounded native Windows process bridge (portable mocks)', () => {
  it('ignores a hostile working directory when choosing the executable', async () => {
    const child = childProcess();
    const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url));
    const fakeCwd = path.join(checkoutRoot, 'attacker-controlled');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);
    let work: ReturnType<typeof readWindowsAsset>;
    try {
      work = readWindowsAsset('C:\\assets', 'pack/leaf.png', 8);
    } finally {
      cwd.mockRestore();
    }
    expect(spawn).toHaveBeenCalledWith(
      path.join(checkoutRoot, 'out', 'windows', 'georama-win-asset-read.exe'),
      expect.any(Array),
      expect.any(Object),
    );
    child.emit('close', 0);
    expect(await work).toEqual({ bytes: new Uint8Array() });
  });

  it('returns binary-safe bytes only after a clean zero exit', async () => {
    const child = childProcess();
    const work = readWindowsAsset('C:\\assets', 'pack/tree.png', 5);
    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining('georama-win-asset-read.exe'),
      ['C:\\assets', 'pack/tree.png', '5'],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true },
    );
    child.stdout.emit('data', Buffer.from([0, 1, 255]));
    child.stdout.emit('data', Buffer.from([13, 0]));
    child.emit('close', 0);
    expect(await work).toEqual({ bytes: new Uint8Array([0, 1, 255, 13, 0]) });
  });

  it.each(['PATH', 'TYPE', 'MISSING', 'LIMIT', 'IO'])('preserves only known path-free %s failure tokens', async (code) => {
    const child = childProcess();
    const work = readWindowsAsset('C:\\assets', 'pack/missing.png', 9);
    child.stderr.emit('data', Buffer.from(code + '\n'));
    child.emit('close', 1);
    expect(await work).toEqual({ error: code });
  });

  it('rejects malformed helper stderr and nonzero exits without leaking output', async () => {
    const child = childProcess();
    const work = readWindowsAsset('C:\\assets', 'pack/leaf.png', 10);
    child.stdout.emit('data', Buffer.from('partial'));
    child.stderr.emit('data', Buffer.from('ERROR: C:\\private\\secret'));
    child.emit('close', 2);
    expect(await work).toEqual({ error: 'IO' });
  });

  it('rejects a successful exit with unexpected stderr', async () => {
    const child = childProcess();
    const work = readWindowsAsset('C:\\assets', 'pack/leaf.png', 10);
    child.stderr.emit('data', Buffer.from('unexpected'));
    child.emit('close', 0);
    expect(await work).toEqual({ error: 'IO' });
  });

  it('kills a helper that attempts to exceed the authorized byte cap', async () => {
    const child = childProcess();
    const work = readWindowsAsset('C:\\assets', 'pack/leaf.png', 3);
    child.stdout.emit('data', Buffer.from([1, 2, 3, 4]));
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null);
    expect(await work).toEqual({ error: 'LIMIT' });
  });

  it('treats absent executables and spawn failures as IO', async () => {
    const child = childProcess();
    const work = readWindowsAsset('C:\\assets', 'pack/leaf.png', 3);
    child.emit('error', Object.assign(new Error('missing helper'), { code: 'ENOENT' }));
    child.emit('close', -1);
    expect(await work).toEqual({ error: 'IO' });
  });

  it('rejects invalid caps without spawning a native executable', async () => {
    for (const cap of [-1, NaN, Infinity, 0.5, 64 * 1024 * 1024 + 1]) {
      expect(await readWindowsAsset('C:\\assets', 'pack/tree.png', cap)).toEqual({ error: 'LIMIT' });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('admits four in-flight helpers, rejects the fifth, and recovers a slot on close', async () => {
    const children = Array.from({ length: 5 }, () => fakeChild());
    let spawned = 0;
    vi.mocked(spawn).mockImplementation(() =>
      children[spawned++] as unknown as ReturnType<typeof spawn>);
    const calls = Array.from({ length: 4 }, () => readWindowsAsset('C:\\assets', 'pack/tree.png', 8));
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(await readWindowsAsset('C:\\assets', 'pack/tree.png', 8)).toEqual({ error: 'BUSY' });
    expect(spawn).toHaveBeenCalledTimes(4);
    children[0].emit('close', 0);
    expect(await calls[0]).toEqual({ bytes: new Uint8Array() });
    const fifth = readWindowsAsset('C:\\assets', 'pack/tree.png', 8);
    expect(spawn).toHaveBeenCalledTimes(5);
    for (const child of children.slice(1)) child.emit('close', 0);
    expect((await Promise.all([...calls.slice(1), fifth])).every((result) =>
      result.bytes instanceof Uint8Array)).toBe(true);
  });

  it('does not release a stopped helper slot before its process closes', async () => {
    const children = Array.from({ length: 5 }, () => fakeChild());
    let spawned = 0;
    vi.mocked(spawn).mockImplementation(() =>
      children[spawned++] as unknown as ReturnType<typeof spawn>);
    const first = readWindowsAsset('C:\\assets', 'pack/tree.png', 1);
    children[0].stdout.emit('data', Buffer.from([1, 2]));
    expect(children[0].kill).toHaveBeenCalledOnce();
    const other = Array.from({ length: 3 }, () => readWindowsAsset('C:\\assets', 'pack/tree.png', 1));
    expect(await readWindowsAsset('C:\\assets', 'pack/tree.png', 1)).toEqual({ error: 'BUSY' });
    children[0].emit('close', null);
    expect(await first).toEqual({ error: 'LIMIT' });
    const next = readWindowsAsset('C:\\assets', 'pack/tree.png', 1);
    expect(spawn).toHaveBeenCalledTimes(5);
    for (const child of children.slice(1)) child.emit('close', 0);
    await Promise.all([...other, next]);
  });

  it('kills unresponsive children on deadline and closes the result without leaked output', async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const first = readWindowsAsset('C:\\assets', 'pack/tree.png', 4);
    child.stdout.emit('data', Buffer.from([65]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null);
    expect(await first).toEqual({ error: 'IO' });
  });

  it('resolves after a bounded termination grace but retains slot until late close', async () => {
    vi.useFakeTimers();
    const children = Array.from({ length: 5 }, () => fakeChild());
    let spawned = 0;
    vi.mocked(spawn).mockImplementation(() =>
      children[spawned++] as unknown as ReturnType<typeof spawn>);
    const stalled = readWindowsAsset('C:\\assets', 'pack/tree.png', 8);
    await vi.advanceTimersByTimeAsync(63_000);
    expect(await stalled).toEqual({ error: 'IO' });
    const others = Array.from({ length: 3 }, () => readWindowsAsset('C:\\assets', 'pack/tree.png', 8));
    expect(await readWindowsAsset('C:\\assets', 'pack/tree.png', 8)).toEqual({ error: 'BUSY' });
    children[0].emit('close', null);
    const fifth = readWindowsAsset('C:\\assets', 'pack/tree.png', 8);
    for (const child of children.slice(1)) child.emit('close', 0);
    await Promise.all([...others, fifth]);
  });

  it('recovers its slot after a synchronous spawn throw and after failed startup', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('not executable'); });
    expect(await readWindowsAsset('C:\\assets', 'pack/tree.png', 8)).toEqual({ error: 'IO' });
    const child = childProcess();
    const subsequent = readWindowsAsset('C:\\assets', 'pack/tree.png', 8);
    child.emit('close', 0);
    expect(await subsequent).toEqual({ bytes: new Uint8Array() });
  });

  it('aborts when stdout or stderr stream errors rather than treating output as verified', async () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const child = childProcess();
      const work = readWindowsAsset('C:\\assets', 'pack/tree.png', 8);
      child[stream].emit('error', new Error('stream broke'));
      expect(child.kill).toHaveBeenCalledOnce();
      child.emit('close', null);
      expect(await work).toEqual({ error: 'IO' });
    }
  });


  it('never returns bytes received after its output budget has been exceeded', async () => {
    const child = childProcess();
    const work = readWindowsAsset('C:\\assets', 'pack/tree.png', 3);
    child.stdout.emit('data', Buffer.from([1, 2]));
    child.stdout.emit('data', Buffer.from([3, 4]));
    child.stdout.emit('data', Buffer.from([5, 6]));
    child.emit('close', 0);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(await work).toEqual({ error: 'LIMIT' });
  });

  it('handles synchronous close during kill without leaking a helper slot', async () => {
    const child = childProcess();
    child.kill.mockImplementation(() => {
      child.emit('close', null);
      return true;
    });
    const work = readWindowsAsset('C:\\assets', 'pack/tree.png', 1);
    child.stdout.emit('data', Buffer.from([1, 2]));
    expect(await work).toEqual({ error: 'LIMIT' });
    const nextChild = childProcess();
    const next = readWindowsAsset('C:\\assets', 'pack/tree.png', 1);
    nextChild.emit('close', 0);
    expect(await next).toEqual({ bytes: new Uint8Array() });
  });

});
