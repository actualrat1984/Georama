// Windows packaged-app IPC acceptance. Run only against a trusted local build.
// Normal mode requires real human approval through the native folder picker.
// --ci-dialog-fixture replaces ONLY the main-process dialog result through a
// loopback Node inspector; the actual preload, IPC, store and native helper run.
// That CI mode does NOT claim to have tested the native picker UI itself.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, stat, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { makePng } from '../tests/helpers/pck-synthetic.ts';
import { connect, freePort, targetAt } from '../tests/e2e/harness.mjs';

if (process.platform !== 'win32') {
  throw new Error('Windows only');
}
const appRoot = process.argv[2];
const ciDialogFixture = process.argv.includes('--ci-dialog-fixture');
if (!appRoot || !path.win32.isAbsolute(appRoot)) {
  throw new Error('Usage: node scripts/test-win-packaged-ipc.mjs <absolute portable folder>');
}
const binary = path.join(appRoot, 'electron.exe');
if (!(await stat(binary)).isFile()) throw new Error('Missing portable electron.exe');

// Match the exact canonical DOS path the held-HANDLE helper independently
// requires, just as the native reader's adversarial fixture does.
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'georama-ipc-smoke-')));
const userFolder = path.join(temporary, 'user');
const assetFolder = path.join(userFolder, 'assets', 'ipc-probe');
await mkdir(assetFolder, { recursive: true });
const assetRoot = await realpath(userFolder);
const png = makePng({ width: 2, height: 2 });
await writeFile(path.join(assetFolder, 'tree.png'), png);

// Positive control: the real packaged native EXE must read this same fixture.
// If the IPC read later fails, this distinguishes helper path confinement
// from bridge/store/renderer regressions without logging private filesystem paths.
const helper = path.join(appRoot, 'resources', 'app', 'out', 'windows', 'georama-win-asset-read.exe');
const direct = spawnSync(helper, [assetRoot, 'assets/ipc-probe/tree.png', String(64 * 1024 * 1024)], {
  cwd: temporary, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
});
assert.equal(direct.error, undefined, 'native helper launch failed');
assert.equal(direct.status, 0, `native helper refused fixture (${String(direct.stderr).trim()})`);
assert.deepEqual(direct.stdout, Buffer.from(png), 'native helper returned unexpected bytes');

const port = await freePort();
let mainPort;
if (ciDialogFixture) {
  do { mainPort = await freePort(); } while (mainPort === port);
}

