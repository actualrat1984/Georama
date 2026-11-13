import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAbsolutePath, configFilePath, parseConfig, resolveRoots } from '../../electron/assets/config.ts';
import { createAssetStore } from '../../electron/assets/store.ts';
import { openPckFile } from '../../electron/assets/pck-file.ts';
import { readSelectedConfigFile } from '../../electron/data/config-file.ts';
import { readSelectedDataFile, SelectedFileError } from '../../electron/data/selected-file.ts';
import { configureWindowsSelectedFileHelper } from '../../electron/data/windows-selected-read.ts';

const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url));
const nativeHelper = path.join(checkoutRoot, 'out', 'windows', 'georama-win-selected-read.exe');
const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'georama-windows-files-')));
  roots.push(root);
  return root;
}
beforeAll(async () => {
  if (process.platform === 'win32') {
    configureWindowsSelectedFileHelper(checkoutRoot);
    await fs.access(nativeHelper);
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('native Windows file and root boundaries', () => {
  it('reads selected Windows .json and .wonderdraft_map from held descriptors', async () => {
    const root = await fixture();
    const pathToMap = path.join(root, 'world 🗺.wonderdraft_map');
    const pathToJson = path.join(root, 'metadata.json');
    await fs.writeFile(pathToMap, new Uint8Array([0, 1, 2, 3, 255]));
    await fs.writeFile(pathToJson, '{"hello":"world"}');
    expect(Array.from(await readSelectedDataFile(pathToMap, 5))).toEqual([0, 1, 2, 3, 255]);
    expect(new TextDecoder().decode(await readSelectedDataFile(pathToJson, 64))).toBe('{"hello":"world"}');
    await expect(readSelectedDataFile(pathToMap, 4)).rejects.toMatchObject({ code: 'LIMIT' });
  });

  it('parses a selected config with native Windows paths without converting them', async () => {
    const root = await fixture();
    const config = {
      wonderdraftInstall: path.join(root, 'Program Files', 'Wonderdraft'),
      wonderdraftUserData: path.join(root, 'AppData', 'Roaming', 'Wonderdraft'),
      mapRoots: [path.join(root, 'Maps with spaces')],
    };
    const filename = path.join(root, 'settings.json');
    await fs.writeFile(filename, JSON.stringify(config));
    const parsed = await readSelectedConfigFile(filename);
    expect(parsed).toEqual(config);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.mapRoots)).toBe(true);
    expect(parseConfig(JSON.stringify(config))).toEqual(config);
    expect(checkAbsolutePath(config.wonderdraftInstall, 'install')).toBe(config.wonderdraftInstall);
    expect(() => checkAbsolutePath('C:relative', 'install')).toThrow();
  });

  it('locates config only under a valid APPDATA directory, ignoring XDG', async () => {
    const root = await fixture();
    const appData = path.join(root, 'AppData', 'Roaming');
    expect(configFilePath({ APPDATA: appData, XDG_CONFIG_HOME: '/ignored' }, root))
      .toBe(path.join(appData, 'georama', 'config.json'));
    for (const env of [{ APPDATA: 'C:relative' }, {}]) {
      try {
        configFilePath(env, root);
        expect.unreachable('an unset or invalid APPDATA must fail closed');
      } catch (error) {
        expect(error).toMatchObject({ code: 'PATH', key: 'APPDATA' });
      }
    }
  });

  it('discovers Windows Wonderdraft folders via ProgramFiles and APPDATA', async () => {
    const home = await fixture();
    const programFiles = path.join(home, 'Program Files');
    const appData = path.join(home, 'AppData', 'Roaming');
    const install = path.join(programFiles, 'Wonderdraft');
    const userData = path.join(appData, 'Wonderdraft');
    await fs.mkdir(install, { recursive: true });
    await fs.writeFile(path.join(install, 'Wonderdraft.pck'), new Uint8Array([1]));
    await fs.mkdir(path.join(userData, 'assets'), { recursive: true });

    const result = await resolveRoots({
      env: { ProgramFiles: programFiles, APPDATA: appData },
      home,
      config: {},
    });
    expect(result.install).toEqual({ path: install, origin: 'conventional' });
    expect(result.userData).toEqual({ path: userData, origin: 'conventional' });
    await expect(openPckFile(install)).rejects.toMatchObject({ code: 'IO' });
  });

  it('recognizes Windows roots and never invents missing user assets', async () => {
    const home = await fixture();
    const userDataRoot = path.join(home, 'my-custom-assets');
    await fs.mkdir(path.join(userDataRoot, 'assets'), { recursive: true });
    const result = await resolveRoots({
      env: { GEORAMA_WONDERDRAFT_USERDATA: userDataRoot },
      home, config: {},
    });
    expect(result.userData).toEqual({ path: userDataRoot, origin: 'env' });
    const store = await createAssetStore({ userDataRoot });
    try {
      try {
        await store.readImage('symbol', 'user://assets/synthetic/trees/tree');
        expect.unreachable('expected missing asset to be refused');
      } catch (error) {
        // Before the native helper is compiled access remains fail-closed (IO).
        // With the helper present, the nonexistent file is MISSING instead.
        expect(['IO', 'MISSING']).toContain((error as { code?: string }).code);
      }
    } finally {
      await store.close();
    }
  });

  it('enforces selected-file byte limits before Windows filesystem access', async () => {
    const lstat = vi.spyOn(fs, 'lstat');
    const open = vi.spyOn(fs, 'open');
    await expect(readSelectedDataFile('C:\\unused.json', -1)).rejects.toMatchObject({ code: 'LIMIT' });
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a leaf symlink with a held native handle, without a JavaScript path preflight', async () => {
    const root = await fixture();
    const target = path.join(root, 'target.json');
    const filename = path.join(root, 'link.json');
    await fs.writeFile(target, 'PRIVATE');
    try {
      await fs.symlink(target, filename, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const lstat = vi.spyOn(fs, 'lstat');
    const open = vi.spyOn(fs, 'open');
    await expect(readSelectedDataFile(filename, 16)).rejects.toMatchObject({ code: 'PATH' });
    await expect(readSelectedDataFile('C:relative.json', 5)).rejects.toMatchObject({ code: 'PATH' });
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses intermediate junctions and a selected file reached through an ancestor junction', async () => {
    const root = await fixture();
    const outside = path.join(root, 'outside');
    const holder = path.join(root, 'holder');
    await fs.mkdir(outside);
    await fs.mkdir(holder);
    await fs.writeFile(path.join(outside, 'private.json'), 'PRIVATE');
    await fs.symlink(outside, path.join(holder, 'redirect'), 'junction');
    await expect(readSelectedDataFile(path.join(holder, 'redirect', 'private.json'), 16))
      .rejects.toMatchObject({ code: 'PATH' });
    await fs.symlink(root, path.join(root, 'alias'), 'junction');
    await expect(readSelectedDataFile(path.join(root, 'alias', 'outside', 'private.json'), 16))
      .rejects.toMatchObject({ code: 'PATH' });
  });

  it('never returns redirected bytes during concurrent parent-directory replacement', async () => {
    const root = await fixture();
    const pack = path.join(root, 'pack');
    const parked = path.join(root, 'parked');
    const outside = path.join(root, 'outside');
    await fs.mkdir(pack);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(pack, 'map.json'), 'INSIDE');
    await fs.writeFile(path.join(outside, 'map.json'), 'OUTSIDE-SECRET');
    for (let round = 0; round < 12; round++) {
      const attempt = readSelectedDataFile(path.join(pack, 'map.json'), 32)
        .then((bytes) => ({ bytes, error: undefined }), (error: SelectedFileError) => ({ bytes: undefined, error }));
      let renamed = false;
      try {
        try {
          await fs.rename(pack, parked);
          renamed = true;
          await fs.symlink(outside, pack, 'junction');
        } catch (error) {
          expect(['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EEXIST'])
            .toContain((error as NodeJS.ErrnoException).code);
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
    expect(await fs.readFile(path.join(outside, 'map.json'), 'utf8')).toBe('OUTSIDE-SECRET');
  }, 35_000);

  it('native helper refuses malformed input without emitting paths or partial bytes', async () => {
    const root = await fixture();
    for (const [name, cap, code] of [
      ['C:relative.json', '16', 'PATH'],
      [path.join(root, 'missing.json'), '16', 'MISSING'],
      [path.join(root, 'map.exe'), '16', 'EXTENSION'],
      [path.join(root, 'missing.json'), '536870913', 'LIMIT'],
    ] as const) {
      const result = spawnSync(nativeHelper, [name, cap], { encoding: 'utf8', windowsHide: true });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe(code);
      expect(result.stderr).not.toContain(root);
    }
  });

  it('does not guess redirected AppData locations beneath the home directory', async () => {
    const home = await fixture();
    const guessed = path.join(home, 'AppData', 'Roaming', 'Wonderdraft');
    await fs.mkdir(path.join(guessed, 'assets'), { recursive: true });
    const result = await resolveRoots({ env: {}, home, config: {} });
    expect(result.userData).toBeNull();
  });

  it('refuses recursive Windows drive and directory scanning', async () => {
    const home = await fixture();
    const mount = path.join(home, 'mount');
    const install = path.join(mount, 'Wonderdraft');
    await fs.mkdir(install, { recursive: true });
    await fs.writeFile(path.join(install, 'Wonderdraft.pck'), new Uint8Array([1]));
    const result = await resolveRoots({
      env: {}, home, config: {}, mounts: [mount], scan: true, scanBudget: 16,
    });
    expect(result.install).toBeNull();
    expect(result.alsoFound.some((entry) => entry.origin === 'scan')).toBe(false);
  });
});
