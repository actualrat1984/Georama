import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isNativeAbsolutePath } from '../native-path.ts';

export interface GeoramaConfig {
  readonly wonderdraftInstall?: string;
  readonly wonderdraftUserData?: string;
  readonly mapRoots?: readonly string[];
}

export type ConfigErrorCode = 'TOO_LARGE' | 'SYNTAX' | 'SHAPE' | 'TYPE' | 'PATH' | 'IO';

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly key: string;
  constructor(code: ConfigErrorCode, key: string, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.key = key;
  }
}

export const CONFIG_LIMITS: Readonly<{ maxBytes: number; maxPathChars: number; maxMapRoots: number }> = Object.freeze({
  maxBytes: 65_536,
  maxPathChars: 4096,
  maxMapRoots: 64,
});

export function checkAbsolutePath(text: string, key: string): string {
  if (typeof text !== 'string' || text.length === 0 || text.length > CONFIG_LIMITS.maxPathChars) {
    throw new ConfigError('PATH', key, `${key}: path must be 1..${CONFIG_LIMITS.maxPathChars} characters`);
  }
  if (process.platform === 'win32') {
    if (!isNativeAbsolutePath(text, 'win32', CONFIG_LIMITS.maxPathChars)) {
      throw new ConfigError('PATH', key, `${key}: path must be a normalized absolute Windows drive path`);
    }
    return text;
  }
  if (!text.startsWith('/')) {
    throw new ConfigError('PATH', key, `${key}: path must be absolute`);
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new ConfigError('PATH', key, `${key}: path contains a control character`);
    }
  }
  if (path.posix.normalize(text) !== text) {
    throw new ConfigError('PATH', key, `${key}: path is not normalised`);
  }
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

export function parseConfig(text: string): GeoramaConfig {
  if (typeof text !== 'string') {
    throw new ConfigError('SYNTAX', '', 'config must be JSON text');
  }
  if (Buffer.byteLength(text, 'utf8') > CONFIG_LIMITS.maxBytes) {
    throw new ConfigError('TOO_LARGE', '', `config is larger than ${CONFIG_LIMITS.maxBytes} bytes`);
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new ConfigError('SYNTAX', '', 'config is not valid JSON');
  }
  if (!isPlainObject(root)) {
    throw new ConfigError('SHAPE', '', 'config root must be an object');
  }
  const out: { wonderdraftInstall?: string; wonderdraftUserData?: string; mapRoots?: readonly string[] } = {};
  if (Object.hasOwn(root, 'wonderdraftInstall')) {
    const value: unknown = root['wonderdraftInstall'];
    if (typeof value !== 'string') {
      throw new ConfigError('TYPE', 'wonderdraftInstall', 'wonderdraftInstall must be a string');
    }
    out.wonderdraftInstall = checkAbsolutePath(value, 'wonderdraftInstall');
  }
  if (Object.hasOwn(root, 'wonderdraftUserData')) {
    const value: unknown = root['wonderdraftUserData'];
    if (typeof value !== 'string') {
      throw new ConfigError('TYPE', 'wonderdraftUserData', 'wonderdraftUserData must be a string');
    }
    out.wonderdraftUserData = checkAbsolutePath(value, 'wonderdraftUserData');
  }
  if (Object.hasOwn(root, 'mapRoots')) {
    const value: unknown = root['mapRoots'];
    if (!Array.isArray(value)) {
      throw new ConfigError('TYPE', 'mapRoots', 'mapRoots must be an array');
    }
    if (value.length > CONFIG_LIMITS.maxMapRoots) {
      throw new ConfigError('SHAPE', 'mapRoots', `mapRoots holds at most ${CONFIG_LIMITS.maxMapRoots} entries`);
    }
    const roots: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const entry: unknown = value[i];
      if (typeof entry !== 'string') {
        throw new ConfigError('TYPE', `mapRoots[${i}]`, 'mapRoots entries must be strings');
      }
      roots.push(checkAbsolutePath(entry, `mapRoots[${i}]`));
    }
    out.mapRoots = Object.freeze(roots);
  }
  return Object.freeze(out);
}

export function configFilePath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  checkAbsolutePath(home, 'home');
  if (process.platform === 'win32') {
    const appData = (env ?? {})['APPDATA'];
    const root = isNativeAbsolutePath(appData, 'win32') ? appData : path.join(home, 'AppData', 'Roaming');
    return path.join(root, 'georama', 'config.json');
  }
  const xdg = (env ?? {})['XDG_CONFIG_HOME'];
  if (typeof xdg === 'string' && xdg !== '' && xdg.startsWith('/')) {
    return path.join(xdg, 'georama', 'config.json');
  }
  return path.join(home, '.config', 'georama', 'config.json');
}