let child;
let ws;
let mainInspector;
let forgedWindow;
try {
  child = spawn(binary, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(temporary, 'profile')}`,
    '--disable-gpu',
    ...(ciDialogFixture ? [`--inspect=127.0.0.1:${mainPort}`] : []),
  ], {
    cwd: temporary,
    env: { ...process.env, GEORAMA_E2E: '1', GEORAMA_DEVTOOLS: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: ciDialogFixture,
    shell: false,
  });
  let stderr = '';
  child.stderr.on('data', part => {
    stderr = (stderr + String(part)).slice(-4096);
    if (!ciDialogFixture) process.stderr.write(part);
  });
  const deadline = Date.now() + 30_000;
  let target;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron quit before the editor loaded: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
      target = (await response.json()).find((x) => x.type === 'page' && x.url.startsWith('georama://app/'));
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* startup pending */ }
    await delay(150);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('Packaged editor did not expose a debug target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  async function evaluate(expression, timeout = 120_000) {
    const id = ++sequence;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Debugger evaluate timed out'));
      }, timeout);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: false },
      }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  const ready = Date.now() + 10_000;
  while (Date.now() < ready && await evaluate("typeof window.georama?.selectUserAssets") !== 'function') {
    await delay(100);
  }
  assert.equal(await evaluate("typeof window.georama?.selectUserAssets"), 'function',
    'packaged Windows preload did not expose the guarded capability');

  assert.deepEqual(await evaluate("window.georama.readUserImage('symbol','user://assets/ipc-probe/tree')"),
    { ok: false, code: 'NOT_SELECTED' });
  if (ciDialogFixture) {
    // Only the inspector on this disposable test instance supplies the folder
    // dialog result; no override is present in the shipped main process.
    const mainTarget = await targetAt(mainPort, target => target.type === 'node', child);
    mainInspector = await connect(mainTarget.webSocketDebuggerUrl);
    await mainInspector.send('Runtime.enable');
    const configured = await mainInspector.evaluate(`(() => {
      const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
      const { dialog } = require('electron');
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(assetRoot)}] });
      return typeof dialog.showOpenDialog === 'function';
    })()`);
    assert.equal(configured, true, 'test-only main-process dialog fixture was not installed');
  } else {
    console.log('Select this exact directory in the Windows folder picker:');
    console.log(assetRoot);
    console.log('Waiting for selection (up to 120 seconds)...');
  }
  assert.equal(await evaluate('window.georama.selectUserAssets()', 120_000), true,
    'Folder selection canceled or rejected');

  const result = await evaluate(`window.georama.readUserImage('symbol','user://assets/ipc-probe/tree')
    .then(x => x.ok ? ({ok:true, bytes:Array.from(x.bytes)}) : x)`);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.bytes, Array.from(png));

  const bad = await evaluate("window.georama.readUserImage('symbol','user://assets/ipc-probe/../secret')");
  assert.deepEqual(bad, { ok: false, code: 'INVALID' });
  const absolute = await evaluate("window.georama.readUserImage('symbol','C:\\\\Windows\\\\win.ini')");
  assert.deepEqual(absolute, { ok: false, code: 'INVALID' });
  if (ciDialogFixture) {
    // Independent BrowserWindow, *same* editor document and same preload, but
    // a different WebContents must be rejected by both real IPC handlers.
    const foreignId = await mainInspector.evaluate(`(async () => {
      const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
      const { app, BrowserWindow } = require('electron');
      const path = require('node:path');
      const foreign = new BrowserWindow({ show: false, webPreferences: {
        preload: path.join(app.getAppPath(), 'dist-electron', 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, devTools: false,
      } });
      await foreign.loadURL('georama://app/index.html');
      return foreign.webContents.id;
    })()`, 20_000);
    assert.ok(Number.isInteger(foreignId));
    const secondary = await targetAt(port,
      entry => entry.type === 'page' && entry.id !== target.id && entry.url.startsWith('georama://app/'), child);
    forgedWindow = await connect(secondary.webSocketDebuggerUrl);
    await forgedWindow.send('Runtime.enable');
    const refusedRead = await forgedWindow.evaluate(`window.georama.readUserImage('symbol',
      'user://assets/ipc-probe/tree').then(() => 'unexpected success', error => String(error))`);
    assert.match(refusedRead, /untrusted sender/i, 'a second WebContents accessed user assets');
    const refusedInfo = await forgedWindow.evaluate(`window.georama.getAppInfo()
      .then(() => 'unexpected success', error => String(error))`);
    assert.match(refusedInfo, /untrusted sender/i, 'a second WebContents accessed ordinary IPC');
    const stillValid = await evaluate(`window.georama.readUserImage('symbol',
      'user://assets/ipc-probe/tree').then(x => x.ok ? Array.from(x.bytes) : x)`);
    assert.deepEqual(stillValid, Array.from(png), 'foreign-WebContents refusal revoked the legitimate editor');
  }
  console.log(ciDialogFixture
    ? 'PASS packaged IPC: real Electron IPC/native helper and synthetic picker result; traversal refused.'
    : 'PASS packaged IPC: real OS picker, native bytes and traversal refusal.');
} finally {
  try { forgedWindow?.close(); } catch { /* not opened */ }
  try { mainInspector?.close(); } catch { /* inspector already closed */ }
  ws?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    const stopped = await Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
    if (!stopped && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 5000,
    });
  }
  if (ciDialogFixture) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } else {
    // A human may still be using the picker or another test window; preserve
    // the disposable directory instead of deleting it while handles are held.
    console.log('Disposable test files:', temporary);
  }
}
