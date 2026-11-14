// Portable decoder/parser error-boundary tests; reading a selected JSON file works on both hosts.
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../electron/assets/config.ts';
import * as config from '../../electron/assets/config.ts';
import { SelectedFileError } from '../../electron/data/selected-file.ts';
import * as text from '../../src/core/assets/asset-json.ts';
import { readSelectedConfigFile } from '../../electron/data/config-file.ts';
import { configureWindowsSelectedFileHelper } from '../../electron/data/windows-selected-read.ts';

const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url));
beforeAll(async () => {
  if (process.platform === 'win32') {
    configureWindowsSelectedFileHelper(checkoutRoot);
    // Missing native helper is a failed gate, not a skip.
    await fs.access(path.join(checkoutRoot, 'out', 'windows', 'georama-win-selected-read.exe'));
  }
});

const roots: string[] = [];
async function fixture() {
  // Hosted Windows TEMP may be reached through a reparse alias; canonicalize
  // the temporary root so the native reader can enforce its own policy.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'config-strength-')));
  roots.push(root);
  const file = path.join(root, 'owned.json');
  await fs.writeFile(file, '{}');
  return { root, file };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const configCodes = ['TOO_LARGE', 'SYNTAX', 'SHAPE', 'TYPE', 'PATH', 'IO'] as const;
const readerCodes = ['PATH', 'EXTENSION', 'LIMIT', 'MISSING', 'TYPE', 'IO', 'CHANGED'] as const;

for (const code of configCodes) {
  it(`normalizes decoder-thrown ConfigError/${code} rather than blanket rethrowing`, async () => {
    const { file } = await fixture();
    const marker = new ConfigError(code, `decoder:${code}`, 'fictional-decoder-message');
    vi.spyOn(text, 'decodeAssetText').mockImplementationOnce(() => { throw marker; });
    const parser = vi.spyOn(config, 'parseConfig');
    const promise = readSelectedConfigFile(file);
    await expect(promise).rejects.toBeInstanceOf(ConfigError);
    await expect(promise).rejects.toMatchObject({ code: 'SYNTAX', key: '', message: 'config is not valid UTF-8' });
    await expect(promise).rejects.not.toBe(marker);
    expect(parser).not.toHaveBeenCalled();
  });
  it(`preserves parser ConfigError/${code} exact identity outside decoder catch`, async () => {
    const { file } = await fixture();
    const marker = new ConfigError(code, `parser:${code}`, 'fictional-parser-message');
    vi.spyOn(config, 'parseConfig').mockImplementationOnce(() => { throw marker; });
    await expect(readSelectedConfigFile(file)).rejects.toBe(marker);
  });
}
for (const code of readerCodes) {
  it(`normalizes decoder-thrown SelectedFileError/${code} to configuration SYNTAX`, async () => {
    const { file } = await fixture();
    const marker = new SelectedFileError(code, 'fictional-decoder-message');
    vi.spyOn(text, 'decodeAssetText').mockImplementationOnce(() => { throw marker; });
    const parser = vi.spyOn(config, 'parseConfig');
    const promise = readSelectedConfigFile(file);
    await expect(promise).rejects.toBeInstanceOf(ConfigError);
    await expect(promise).rejects.toMatchObject({ code: 'SYNTAX', key: '', message: 'config is not valid UTF-8' });
    await expect(promise).rejects.not.toBe(marker);
    expect(parser).not.toHaveBeenCalled();
  });
}
it.each([null, undefined, 42, 'fictional', false, Symbol('fictional')])(
  'normalizes primitive decoder rejection without inspecting it: %s', async marker => {
    const { file } = await fixture();
    vi.spyOn(text, 'decodeAssetText').mockImplementationOnce(() => { throw marker; });
    await expect(readSelectedConfigFile(file)).rejects.toMatchObject({ name: 'ConfigError', code: 'SYNTAX', key: '', message: 'config is not valid UTF-8' });
  },
);
