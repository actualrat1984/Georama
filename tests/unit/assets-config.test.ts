import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_LIMITS,
  ConfigError,
  SCAN_ENTRY_BUDGET,
  checkAbsolutePath,
  configFilePath,
  parseConfig,
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

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

describe('checkAbsolutePath', () => {
  it('accepts valid absolute paths and returns them unchanged', () => {
    for (const p of ['/', '/a', '/a/b', '/with spaces/x', '/non-ascii-é-ü-ß', '/a/', '/a b/c-d_e.f']) {
      expect(checkAbsolutePath(p, 'k')).toBe(p);
    }
    expect(checkAbsolutePath('/' + 'a'.repeat(4095), 'k')).toBe('/' + 'a'.repeat(4095));
  });

  it('rejects invalid paths with PATH', () => {
    const bad: Array<[unknown, string]> = [
      ['', 'empty'],
      ['relative/x', 'relative'],
      ['C:\\win', 'relative'],
      ['//a', 'double slash'],
      ['/a//b', 'double slash'],
      ['/a/./b', 'dot segment'],
      ['/a/../b', 'dotdot'],
      ['/..', 'dotdot'],
      ['/a/b//', 'trailing double slash'],
      ['/a/\0b', 'NUL'],
      ['/a/\nb', 'newline'],
      ['/a/\tb', 'tab'],
      ['/a/\x7fb', 'DEL'],
      ['/' + 'a'.repeat(4096), 'too long'],
      [123, 'non-string'],
      [null, 'non-string'],
    ];
    for (const [input, _why] of bad) {
      try {
        checkAbsolutePath(input as string, 'k');
        expect.unreachable(`accepted ${JSON.stringify(input)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).code).toBe('PATH');
        expect((e as ConfigError).key).toBe('k');
      }
    }
  });
});

describe('parseConfig', () => {
  it('parses a full valid config into a frozen plain object', () => {
    const cfg = parseConfig('{"wonderdraftInstall": "/a", "wonderdraftUserData": "/b/", "mapRoots": ["/c"]}');
    expect(cfg).toEqual({ wonderdraftInstall: '/a', wonderdraftUserData: '/b/', mapRoots: ['/c'] });
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.getPrototypeOf(cfg)).toBe(Object.prototype);
    expect(Object.isFrozen(cfg.mapRoots)).toBe(true);
  });

  it('parses an empty object with no undefined properties', () => {
    const cfg = parseConfig('{}');
    expect(cfg).toEqual({});
    expect('wonderdraftInstall' in cfg).toBe(false);
    expect('wonderdraftUserData' in cfg).toBe(false);
    expect('mapRoots' in cfg).toBe(false);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('ignores unknown keys and never copies them (no proto pollution)', () => {
    const cfg = parseConfig('{"x": 1, "__proto__": {"x": 1}, "constructor": 2, "mapRoots": []}') as Record<string, unknown>;
    expect(Object.hasOwn(cfg, '__proto__')).toBe(false);
    expect(Object.hasOwn(cfg, 'x')).toBe(false);
    expect(Object.hasOwn(cfg, 'constructor')).toBe(false);
    expect(({} as Record<string, unknown>)['x']).toBe(undefined);
    expect(cfg).toEqual({ mapRoots: [] });
  });

  it('rejects wrong kinds and bad paths with exact codes', () => {
    const cases: Array<[string, string, string]> = [
      ['{"wonderdraftInstall": 7}', 'TYPE', 'wonderdraftInstall'],
      ['{"wonderdraftInstall": null}', 'TYPE', 'wonderdraftInstall'],
      ['{"wonderdraftInstall": ["x"]}', 'TYPE', 'wonderdraftInstall'],
      ['{"wonderdraftUserData": {}}', 'TYPE', 'wonderdraftUserData'],
      ['{"wonderdraftInstall": "relative/x"}', 'PATH', 'wonderdraftInstall'],
      ['{"wonderdraftUserData": "/a/../b"}', 'PATH', 'wonderdraftUserData'],
      ['{"mapRoots": "x"}', 'TYPE', 'mapRoots'],
      ['{"mapRoots": 7}', 'TYPE', 'mapRoots'],
      ['{"mapRoots": null}', 'TYPE', 'mapRoots'],
      ['{"mapRoots": ["/ok", 7]}', 'TYPE', 'mapRoots[1]'],
      ['{"mapRoots": ["relative"]}', 'PATH', 'mapRoots[0]'],
      [`{"mapRoots": [${Array(65).fill('"/a"').join(',')}]}`, 'SHAPE', 'mapRoots'],
      ['{oops', 'SYNTAX', ''],
      ['[]', 'SHAPE', ''],
      ['null', 'SHAPE', ''],
      ['42', 'SHAPE', ''],
      ['"s"', 'SHAPE', ''],
    ];
    for (const [text, code, key] of cases) {
      try {
        parseConfig(text);
        expect.unreachable(`accepted ${text.slice(0, 60)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).code).toBe(code);
        expect((e as ConfigError).key).toBe(key);
      }
    }
  });

  it('rejects oversize input by UTF-8 bytes, accepts exactly the limit', () => {
    expect(() => parseConfig('x'.repeat(65_537))).toThrowError(ConfigError);
    try {
      parseConfig('x'.repeat(65_537));
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('TOO_LARGE');
    }
    const pad = 'p'.repeat(65_536 - 11);
    expect(parseConfig(`{"pad":"${pad}"}`)).toEqual({});
  });

  it('rejects a non-string root with SYNTAX', () => {
    try {
      parseConfig(123 as unknown as string);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('SYNTAX');
    }
  });

  it('seeded fuzz: only ConfigError escapes (mulberry32, 1000 mutations)', () => {
    const rand = mulberry32(0xc0ffee);
    const alphabet = 'abZ019 /\\.":{}[],_-~é&()\0\n\t\x7f"{}\\';
    const valid = '{"wonderdraftInstall": "/opt/Wonderdraft", "wonderdraftUserData": "/home/u/wd", "mapRoots": ["/m1", "/m2"]}';
    const codes = ['TOO_LARGE', 'SYNTAX', 'SHAPE', 'TYPE', 'PATH', 'IO'];
    for (let n = 0; n < 1000; n++) {
      let text = valid;
      const edits = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < edits; k++) {
        const pos = Math.floor(rand() * (text.length + 1));
        const op = rand();
        const ch = alphabet[Math.floor(rand() * alphabet.length)] as string;
        if (op < 0.4) text = text.slice(0, pos) + ch + text.slice(pos);
        else if (op < 0.7 && text.length > 0) text = text.slice(0, pos) + text.slice(pos + 1);
        else if (text.length > 0) text = text.slice(0, pos) + ch + text.slice(pos + 1);
      }
      try {
        parseConfig(text);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect(codes).toContain((e as ConfigError).code);
        expect(typeof (e as ConfigError).key).toBe('string');
      }
    }
  });
});

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
