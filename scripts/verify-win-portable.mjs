// Verify copied critical files in an extracted experimental portable package.
// This is a checksum check, not a signature or publisher-authentication check.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const arg = process.argv[2];
if (!arg || !path.isAbsolute(arg)) {
  console.error('Usage: node scripts/verify-win-portable.mjs <absolute extracted package directory>');
  process.exit(2);
}
const expected = {
  electron: 'electron.exe',
  main: 'resources/app/dist-electron/main.cjs',
  renderer: 'resources/app/dist/renderer/index.html',
  helper: 'resources/app/out/windows/georama-win-asset-read.exe',
};
const manifest = JSON.parse(await readFile(path.join(arg, 'georama-manifest.json'), 'utf8'));
if (manifest.schema !== 1 || manifest.authenticated !== false || manifest.electron !== '44.9.3') {
  throw new Error('Unexpected portable package manifest');
}
for (const [key, rel] of Object.entries(expected)) {
  const entry = manifest.hashes?.[key];
  if (entry?.path !== rel || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error('Malformed manifest entry: ' + key);
  }
  const file = path.join(arg, ...rel.split('/'));
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Missing package file: ' + key);
  const actual = createHash('sha256').update(await readFile(file)).digest('hex');
  if (actual !== entry.sha256) throw new Error('Package checksum mismatch: ' + key);
}
console.log('Portable package checksums match (unsigned; not publisher-authenticated).');
