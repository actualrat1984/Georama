// Hosted-Windows acceptance of a physically extracted, UNSIGNED developer preview.
// This is not an authenticity check or a production release gate.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, freePort, targetAt } from '../tests/e2e/harness.mjs';

if (process.platform !== 'win32') {
  throw new Error('The portable preview acceptance test requires native Windows');
}
if (!process.argv[2] || !path.isAbsolute(process.argv[2])) {
  throw new Error('Provide the absolute directory of the unpacked developer preview');
}

const portableRoot = await realpath(process.argv[2]);
const appRoot = path.join(portableRoot, 'resources', 'app');
const executable = path.join(portableRoot, 'electron.exe');
const assetHelper = path.join(appRoot, 'out', 'windows', 'georama-win-asset-read.exe');
const selectedHelper = path.join(appRoot, 'out', 'windows', 'georama-win-selected-read.exe');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'georama-portable-acceptance-'));
let child;
let page;

function runHelper(binary, args, cwd) {
  const result = spawnSync(binary, args, {
    cwd, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

try {
  const hostileCwd = path.join(fixture, 'unrelated-working-directory');
  const rawRoot = path.join(fixture, 'asset-root');
  await mkdir(hostileCwd);
  await mkdir(path.join(rawRoot, 'pack'), { recursive: true });
  const root = await realpath(rawRoot);
  const payload = Buffer.from([0x00, 0x01, 0xff, 0x0d, 0x0a]);
  await writeFile(path.join(root, 'pack', 'leaf.png'), payload);
  const selectedFile = path.join(root, 'selected.json');
  await writeFile(selectedFile, payload);

  // A same-named, invalid executable in cwd must never substitute for the
  // absolute executable installed under resources/app/out/windows.
  await writeFile(path.join(hostileCwd, 'georama-win-asset-read.exe'), 'not an executable');
  const read = runHelper(assetHelper, [root, 'pack/leaf.png', String(payload.length)], hostileCwd);
  assert.equal(read.status, 0, `packaged asset helper failed: ${String(read.stderr)}`);
  assert.deepEqual(read.stdout, payload);
  assert.equal(read.stderr.length, 0);

  const traversal = runHelper(assetHelper, [root, '../outside.png', '16'], hostileCwd);
  assert.notEqual(traversal.status, 0, 'packaged asset helper accepted path traversal');
  assert.equal(traversal.stdout.length, 0);
  assert.equal(traversal.stderr.toString('utf8').trim(), 'PATH');

  const selected = runHelper(selectedHelper, [await realpath(selectedFile), String(payload.length)], hostileCwd);
  assert.equal(selected.status, 0, `packaged selected-file helper failed: ${String(selected.stderr)}`);
  assert.deepEqual(selected.stdout, payload);
  assert.equal(selected.stderr.length, 0);

  const port = await freePort();
  const profile = path.join(fixture, 'electron-profile');
  await mkdir(profile);
  child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    '--disable-gpu',
  ], {
    cwd: hostileCwd,
    env: { ...process.env, GEORAMA_E2E: '1', GEORAMA_DEVTOOLS: '0' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (part) => { stderr = (stderr + String(part)).slice(-4096); });
  let rejectEarly;
  const earlyFailure = new Promise((_, reject) => { rejectEarly = reject; });
  const onSpawnError = (error) => rejectEarly(error);
  const onEarlyExit = (code, signal) => rejectEarly(
    new Error(`Packaged Electron exited before readiness (code=${code}, signal=${signal}): ${stderr}`),
  );
  child.once('error', onSpawnError);
  child.once('exit', onEarlyExit);
  let target;
  try {
    target = await Promise.race([
      targetAt(port, (entry) => entry.type === 'page' && entry.url.startsWith('georama://app/'), child),
      earlyFailure,
    ]);
  } finally {
    child.off('error', onSpawnError);
    child.off('exit', onEarlyExit);
  }
  page = await connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = await page.evaluate(
        `document.readyState === 'complete' &&
         document.querySelector('.app-info')?.textContent.includes('Electron')`,
      );
    } catch { /* the packaged renderer may still be initializing */ }
    if (ready) break;
    await delay(100);
  }
  assert.equal(ready, true, 'packaged renderer/preload did not become ready');
  assert.equal(await page.evaluate('document.title'), "Ge'orama");
  assert.deepEqual(await page.evaluate('Object.keys(window.georama)'), ['getAppInfo']);
  const info = await page.evaluate('window.georama.getAppInfo()');
  assert.equal(info.platform, 'win32');
  assert.equal(info.e2e, true);
  assert.equal(await page.evaluate('typeof require'), 'undefined');
  console.log('PASS unsigned developer-preview package: real helpers, traversal refusal, hidden Electron/preload startup');
} finally {
  if (page) {
    try { await page.send('Browser.close', {}, 1500); } catch { /* already closed */ }
    try { page.close(); } catch { /* already disconnected */ }
  }
  if (child) {
    let exited = child.exitCode !== null || child.signalCode !== null;
    if (!exited) {
      exited = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        delay(3000).then(() => false),
      ]);
    }
    if (!exited && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 5000,
      });
    }
  }
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
