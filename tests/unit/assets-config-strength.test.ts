// Strength round for electron/assets/config.ts, written from the card (T0.6d, rules C1 to C9) and from a table of 103
// operator mutants of the module (86 were killed by the implementer's tests). Every case pins a behaviour that no earlier
// test pinned: the exact byte limits (the implementer's "exactly the limit" case was one byte short),
// the exact scan-budget edge, the 16-mount cap, hostile mount values, the failure reasons,
// and two requirements the card states but the first version did not meet (see the two "RED first" groups).
//
// Mutants that stay alive on purpose (equivalent, reasoning only):
//  - checkAbsolutePath `for (let i = 0 ...)` as `i = 1` and `i <= text.length`: the first character is always '/' (checked just
//    before, 0x2f is not a control character) and charCodeAt(length) is NaN, which compares false with everything.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCAN_ENTRY_BUDGET, resolveRoots } from '../../electron/assets/config.ts';
import type { RootsResult } from '../../electron/assets/config.ts';

// Spies on the three calls whose COUNT or ARGUMENTS prove the bounded-work rules, and one injectable read failure
// (a file that vanishes or becomes unreadable between stat and read cannot be produced on a real disk deterministically).
const hooks = vi.hoisted(() => ({
  readdirCalls: [] as string[],
  readFileCalls: [] as string[],
  lstatCalls: 0,
  readFileFail: null as null | { path: string; code: string },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = async (...args: Parameters<typeof real.readdir>): Promise<unknown> => {
    hooks.readdirCalls.push(String(args[0]));
    return Reflect.apply(real.readdir, real, args);
  };
  const lstat = async (...args: Parameters<typeof real.lstat>): Promise<unknown> => {
    hooks.lstatCalls += 1;
    return Reflect.apply(real.lstat, real, args);
  };
  const readFile = async (...args: Parameters<typeof real.readFile>): Promise<unknown> => {
    hooks.readFileCalls.push(String(args[0]));
    const fail = hooks.readFileFail;
    if (fail !== null && String(args[0]) === fail.path) {
      const error = new Error(`injected ${fail.code}`) as NodeJS.ErrnoException;
      error.code = fail.code;
      throw error;
    }
    return Reflect.apply(real.readFile, real, args);
  };
  return { ...real, readdir, lstat, readFile };
});

const temps: string[] = [];
async function mkTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
beforeEach(() => {
  hooks.readdirCalls.length = 0;
  hooks.readFileCalls.length = 0;
  hooks.lstatCalls = 0;
  hooks.readFileFail = null;
});
afterEach(async () => {
  hooks.readFileFail = null;
  while (temps.length > 0) await rm(temps.pop() as string, { recursive: true, force: true });
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
describe('resolveRoots: explicit values, reasons and unset values', () => {
  it('an empty environment value is "unset": it falls through to the conventional folder with no rejection', async () => {
    const home = await mkTemp('home-');
    const install = await makeInstall(path.join(home, 'Games', 'Wonderdraft'));
    // ~/.config/Wonderdraft is a user-data candidate only (~/.local/share/Wonderdraft is both, and would be a rejected install).
    const data = await makeUserData(path.join(home, '.config', 'Wonderdraft'), false);
    const r = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_DIR: '', GEORAMA_WONDERDRAFT_USERDATA: '' }, home, config: {} });
    expect(r.install).toEqual({ path: install, origin: 'conventional' });
    expect(r.userData).toEqual({ path: data, origin: 'conventional' });
    expect(r.rejected).toEqual([]);
  });
  it('a blank (spaces) environment value is a bad path, not "unset": rejected, and it blocks the fallback', async () => {
    const home = await mkTemp('home-');
    await makeInstall(path.join(home, 'Games', 'Wonderdraft'));
    const r = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_DIR: '   ' }, home, config: {} });
    expect(r.install).toBe(null);
    expect(r.rejected.map((e) => [e.origin, e.kind, e.path])).toEqual([['env', 'install', '   ']]);
  });
  it('rejections spell out why, for each kind and for explicit and conventional candidates', async () => {
    const home = await mkTemp('home-');
    const emptyA = await mkTemp('empty-');
    const emptyB = await mkTemp('empty-');
    const explicit = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_DIR: emptyA }, home, config: { wonderdraftUserData: emptyB } });
    expect(explicit.rejected).toEqual([
      { path: emptyA, origin: 'env', kind: 'install', reason: `no Wonderdraft.pck in ${emptyA}` },
      { path: emptyB, origin: 'config', kind: 'userData', reason: `no assets directory in ${emptyB}` },
    ]);
    const convInstall = path.join(home, 'Games', 'Wonderdraft');
    const convData = path.join(home, '.config', 'Wonderdraft');
    await mkdir(convInstall, { recursive: true });
    await mkdir(convData, { recursive: true });
    const conventional = await resolveRoots({ env: {}, home, config: {} });
    expect(conventional.install).toBe(null);
    expect(conventional.userData).toBe(null);
    expect(conventional.rejected).toEqual([
      { path: convInstall, origin: 'conventional', kind: 'install', reason: `no Wonderdraft.pck in ${convInstall}` },
      { path: convData, origin: 'conventional', kind: 'userData', reason: `no assets directory in ${convData}` },
    ]);
  });
  it('a valid explicit value followed by an invalid second candidate keeps the valid one and records the other', async () => {
    const home = await mkTemp('home-');
    const good = await makeInstall(await mkTemp('good-'));
    const bad = await mkTemp('bad-');
    const r = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_DIR: good }, home, config: { wonderdraftInstall: bad } });
    expect(r.install).toEqual({ path: good, origin: 'env' });
    expect(r.rejected).toEqual([{ path: bad, origin: 'config', kind: 'install', reason: `no Wonderdraft.pck in ${bad}` }]);
  });
});

