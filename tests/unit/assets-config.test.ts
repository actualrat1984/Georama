import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_LIMITS,
  ConfigError,
  SCAN_ENTRY_BUDGET,
  configFilePath,
  resolveRoots,
} from '../../electron/assets/config.ts';
import type { GeoramaConfig } from '../../electron/assets/config.ts';

// Deterministic directory order: the wine users folder is always listed in
// reverse-sorted order, so any test that depends on the implementation sorting
// the names would fail if the sort were removed, on every filesystem.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = async (...args: Parameters<typeof real.readdir>): Promise<unknown> => {
    const out: unknown = await Reflect.apply(real.readdir, real, args);
    const target = args[0];
    if (typeof target === 'string' && target.endsWith('.wine/drive_c/users') && Array.isArray(out)) {
      const copy = [...(out as Array<{ name: string }>)];
      copy.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
      return copy;
    }
    return out;
  };
  return { ...real, readdir };
});

const tmpBase = (): string => process.env.TMPDIR ?? tmpdir();
const temps: string[] = [];

async function mkTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpBase(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop() as string;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeInstall(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'Wonderdraft.pck'), '');
  return dir;
}

async function makeUserData(dir: string, withIni: boolean): Promise<string> {
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  if (withIni) await writeFile(path.join(dir, 'config.ini'), '');
  return dir;
}

