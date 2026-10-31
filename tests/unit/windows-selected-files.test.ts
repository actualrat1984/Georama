import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkAbsolutePath, configFilePath, parseConfig, resolveRoots } from '../../electron/assets/config.ts';
import { createAssetStore } from '../../electron/assets/store.ts';
import { openPckFile } from '../../electron/assets/pck-file.ts';
import { readSelectedConfigFile } from '../../electron/data/config-file.ts';
import { readSelectedDataFile, SelectedFileError } from '../../electron/data/selected-file.ts';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'georama-windows-files-'));
  roots.push(root);
  return root;
}
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

  it('locates config under APPDATA with a safe fallback, ignoring XDG', async () => {
    const root = await fixture();
    const appData = path.join(root, 'AppData', 'Roaming');
    expect(configFilePath({ APPDATA: appData, XDG_CONFIG_HOME: '/ignored' }, root))
      .toBe(path.join(appData, 'georama', 'config.json'));
    expect(configFilePath({ APPDATA: 'C:relative' }, root))
      .toBe(path.join(root, 'AppData', 'Roaming', 'georama', 'config.json'));
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

  it('recognizes explicitly selected Windows roots without authorizing unsafe asset reads', async () => {
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
      await expect(store.readImage('symbol', 'user://assets/synthetic/trees/tree'))
        .rejects.toMatchObject({ code: 'IO' });
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

  it('rejects an explicitly selected link leaf before opening it', async () => {
    const root = await fixture();
    const filename = path.join(root, 'map.json');
    await fs.writeFile(filename, '{}');
    const lstat = vi.spyOn(fs, 'lstat').mockResolvedValueOnce({
      isSymbolicLink: () => true,
    } as Awaited<ReturnType<typeof fs.lstat>>);
    const open = vi.spyOn(fs, 'open');
    await expect(readSelectedDataFile(filename, 5)).rejects.toBeInstanceOf(SelectedFileError);
    await expect(readSelectedDataFile('C:relative.json', 5)).rejects.toMatchObject({ code: 'PATH' });
    expect(lstat).toHaveBeenCalledWith(filename);
    expect(open).not.toHaveBeenCalled();
  });

  it('accepts a native Windows mount for bounded conventional root scanning', async () => {
    const home = await fixture();
    const mount = path.join(home, 'mount');
    const install = path.join(mount, 'Wonderdraft');
    await fs.mkdir(install, { recursive: true });
    await fs.writeFile(path.join(install, 'Wonderdraft.pck'), new Uint8Array([1]));
    const result = await resolveRoots({
      env: {}, home, config: {}, mounts: [mount], scan: true, scanBudget: 16,
    });
    expect(result.install).toEqual({ path: install, origin: 'scan' });
  });
});
