import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}

const resources = path.join(os.tmpdir(), 'georama-packaged-test', 'resources');

beforeEach(() => {
  vi.resetModules(); // Each test must bind its own one-shot trusted app root.
  vi.clearAllMocks();
});

describe('Windows asset executable in a packaged Electron layout', () => {
  it.each([
    ['unpacked resources/app', path.join(resources, 'app'), path.join(resources, 'app', 'out', 'windows')],
    ['archived app.asar', path.join(resources, 'app.asar'), path.join(resources, 'app.asar.unpacked', 'out', 'windows')],
  ])('spawns from the physical %s helper directory, not an archive member', async (_layout, appRoot, helperDir) => {
    const { configureWindowsAssetHelper, readWindowsAsset } = await import('../../electron/assets/windows-read.ts');
    configureWindowsAssetHelper(appRoot);
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const work = readWindowsAsset('C:\\assets', 'pack/leaf.png', 3);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      path.join(helperDir, 'georama-win-asset-read.exe'),
      ['C:\\assets', 'pack/leaf.png', '3'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false },
    );
    child.stdout.emit('data', Buffer.from([0, 1, 255]));
    child.emit('close', 0);
    expect(await work).toEqual({ bytes: new Uint8Array([0, 1, 255]) });
  });

  it('fails closed when the app.asar.unpacked executable is absent, with no path fallback', async () => {
    const { configureWindowsAssetHelper, readWindowsAsset } = await import('../../electron/assets/windows-read.ts');
    configureWindowsAssetHelper(path.join(resources, 'app.asar'));
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const work = readWindowsAsset('C:\\assets', 'pack/leaf.png', 3);
    child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }));
    child.emit('close', -1);
    expect(await work).toEqual({ error: 'IO' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe(path.join(
      resources, 'app.asar.unpacked', 'out', 'windows', 'georama-win-asset-read.exe',
    ));
  });

  it('preserves a watchdog TIMEOUT at the public asset-file error boundary', async () => {
    const { configureWindowsAssetHelper } = await import('../../electron/assets/windows-read.ts');
    const { readAssetFile } = await import('../../electron/assets/open.ts');
    configureWindowsAssetHelper(path.join(resources, 'app.asar'));
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (originalPlatform === undefined) throw new Error('process.platform descriptor missing');
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    vi.useFakeTimers();
    try {
      const pending = readAssetFile('C:\\assets', 'pack/leaf.png', 3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(child.kill).toHaveBeenCalledOnce();
      child.emit('close', null);
      await expect(pending).rejects.toMatchObject({ name: 'AssetFileError', code: 'TIMEOUT' });
    } finally {
      vi.useRealTimers();
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
});