describe('configFilePath', () => {
  it('uses XDG when absolute, else home default; rejects relative home', () => {
    expect(configFilePath({}, '/home/u')).toBe('/home/u/.config/georama/config.json');
    expect(configFilePath({ XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe('/xdg/georama/config.json');
    expect(configFilePath({ XDG_CONFIG_HOME: 'rel/path' }, '/home/u')).toBe('/home/u/.config/georama/config.json');
    expect(configFilePath({ XDG_CONFIG_HOME: '' }, '/home/u')).toBe('/home/u/.config/georama/config.json');
    for (const home of ['rel', '', '/a/../b']) {
      try {
        configFilePath({}, home);
        expect.unreachable(`accepted home ${home}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).code).toBe('PATH');
      }
    }
  });
});

describe('dead loadConfig is removed (D9)', () => {
  it('the module no longer exports loadConfig', async () => {
    const mod = await import('../../electron/assets/config.ts');
    expect('loadConfig' in mod).toBe(false);
  });
});

describe('resolveRoots', () => {
  it('env wins over config over conventional', async () => {
    const home = await mkTemp('home-');
    const envDir = await makeInstall(path.join(home, 'env-wd'));
    const cfgDir = await makeInstall(path.join(home, 'cfg-wd'));
    const convDir = await makeInstall(path.join(home, '.local', 'share', 'Wonderdraft'));
    const config: GeoramaConfig = { wonderdraftInstall: cfgDir };
    const r = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_DIR: envDir }, home, config });
    expect(r.install?.path).toBe(envDir);
    expect(r.install?.origin).toBe('env');
    expect(r.alsoFound.filter((a) => a.kind === 'install').map((a) => a.path).sort()).toEqual([cfgDir, convDir].sort());
    const r2 = await resolveRoots({ env: {}, home, config });
    expect(r2.install?.path).toBe(cfgDir);
    expect(r2.install?.origin).toBe('config');
    const r3 = await resolveRoots({ env: {}, home, config: {} });
    expect(r3.install?.path).toBe(convDir);
    expect(r3.install?.origin).toBe('conventional');
  });

  it('invalid explicit env path gives null plus rejection, no fallback', async () => {
    const home = await mkTemp('home-');
    await makeInstall(path.join(home, '.local', 'share', 'Wonderdraft'));
    const bogus = path.join(home, 'no-such-install');
    const r = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_DIR: bogus }, home, config: {} });
    expect(r.install).toBe(null);
    // The install kind is blocked: exactly one install rejection, nothing found.
    const installRej = r.rejected.filter((e) => e.kind === 'install');
    expect(installRej.length).toBe(1);
    expect(installRej[0]?.origin).toBe('env');
    expect(installRej[0]?.kind).toBe('install');
    expect(installRej[0]?.path).toBe(bogus);
    expect(r.alsoFound.filter((a) => a.kind === 'install')).toEqual([]);
    // The conventional lookalike (install dir without assets/) is reported, not chosen, as user data.
    const userRej = r.rejected.filter((e) => e.kind === 'userData');
    expect(userRej.length).toBe(1);
    expect(userRej[0]?.origin).toBe('conventional');
  });

  it('env path failing C1 is a rejection with no fallback', async () => {
    const home = await mkTemp('home-');
    await makeInstall(path.join(home, '.local', 'share', 'Wonderdraft'));
    const r = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_DIR: 'rel/path' }, home, config: {} });
    expect(r.install).toBe(null);
    const installRej = r.rejected.filter((e) => e.kind === 'install');
    expect(installRej.length).toBe(1);
    expect(installRej[0]?.origin).toBe('env');
    expect(installRej[0]?.path).toBe('rel/path');
    expect(r.alsoFound.filter((a) => a.kind === 'install')).toEqual([]);
  });

  it('config path failing C1 is a rejection with no fallback', async () => {
    const home = await mkTemp('home-');
    await makeInstall(path.join(home, '.local', 'share', 'Wonderdraft'));
    const config = { wonderdraftInstall: 'relative/path' } as unknown as GeoramaConfig;
    const r = await resolveRoots({ env: {}, home, config });
    expect(r.install).toBe(null);
    const installRej = r.rejected.filter((e) => e.kind === 'install');
    expect(installRej.length).toBe(1);
    expect(installRej[0]?.origin).toBe('config');
    expect(installRej[0]?.kind).toBe('install');
  });

  it('install needs a regular Wonderdraft.pck file', async () => {
    const home = await mkTemp('home-');
    // directory named Wonderdraft.pck
    const d1 = path.join(home, 'd1');
    await mkdir(path.join(d1, 'Wonderdraft.pck'), { recursive: true });
    // dangling symlink named Wonderdraft.pck
    const d2 = path.join(home, 'd2');
    await mkdir(d2, { recursive: true });
    await symlink(path.join(home, 'missing-target'), path.join(d2, 'Wonderdraft.pck'));
    // empty folder
    const d3 = path.join(home, 'd3');
    await mkdir(d3, { recursive: true });
    for (const dir of [d1, d2, d3]) {
      const r = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_DIR: dir }, home, config: {} });
      expect(r.install).toBe(null);
      expect(r.rejected.length).toBe(1);
      expect(r.rejected[0]?.kind).toBe('install');
    }
  });

  it('user data needs an assets directory (a file is rejected)', async () => {
    const home = await mkTemp('home-');
    const d = path.join(home, 'ud');
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, 'assets'), 'not a dir');
    const r = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_USERDATA: d }, home, config: {} });
    expect(r.userData).toBe(null);
    expect(r.rejected.length).toBe(1);
    expect(r.rejected[0]?.kind).toBe('userData');
    const ok = await makeUserData(path.join(home, 'ud2'), false);
    const r2 = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_USERDATA: ok }, home, config: {} });
    expect(r2.userData?.path).toBe(ok);
    expect(r2.userData?.origin).toBe('env');
  });

  it('two wine users give the sorted first plus alsoFound; at most 16 users', async () => {
    const home = await mkTemp('home-');
    const users = path.join(home, '.wine', 'drive_c', 'users');
    await makeUserData(path.join(users, 'bravo', 'AppData', 'Roaming', 'Wonderdraft'), false);
    await makeUserData(path.join(users, 'alpha', 'AppData', 'Roaming', 'Wonderdraft'), false);
    const r = await resolveRoots({ env: {}, home, config: {} });
    expect(r.userData?.origin).toBe('conventional');
    expect(r.userData?.path).toBe(path.join(users, 'alpha', 'AppData', 'Roaming', 'Wonderdraft'));
    expect(r.alsoFound.filter((a) => a.kind === 'userData').map((a) => a.path)).toEqual([
      path.join(users, 'bravo', 'AppData', 'Roaming', 'Wonderdraft'),
    ]);
    // 18 users: only the first 16 sorted names are considered
    const home2 = await mkTemp('home2-');
    const users2 = path.join(home2, '.wine', 'drive_c', 'users');
    for (let i = 0; i < 18; i++) {
      await makeUserData(path.join(users2, `u${String(i).padStart(2, '0')}`, 'AppData', 'Roaming', 'Wonderdraft'), false);
    }
    const r2 = await resolveRoots({ env: {}, home: home2, config: {} });
    expect(r2.userData?.path).toBe(path.join(users2, 'u00', 'AppData', 'Roaming', 'Wonderdraft'));
    expect(r2.alsoFound.filter((a) => a.kind === 'userData').length).toBe(15);
  });

  it('wine users are sorted even when listed otherwise (three users, reverse creation)', async () => {
    const home = await mkTemp('home-');
    const users = path.join(home, '.wine', 'drive_c', 'users');
    for (const name of ['zeta', 'mid', 'alpha']) {
      await makeUserData(path.join(users, name, 'AppData', 'Roaming', 'Wonderdraft'), false);
    }
    const r = await resolveRoots({ env: {}, home, config: {} });
    expect(r.userData?.path).toBe(path.join(users, 'alpha', 'AppData', 'Roaming', 'Wonderdraft'));
    expect(r.alsoFound.filter((a) => a.kind === 'userData').map((a) => a.path)).toEqual([
      path.join(users, 'mid', 'AppData', 'Roaming', 'Wonderdraft'),
      path.join(users, 'zeta', 'AppData', 'Roaming', 'Wonderdraft'),
    ]);
  });

  it('scan finds depth-2 and depth-3 matches with config.ini user data', async () => {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    await makeInstall(path.join(mount, 'g1', 'Wonderdraft'));
    await makeInstall(path.join(mount, 'd1', 'd2', 'Wonderdraft'));
    await makeUserData(path.join(mount, 'g2', 'AppData'), true);
    await makeUserData(path.join(mount, 'g3', 'NoIni'), false);
    const r = await resolveRoots({ env: {}, home, config: {}, mounts: [mount], scan: true });
    expect(r.install?.origin).toBe('scan');
    expect(r.install?.path).toBe(path.join(mount, 'g1', 'Wonderdraft'));
    expect(r.userData?.origin).toBe('scan');
    expect(r.userData?.path).toBe(path.join(mount, 'g2', 'AppData'));
    const installAlso = r.alsoFound.filter((a) => a.kind === 'install').map((a) => a.path);
    expect(installAlso).toContain(path.join(mount, 'd1', 'd2', 'Wonderdraft'));
    const userAlso = r.alsoFound.filter((a) => a.kind === 'userData').map((a) => a.path);
    expect(userAlso).not.toContain(path.join(mount, 'g3', 'NoIni'));
  });

  it('scan does not find a match at depth 4', async () => {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    await makeInstall(path.join(mount, 'd1', 'd2', 'd3', 'Wonderdraft'));
    const r = await resolveRoots({ env: {}, home, config: {}, mounts: [mount], scan: true });
    expect(r.install).toBe(null);
  });

  it('scan does not descend into a symlinked folder', async () => {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    const real = path.join(home, 'real');
    await makeInstall(path.join(real, 'Wonderdraft'));
    await symlink(real, path.join(mount, 'link'));
    const r = await resolveRoots({ env: {}, home, config: {}, mounts: [mount], scan: true });
    expect(r.install).toBe(null);
  });

  it('scan skips $RECYCLE.BIN and node_modules', async () => {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    await makeInstall(path.join(mount, '$RECYCLE.BIN', 'Wonderdraft'));
    await makeInstall(path.join(mount, 'node_modules', 'Wonderdraft'));
    const r = await resolveRoots({ env: {}, home, config: {}, mounts: [mount], scan: true });
    expect(r.install).toBe(null);
  });

  it('scan stops when the entry budget is used up; default is SCAN_ENTRY_BUDGET', async () => {
    expect(SCAN_ENTRY_BUDGET).toBe(20_000);
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) {
      await mkdir(path.join(mount, name), { recursive: true });
    }
    await makeInstall(path.join(mount, 'zz', 'Wonderdraft'));
    const starved = await resolveRoots({ env: {}, home, config: {}, mounts: [mount], scan: true, scanBudget: 5 });
    expect(starved.install).toBe(null);
    const control = await resolveRoots({ env: {}, home, config: {}, mounts: [mount], scan: true });
    expect(control.install?.path).toBe(path.join(mount, 'zz', 'Wonderdraft'));
  });

  it('scan is deterministic across two runs', async () => {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    await makeInstall(path.join(mount, 'b', 'Wonderdraft'));
    await makeInstall(path.join(mount, 'a', 'Wonderdraft'));
    await makeUserData(path.join(mount, 'c', 'Data'), true);
    const opts = { env: {}, home, config: {}, mounts: [mount], scan: true } as const;
    const r1 = await resolveRoots({ ...opts, mounts: [mount] });
    const r2 = await resolveRoots({ ...opts, mounts: [mount] });
    expect(r1).toEqual(r2);
    expect(r1.install?.path).toBe(path.join(mount, 'a', 'Wonderdraft'));
  });

  it('scan:false never lists a mount (no rejection about a missing mount)', async () => {
    const home = await mkTemp('home-');
    const missing = path.join(home, 'no-such-mount');
    for (const scan of [false, undefined] as const) {
      const r = await resolveRoots({ env: {}, home, config: {}, mounts: [missing], ...(scan === undefined ? {} : { scan }) });
      expect(r.install).toBe(null);
      expect(r.userData).toBe(null);
      expect(r.rejected.filter((e) => e.path.includes('no-such-mount'))).toEqual([]);
    }
  });

  it('scan:true with no mounts resolves to nulls without throwing', async () => {
    const home = await mkTemp('home-');
    const r = await resolveRoots({ env: {}, home, config: {}, scan: true });
    expect(r.install).toBe(null);
    expect(r.userData).toBe(null);
    expect(r.rejected).toEqual([]);
    expect(r.alsoFound).toEqual([]);
  });

  it('never throws for missing, unreadable or hostile disk state', async () => {
    const home = path.join(tmpBase(), 'does-not-exist-xyz');
    const r = await resolveRoots({
      env: {},
      home,
      config: {},
      mounts: [path.join(tmpBase(), 'missing-mount-xyz')],
      scan: true,
    });
    expect(r.install).toBe(null);
    expect(r.userData).toBe(null);
    expect(Array.isArray(r.rejected)).toBe(true);
  });
});

describe('module hygiene', () => {
  it('CONFIG_LIMITS holds the frozen contractual values', () => {
    expect(CONFIG_LIMITS).toEqual({ maxBytes: 65_536, maxPathChars: 4096, maxMapRoots: 64 });
    expect(Object.isFrozen(CONFIG_LIMITS)).toBe(true);
  });

  it('imports only the allowed node modules, never electron', async () => {
    const src = await readFile(new URL('../../electron/assets/config.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('electron');
    const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(['node:fs/promises', 'node:path', 'node:os', '../native-path.ts']).toContain(spec);
    }
    expect(src).not.toContain('require(');
  });
});