describe('resolveRoots: the scan budget and the mount list', () => {
  /** mount/a1..a6 (empty) and mount/zz/Wonderdraft: listing the mount costs 7 entries, listing zz one more. */
  async function budgetTree(): Promise<{ home: string; mount: string; target: string }> {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) await mkdir(path.join(mount, name));
    const target = await makeInstall(path.join(mount, 'zz', 'Wonderdraft'));
    return { home, mount, target };
  }
  const scanWith = (home: string, mount: string, scanBudget?: number): Promise<RootsResult> =>
    resolveRoots({ env: {}, home, config: {}, mounts: [mount], scan: true, ...(scanBudget === undefined ? {} : { scanBudget }) });

  it('the budget edge is exact: 8 entries are not enough to reach the target, 9 are', async () => {
    const { home, mount, target } = await budgetTree();
    expect((await scanWith(home, mount, 6)).install).toBe(null);
    expect((await scanWith(home, mount, 7)).install).toBe(null);
    expect((await scanWith(home, mount, 8)).install).toBe(null);
    expect((await scanWith(home, mount, 9)).install?.path).toBe(target);
    expect((await scanWith(home, mount, 10)).install?.path).toBe(target);
    expect((await scanWith(home, mount, 0)).install).toBe(null);
  });
  it('one folder with more entries than the budget is not walked beyond the budget', async () => {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    for (let i = 0; i < 60; i++) await mkdir(path.join(mount, 'big', `s${String(i).padStart(2, '0')}`), { recursive: true });
    await scanWith(home, mount, 10);
    // 1 entry in the mount ('big') plus the 9 first entries of 'big' that the budget still allows.
    expect(hooks.lstatCalls).toBe(10);
  });
  it('a mount that is itself an install folder is found at depth 0', async () => {
    const home = await mkTemp('home-');
    const mount = await makeInstall(await mkTemp('mnt-'));
    expect((await scanWith(home, mount)).install).toEqual({ path: mount, origin: 'scan' });
  });
  it('a budget that is not a non-negative safe integer is replaced by the default', async () => {
    expect(SCAN_ENTRY_BUDGET).toBe(20_000);
    const { home, mount, target } = await budgetTree();
    for (const bad of [-1, -0.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, '9' as unknown as number, null as unknown as number]) {
      const r = await scanWith(home, mount, bad);
      expect({ bad: String(bad), found: r.install?.path }).toEqual({ bad: String(bad), found: target });
    }
  });
  it('at most 16 mounts are scanned: the 16th counts, the 17th does not', async () => {
    const home = await mkTemp('home-');
    const mounts: string[] = [];
    for (let i = 0; i < 17; i++) mounts.push(await mkTemp('m-'));
    const inSixteenth = await makeInstall(path.join(mounts[15] as string, 'Wonderdraft'));
    const first = await resolveRoots({ env: {}, home, config: {}, mounts, scan: true });
    expect(first.install?.path).toBe(inSixteenth);
    await rm(inSixteenth, { recursive: true, force: true });
    await makeInstall(path.join(mounts[16] as string, 'Wonderdraft'));
    const second = await resolveRoots({ env: {}, home, config: {}, mounts, scan: true });
    expect(second.install).toBe(null);
    expect(second.alsoFound).toEqual([]);
  });
  it('mount values that are not absolute strings are skipped, never listed, and never throw', async () => {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    const target = await makeInstall(path.join(mount, 'Wonderdraft'));
    const hostile = [7, null, undefined, {}, [], true, '', 'relative/dir', '../up', './here', 'C:\\x'] as unknown as string[];
    const r = await resolveRoots({ env: {}, home, config: {}, mounts: [...hostile, mount], scan: true });
    expect(r.install?.path).toBe(target);
    const listed = hooks.readdirCalls.filter((p) => !p.startsWith(home) && !p.includes('.wine'));
    expect(listed.every((p) => p.startsWith(mount))).toBe(true);
    expect(listed.length).toBeGreaterThan(0);
  });
  it('the first match per kind wins in sorted order and the rest go to alsoFound, per kind', async () => {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    await makeInstall(path.join(mount, 'c', 'Wonderdraft'));
    await makeInstall(path.join(mount, 'a', 'Wonderdraft'));
    await makeInstall(path.join(mount, 'b', 'Wonderdraft'));
    await makeUserData(path.join(mount, 'y', 'Data'), true);
    await makeUserData(path.join(mount, 'x', 'Data'), true);
    const r = await resolveRoots({ env: {}, home, config: {}, mounts: [mount], scan: true });
    expect(r.install?.path).toBe(path.join(mount, 'a', 'Wonderdraft'));
    expect(r.userData?.path).toBe(path.join(mount, 'x', 'Data'));
    expect(r.alsoFound.map((e) => `${e.kind}:${e.origin}:${path.relative(mount, e.path)}`)).toEqual([
      `install:scan:${path.join('b', 'Wonderdraft')}`,
      `install:scan:${path.join('c', 'Wonderdraft')}`,
      `userData:scan:${path.join('y', 'Data')}`,
    ]);
  });
  it('a blocked kind is not filled by the scan, the other kind still is', async () => {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    await makeInstall(path.join(mount, 'Wonderdraft'));
    const target = await makeUserData(path.join(mount, 'Data'), true);
    const r = await resolveRoots({ env: { GEORAMA_WONDERDRAFT_DIR: '/no/such/install' }, home, config: {}, mounts: [mount], scan: true });
    expect(r.install).toBe(null);
    expect(r.userData?.path).toBe(target);
    expect(r.alsoFound.filter((e) => e.kind === 'install')).toEqual([]);
  });
  it('does not follow a symlinked mount entry and does not list inside it', async () => {
    const home = await mkTemp('home-');
    const mount = await mkTemp('mnt-');
    const elsewhere = await mkTemp('else-');
    await makeInstall(path.join(elsewhere, 'Wonderdraft'));
    await symlink(elsewhere, path.join(mount, 'link'));
    const r = await resolveRoots({ env: {}, home, config: {}, mounts: [mount], scan: true });
    expect(r.install).toBe(null);
    expect(hooks.readdirCalls.some((p) => p.startsWith(elsewhere))).toBe(false);
  });
});

