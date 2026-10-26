// Manual Windows packaged-app IPC smoke test. Run only against a trusted local build.
// Starts a loopback-only Chromium debugging endpoint for the duration of the test.
// The user must authorize the temporary fixture root in the native folder dialog.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { makePng } from '../tests/helpers/pck-synthetic.ts';

if (process.platform !== 'win32') {
  throw new Error('Windows only');
}
const appRoot = process.argv[2];
if (!appRoot || !path.win32.isAbsolute(appRoot)) {
  throw new Error('Usage: node scripts/test-win-packaged-ipc.mjs <absolute portable folder>');
}
const binary = path.join(appRoot, 'electron.exe');
if (!(await stat(binary)).isFile()) throw new Error('Missing portable electron.exe');

const temporary = await mkdtemp(path.join(os.tmpdir(), 'georama-ipc-smoke-'));
const assetRoot = path.join(temporary, 'user');
const assetFolder = path.join(assetRoot, 'assets', 'ipc-probe');
await mkdir(assetFolder, { recursive: true });
const png = makePng({ width: 2, height: 2 });
await writeFile(path.join(assetFolder, 'tree.png'), png);

const probe = net.createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

let child;
let ws;
try {
  child = spawn(binary, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(temporary, 'profile')}`,
  ], {
    cwd: temporary,
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: false,
    shell: false,
  });
  const deadline = Date.now() + 30_000;
  let target;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Electron quit before the editor loaded');
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

  assert.deepEqual(await evaluate("window.georama.readUserImage('symbol','user://assets/ipc-probe/tree')"),
    { ok: false, code: 'NOT_SELECTED' });
  console.log('Select this exact directory in the Windows folder picker:');
  console.log(assetRoot);
  console.log('Waiting for selection (up to 120 seconds)...');
  assert.equal(await evaluate('window.georama.selectUserAssets()', 120_000), true,
    'Folder selection canceled or rejected');

  const result = await evaluate(`window.georama.readUserImage('symbol','user://assets/ipc-probe/tree')
    .then(x => x.ok ? ({ok:true, bytes:Array.from(x.bytes)}) : x)`);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.bytes, Array.from(png));

  const bad = await evaluate("window.georama.readUserImage('symbol','user://assets/ipc-probe/../secret')");
  assert.equal(bad.ok, false);
  console.log('PASS packaged IPC: authorized PNG bytes match; traversal refused.');
} finally {
  ws?.close();
  if (child && child.exitCode === null) child.kill();
  // Do not recursively delete the test directory while Electron might retain files.
  // The disposable fixture location is printed so the user can remove it later.
  console.log('Disposable test files:', temporary);
}
