import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { launcherSignals, resolveDisplayEnv } from '../../scripts/display-env.mjs';
import type { DisplayFileSystem } from '../../scripts/display-env.mjs';

function filesystem(sockets: readonly string[]): DisplayFileSystem {
  return {
    async readdir(directory) {
      return sockets.filter((socket) => socket.slice(0, socket.lastIndexOf('/')) === directory)
        .map((socket) => socket.slice(socket.lastIndexOf('/') + 1));
    },
    async stat(socket) {
      return { isSocket: () => sockets.includes(socket) };
    },
  };
}

describe('launcher display resolution', () => {
  it('uses an absolute fallback socket when the inherited runtime directory differs', async () => {
    const env = { XDG_RUNTIME_DIR: '/inherited', DISPLAY: ':7' };
    const result = await resolveDisplayEnv({ env, uid: 1000, fs: filesystem(['/run/user/1000/wayland-0']) });
    expect(result).toEqual({
      env: { ...env, WAYLAND_DISPLAY: '/run/user/1000/wayland-0' },
      args: ['--ozone-platform=wayland'],
    });
    expect(env).toEqual({ XDG_RUNTIME_DIR: '/inherited', DISPLAY: ':7' });
  });

  it('discovers the default environment socket and runtime directory', async () => {
    expect(await resolveDisplayEnv({ env: {}, uid: 1000, fs: filesystem(['/run/user/1000/wayland-1']) })).toEqual({
      env: { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-1' },
      args: ['--ozone-platform=wayland'],
    });
  });

  it('prefers the inherited directory over the fallback even with a higher socket number', async () => {
    expect(await resolveDisplayEnv({
      env: { XDG_RUNTIME_DIR: '/inherited' }, uid: 1000,
      fs: filesystem(['/run/user/1000/wayland-0', '/inherited/wayland-9']),
    })).toEqual({ env: { XDG_RUNTIME_DIR: '/inherited', WAYLAND_DISPLAY: 'wayland-9' }, args: ['--ozone-platform=wayland'] });
  });

  it.each([
    ['wayland-1', 'wayland-0', 'wayland-0'],
    ['wayland-10', 'wayland-2', 'wayland-2'],
  ])('orders %s and %s numerically', async (first, second, expected) => {
    const result = await resolveDisplayEnv({ env: {}, uid: 1000, fs: filesystem([`/run/user/1000/${first}`, `/run/user/1000/${second}`]) });
    expect(result.env.WAYLAND_DISPLAY).toBe(expected);
  });

  it('leaves a set-but-missing socket and its display configuration untouched', async () => {
    const env = { WAYLAND_DISPLAY: 'wayland-7', XDG_RUNTIME_DIR: '/inherited', DISPLAY: ':7' };
    expect(await resolveDisplayEnv({ env, uid: 1000, fs: filesystem(['/run/user/1000/wayland-0']) })).toEqual({ env, args: [] });
  });

  it('resolves an explicitly selected relative socket in the inherited directory', async () => {
    const env = { WAYLAND_DISPLAY: 'wayland-4', XDG_RUNTIME_DIR: '/inherited' };
    expect(await resolveDisplayEnv({ env, uid: 1000, fs: filesystem(['/inherited/wayland-4']) })).toEqual({ env, args: ['--ozone-platform=wayland'] });
  });

  it('supplies the default runtime directory for an existing relative socket', async () => {
    expect(await resolveDisplayEnv({ env: { WAYLAND_DISPLAY: 'wayland-4' }, uid: 1000, fs: filesystem(['/run/user/1000/wayland-4']) })).toEqual({
      env: { WAYLAND_DISPLAY: 'wayland-4', XDG_RUNTIME_DIR: '/run/user/1000' }, args: ['--ozone-platform=wayland'],
    });
  });

  it('checks an absolute WAYLAND_DISPLAY without joining it to the inherited directory', async () => {
    const env = { WAYLAND_DISPLAY: '/other/socket', XDG_RUNTIME_DIR: '/inherited' };
    expect(await resolveDisplayEnv({ env, uid: 1000, fs: filesystem(['/other/socket']) })).toEqual({ env, args: ['--ozone-platform=wayland'] });
  });

  it('does not invent a runtime directory for an absolute socket', async () => {
    const env = { WAYLAND_DISPLAY: '/other/socket' };
    expect(await resolveDisplayEnv({ env, uid: 1000, fs: filesystem(['/other/socket']) })).toEqual({ env, args: ['--ozone-platform=wayland'] });
  });

  it('leaves the environment untouched when nothing is found', async () => {
    const env = { DISPLAY: ':7', KEEP: 'unchanged' };
    expect(await resolveDisplayEnv({ env, uid: 1000, fs: filesystem([]) })).toEqual({ env, args: [] });
  });

  it('does not mistake a lock file or a non-socket file for a display', async () => {
    const fs: DisplayFileSystem = {
      readdir: async () => ['wayland-0.lock', 'wayland-0', 'wayland-1'],
      stat: async (socket) => ({ isSocket: () => socket.endsWith('wayland-1') }),
    };
    expect((await resolveDisplayEnv({ env: {}, uid: 1000, fs })).env.WAYLAND_DISPLAY).toBe('wayland-1');
  });

  it.each(['ENOENT', 'EACCES', 'ENOTDIR'])('tries the fallback after %s in the inherited directory', async (code) => {
    const fs = filesystem(['/run/user/1000/wayland-0']);
    const readdir = fs.readdir;
    fs.readdir = async (directory) => {
      if (directory === '/inherited') throw Object.assign(new Error('unavailable'), { code });
      return readdir(directory);
    };
    expect((await resolveDisplayEnv({ env: { XDG_RUNTIME_DIR: '/inherited' }, uid: 1000, fs })).env.WAYLAND_DISPLAY).toBe('/run/user/1000/wayland-0');
  });

  it('returns an empty result without throwing when a file as XDG_RUNTIME_DIR (ENOTDIR) has no fallback socket', async () => {
    const fs = filesystem([]);
    fs.readdir = async (directory) => {
      if (directory === '/inherited') throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      return [];
    };
    const env = { XDG_RUNTIME_DIR: '/inherited' };
    await expect(resolveDisplayEnv({ env, uid: 1000, fs })).resolves.toEqual({ env, args: [] });
  });

  it('skips a socket removed between listing and stat', async () => {
    const fs = filesystem(['/run/user/1000/wayland-1']);
    fs.readdir = async () => ['wayland-0', 'wayland-1'];
    const stat = fs.stat;
    fs.stat = async (socket) => {
      if (socket.endsWith('wayland-0')) throw Object.assign(new Error('removed'), { code: 'ENOENT' });
      return stat(socket);
    };
    expect((await resolveDisplayEnv({ env: {}, uid: 1000, fs })).env.WAYLAND_DISPLAY).toBe('wayland-1');
  });

  it('does not hide unexpected directory errors', async () => {
    const fs = filesystem([]);
    fs.readdir = async () => { throw Object.assign(new Error('IO failure'), { code: 'EIO' }); };
    await expect(resolveDisplayEnv({ env: {}, uid: 1000, fs })).rejects.toThrow('IO failure');
  });
});

describe('launcher wiring', () => {
  it('passes CLI arguments as an unchanged vector and forwards every termination signal', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const argv = process.argv;
    const exitCode = process.exitCode;
    const signals = launcherSignals(process.platform);
    const before = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
    const priorHangupListeners = process.listeners('SIGHUP');
    const args = ['.', '--flag=value with spaces', '$(literal; no shell)', '--ozone-platform=x11'];
    // The launcher calls require('electron') to locate its binary. We stub
    // spawn, so selecting a fake distribution path avoids all network I/O.
    vi.stubEnv('ELECTRON_OVERRIDE_DIST_PATH', '/virtual-georama-electron');
    vi.stubEnv('WAYLAND_DISPLAY', '/does-not-exist/georama-test-socket');
    process.argv = ['node', 'scripts/run-electron.mjs', ...args];
    try {
      await import(new URL('../../scripts/run-electron.mjs', import.meta.url).href);
      expect(spawn).toHaveBeenCalledWith(expect.any(String), args, { env: expect.objectContaining({ WAYLAND_DISPLAY: '/does-not-exist/georama-test-socket' }), stdio: 'inherit' });
      if (process.platform === 'win32') {
        expect(process.listeners('SIGHUP')).toEqual(priorHangupListeners);
      }
      for (const signal of signals) {
        const handlers = process.listeners(signal).filter((handler) => !before.get(signal)?.includes(handler));
        expect(handlers).toHaveLength(1);
        handlers[0]?.(signal);
        expect(child.kill).toHaveBeenLastCalledWith(signal);
      }
      child.emit('exit', 0, null);
      for (const signal of signals) expect(process.listeners(signal)).toEqual(before.get(signal));
    } finally {
      child.emit('exit', 0, null);
      process.argv = argv;
      process.exitCode = exitCode;
      vi.unstubAllEnvs();
    }
  });
});