export type RootOrigin = 'env' | 'config' | 'conventional' | 'scan';

export interface RootChoice {
  readonly path: string;
  readonly origin: RootOrigin;
}

export interface RootRejection {
  readonly path: string;
  readonly origin: RootOrigin;
  readonly kind: 'install' | 'userData';
  readonly reason: string;
}

export interface RootsResult {
  readonly install: RootChoice | null;
  readonly userData: RootChoice | null;
  readonly rejected: readonly RootRejection[];
  readonly alsoFound: readonly (RootChoice & { kind: 'install' | 'userData' })[];
}

export interface ResolveRootsOptions {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  config: GeoramaConfig;
  mounts?: readonly string[];
  scan?: boolean;
  scanBudget?: number;
}

export const SCAN_ENTRY_BUDGET: number = 20_000;

type RootKind = 'install' | 'userData';

async function isInstallDir(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, 'Wonderdraft.pck'))).isFile();
  } catch {
    return false;
  }
}

async function isUserDataDir(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, 'assets'))).isDirectory();
  } catch {
    return false;
  }
}

async function isScanUserDataDir(dir: string): Promise<boolean> {
  try {
    if (!(await isUserDataDir(dir))) return false;
    return (await stat(path.join(dir, 'config.ini'))).isFile();
  } catch {
    return false;
  }
}

async function isValidRoot(dir: string, kind: RootKind): Promise<boolean> {
  return kind === 'install' ? isInstallDir(dir) : isUserDataDir(dir);
}

function installConventional(home: string, env: Readonly<Record<string, string | undefined>>): string[] {
  if (process.platform === 'win32') {
    const programDirs = [env['ProgramFiles'], env['ProgramFiles(x86)']]
      .filter((value): value is string => isNativeAbsolutePath(value, 'win32'));
    return [
      ...programDirs.map((dir) => path.join(dir, 'Wonderdraft')),
      path.join(home, 'Games', 'Wonderdraft'),
      path.join(home, 'AppData', 'Local', 'Programs', 'Wonderdraft'),
    ];
  }
  return [
    path.join(home, '.steam', 'steam', 'steamapps', 'common', 'Wonderdraft'),
    path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common', 'Wonderdraft'),
    path.join(home, '.wine', 'drive_c', 'Program Files', 'Wonderdraft'),
    path.join(home, '.wine', 'drive_c', 'Program Files (x86)', 'Wonderdraft'),
    path.join(home, 'Games', 'Wonderdraft'),
    path.join(home, '.local', 'share', 'Wonderdraft'),
  ];
}

async function wineUserDirs(home: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(home, '.wine', 'drive_c', 'users'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .slice(0, 16)
      .map((name) => path.join(home, '.wine', 'drive_c', 'users', name, 'AppData', 'Roaming', 'Wonderdraft'));
  } catch {
    return [];
  }
}

async function conventionalFor(
  home: string,
  kind: RootKind,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  if (kind === 'install') return installConventional(home, env);
  if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    return [
      ...(isNativeAbsolutePath(appData, 'win32') ? [path.join(appData, 'Wonderdraft')] : []),
      path.join(home, 'AppData', 'Roaming', 'Wonderdraft'),
      path.join(home, 'AppData', 'Local', 'Wonderdraft'),
    ];
  }
  return [
    ...(await wineUserDirs(home)),
    path.join(home, '.local', 'share', 'Wonderdraft'),
    path.join(home, '.config', 'Wonderdraft'),
    path.join(home, '.local', 'share', 'godot', 'app_userdata', 'Wonderdraft'),
  ];
}

const SCAN_SKIP = new Set(['$RECYCLE.BIN', 'System Volume Information', 'lost+found', 'node_modules', '.git']);

