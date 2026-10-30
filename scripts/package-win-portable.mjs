// Windows-only experimental portable distribution. No installer or signing.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.error('Portable Windows packaging must run on Windows.');
  process.exit(1);
}
const repo = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
const installedElectron = JSON.parse(await readFile(path.join(repo, 'node_modules', 'electron', 'package.json'), 'utf8'));
if (installedElectron.version !== packageJson.devDependencies.electron || installedElectron.version !== '44.9.3') {
  throw new Error('Install the pinned patched Electron 44.9.3 using npm ci.');
}
function run(program, args) {
  const result = spawnSync(program, args, { cwd: repo, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(program + ' failed (exit ' + result.status + ')');
}
async function requireFile(filename) {
  const info = await stat(filename);
  if (!info.isFile()) throw new Error('Required build output is not a regular file.');
}
async function digest(filename) {
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

// Rebuild both the helper and Electron application before copying artifacts.
// No previous output folder is overwritten or recursively removed.
run(process.execPath, [path.join(repo, 'scripts', 'build-win-asset-helper.mjs')]);
const npmCli = process.env.npm_execpath;
if (!npmCli || !path.isAbsolute(npmCli)) {
  throw new Error('Invoke packaging through npm run package:win:portable.');
}
run(process.execPath, [npmCli, 'run', 'build']);
const sourceElectron = path.join(repo, 'node_modules', 'electron', 'dist');
const sourceHelper = path.join(repo, 'out', 'windows', 'georama-win-asset-read.exe');
// Some npm installations defer the Electron binary download until first use.
try {
  await requireFile(path.join(sourceElectron, 'electron.exe'));
} catch {
  run(process.execPath, [path.join(repo, 'node_modules', 'electron', 'install.js')]);
}
await Promise.all([
  requireFile(path.join(sourceElectron, 'electron.exe')),
  requireFile(sourceHelper),
  requireFile(path.join(repo, 'dist-electron', 'main.cjs')),
  requireFile(path.join(repo, 'dist', 'renderer', 'index.html')),
]);

const parent = path.join(repo, 'out', 'portable');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(path.join(parent, 'georama-win-x64-'));
const appRoot = path.join(directory, 'resources', 'app');
// The unique mkdtemp staging directory already exists and is intentionally empty.
// Permit merging the runtime tree into that directory, but do not overwrite files.
await cp(sourceElectron, directory, { recursive: true, force: false });
await mkdir(appRoot, { recursive: true });
await cp(path.join(repo, 'dist-electron'), path.join(appRoot, 'dist-electron'), { recursive: true });
await cp(path.join(repo, 'dist'), path.join(appRoot, 'dist'), { recursive: true });
const helperDestination = path.join(appRoot, 'out', 'windows', 'georama-win-asset-read.exe');
await mkdir(path.dirname(helperDestination), { recursive: true });
await cp(sourceHelper, helperDestination, { force: false, errorOnExist: true });
await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({
  name: packageJson.name,
  productName: packageJson.productName,
  version: packageJson.version,
  main: 'dist-electron/main.cjs',
  private: true,
}, null, 2) + '\n');

const files = {
  electron: ['electron.exe', path.join(directory, 'electron.exe')],
  main: ['resources/app/dist-electron/main.cjs', path.join(appRoot, 'dist-electron', 'main.cjs')],
  renderer: ['resources/app/dist/renderer/index.html', path.join(appRoot, 'dist', 'renderer', 'index.html')],
  helper: ['resources/app/out/windows/georama-win-asset-read.exe', helperDestination],
};
const hashes = {};
for (const [key, [relative, target]] of Object.entries(files)) {
  hashes[key] = { path: relative, sha256: await digest(target) };
}
await writeFile(path.join(directory, 'georama-manifest.json'), JSON.stringify({
  schema: 1,
  electron: installedElectron.version,
  hashes,
  // Checksums detect accidental/post-build changes, not malicious replacement
  // of both payload and manifest. Signing is required for authentication.
  authenticated: false,
}, null, 2) + '\n');
for (const [key, [, target]] of Object.entries(files)) {
  if (await digest(target) !== hashes[key].sha256) throw new Error('Staging copy integrity mismatch');
}

const archive = directory + '.zip';
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const command = "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath " +
  quote(directory) + ' -DestinationPath ' + quote(archive) + ' -CompressionLevel Optimal';
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
await requireFile(archive);
console.log('Portable Windows package (unsigned): ' + archive);
console.log('Extract, then run electron.exe from the extracted application folder.');