describe('resolveRoots: RED first (card C8 and C9)', () => {
  it('a mounts value that is not an array is ignored: no folder is listed', async () => {
    const home = await mkTemp('home-');
    for (const mounts of ['/', '/tmp', { length: 1, 0: '/' }, 42] as unknown as string[][]) {
      hooks.readdirCalls.length = 0;
      const r = await resolveRoots({ env: {}, home, config: {}, mounts, scan: true });
      expect({ install: r.install, userData: r.userData }).toEqual({ install: null, userData: null });
      expect(hooks.readdirCalls.filter((p) => !p.startsWith(home))).toEqual([]);
    }
  });
  it('a malformed call still ends as an ordinary result: the whole options object is optional in practice', async () => {
    for (const opts of [undefined, null, 'x', 42, true, [], () => 1] as unknown as Array<Parameters<typeof resolveRoots>[0]>) {
      const r = await resolveRoots(opts);
      expect({ install: r.install, userData: r.userData, rejected: r.rejected, alsoFound: r.alsoFound }).toEqual({
        install: null,
        userData: null,
        rejected: [],
        alsoFound: [],
      });
    }
  });
  it('options of the wrong kind do not throw: env, config and home that are not what they should be', async () => {
    const wrong = [
      { env: 5, home: '/h', config: {} },
      { env: null, home: null, config: null },
      { env: {}, home: 7, config: 'text' },
      { env: { GEORAMA_WONDERDRAFT_DIR: 5, GEORAMA_WONDERDRAFT_USERDATA: {} }, home: '/nonexistent-home-dir', config: { wonderdraftInstall: 3, wonderdraftUserData: [] } },
    ] as unknown as Array<Parameters<typeof resolveRoots>[0]>;
    for (const opts of wrong) {
      const r = await resolveRoots(opts);
      expect(r.install).toBe(null);
      expect(r.userData).toBe(null);
    }
  });
});