async function scanMounts(mounts: readonly string[], budget: number): Promise<{ install: string[]; userData: string[] }> {
  const foundInstall: string[] = [];
  const foundUserData: string[] = [];
  let examined = 0;
  let stopped = false;
  for (const mount of mounts.slice(0, 16)) {
    if (stopped) break;
    if (typeof mount !== 'string' || mount === '' ||
        (process.platform === 'win32' ? !isNativeAbsolutePath(mount, 'win32') : !mount.startsWith('/'))) continue;
    const queue: Array<{ dir: string; depth: number }> = [{ dir: mount, depth: 0 }];
    while (queue.length > 0) {
      if (examined >= budget) {
        stopped = true;
        break;
      }
      const current = queue.shift() as { dir: string; depth: number };
      if (await isInstallDir(current.dir)) {
        foundInstall.push(current.dir);
      } else if (await isScanUserDataDir(current.dir)) {
        foundUserData.push(current.dir);
      }
      if (current.depth >= 3) continue;
      let names: string[];
      try {
        names = (await readdir(current.dir)).sort();
      } catch {
        continue;
      }
      // Examine at most the entries the budget still allows (examined < budget here), so one huge flat folder cannot outrun it.
      const taken = names.slice(0, budget - examined);
      examined += taken.length;
      for (const name of taken) {
        if (SCAN_SKIP.has(name)) continue;
        const full = path.join(current.dir, name);
        try {
          if ((await lstat(full)).isSymbolicLink()) continue;
        } catch {
          continue;
        }
        try {
          if (!(await stat(full)).isDirectory()) continue;
        } catch {
          continue;
        }
        queue.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  return { install: foundInstall, userData: foundUserData };
}

export function resolveRoots(opts: ResolveRootsOptions): Promise<RootsResult> {
  return (async () => {
    // The caller is our own main process, but a malformed call must still end as an ordinary result (rule C9):
    // nothing here rejects because of what was passed in.
    const options: Partial<ResolveRootsOptions> = typeof opts === 'object' && opts !== null ? opts : {};
    const env = options.env ?? {};
    const config = options.config ?? {};
    const rejected: RootRejection[] = [];
    const alsoFound: Array<RootChoice & { kind: RootKind }> = [];
    const choice: Record<RootKind, RootChoice | null> = { install: null, userData: null };
    const blocked: Record<RootKind, boolean> = { install: false, userData: false };
    const kinds: RootKind[] = ['install', 'userData'];

    for (const kind of kinds) {
      const rawEnv = kind === 'install' ? env['GEORAMA_WONDERDRAFT_DIR'] : env['GEORAMA_WONDERDRAFT_USERDATA'];
      const envPath = rawEnv === undefined || rawEnv === '' ? undefined : rawEnv;
      const configPath = kind === 'install' ? config.wonderdraftInstall : config.wonderdraftUserData;
      const explicit: Array<{ path: string | undefined; origin: RootOrigin }> = [
        { path: envPath, origin: 'env' },
        { path: configPath, origin: 'config' },
      ];
      for (const candidate of explicit) {
        if (candidate.path === undefined) continue;
        let checked = '';
        try {
          checked = checkAbsolutePath(candidate.path, candidate.origin);
        } catch (error: unknown) {
          rejected.push({ path: candidate.path, origin: candidate.origin, kind, reason: (error as Error).message });
          blocked[kind] = true;
          break;
        }
        if (await isValidRoot(checked, kind)) {
          if (choice[kind] === null) {
            choice[kind] = { path: checked, origin: candidate.origin };
          } else {
            alsoFound.push({ path: checked, origin: candidate.origin, kind });
          }
        } else {
          rejected.push({
            path: checked,
            origin: candidate.origin,
            kind,
            reason: kind === 'install' ? `no Wonderdraft.pck in ${checked}` : `no assets directory in ${checked}`,
          });
          if (choice[kind] === null) {
            blocked[kind] = true;
            break;
          }
        }
      }
      if (blocked[kind]) continue;
      let home = '';
      try {
        home = checkAbsolutePath(options.home as string, 'home');
      } catch {
        home = '';
      }
      if (home === '') continue;
      for (const dir of await conventionalFor(home, kind, env)) {
        try {
          await stat(dir);
        } catch {
          continue;
        }
        if (await isValidRoot(dir, kind)) {
          if (choice[kind] === null) {
            choice[kind] = { path: dir, origin: 'conventional' };
          } else {
            alsoFound.push({ path: dir, origin: 'conventional', kind });
          }
        } else {
          rejected.push({
            path: dir,
            origin: 'conventional',
            kind,
            reason: kind === 'install' ? `no Wonderdraft.pck in ${dir}` : `no assets directory in ${dir}`,
          });
        }
      }
    }

    if (options.scan === true) {
      // A budget that is not a non-negative safe integer (NaN, Infinity, a fraction, a string) would void the bound: use the default.
      const requested = options.scanBudget;
      const budget = typeof requested === 'number' && Number.isSafeInteger(requested) && requested >= 0 ? requested : SCAN_ENTRY_BUDGET;
      const found = await scanMounts(Array.isArray(options.mounts) ? options.mounts : [], budget);
      for (const kind of kinds) {
        if (blocked[kind]) continue;
        const list = kind === 'install' ? found.install : found.userData;
        for (const dir of list) {
          if (choice[kind] === null) {
            choice[kind] = { path: dir, origin: 'scan' };
          } else {
            alsoFound.push({ path: dir, origin: 'scan', kind });
          }
        }
      }
    }

    return { install: choice.install, userData: choice.userData, rejected, alsoFound };
  })();
}
