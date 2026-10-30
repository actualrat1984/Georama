import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
let child;
let temporaryDirectory;
let cleanupPromise;
const connections = [];
let passed = 0;
let total = 0;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function targetAt(port, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron exited before its debugging target was ready (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
      const target = (await response.json()).find(predicate);
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // The process may still be bringing up its loopback-only inspector.
    }
    await delay(100);
  }
  throw new Error(`No debugging target became ready on port ${port} within 30 seconds`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); }, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    } else {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    }
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Debugger connection closed'));
    }
    pending.clear();
  });
  const connection = {
    send(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        // CDP defaults to bypassing CSP for eval. Explicitly test the page's real policy.
        allowUnsafeEvalBlockedByCSP: false,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result.value;
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    close() { socket.close(); },
  };
  connections.push(connection);
  return connection;
}

async function check(name, assertion) {
  total += 1;
  try {
    await assertion();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    // A termination signal closes the debugger under a running check: that is the signal working, not a failed assertion.
    console.log(cleanupPromise ? `ABORTED ${name}: interrupted by a termination signal` : `FAIL ${name}: ${error.message}`);
  }
}

function signalChild(signal) {
  if (!child?.pid) return;
  try {
    // Let the launcher forward SIGTERM to Electron before killing any remaining helpers.
    process.kill(signal === 'SIGTERM' ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function processGroupGone(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(-pgid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return true;
      if (error.code === 'EPERM') return false; // exists but is not ours: treat as still alive
      throw error;
    }
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
}

function cleanup() {
  cleanupPromise ??= (async () => {
    let groupError;
    for (const connection of connections) connection.close();
    if (child) {
      const exited = new Promise((resolve) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', resolve);
      });
      signalChild('SIGTERM');
      const timeout = setTimeout(() => signalChild('SIGKILL'), 3_000);
      try { await exited; } finally { clearTimeout(timeout); }
      // Also reap any remaining helper in the group after the launcher has exited.
      signalChild('SIGKILL');
      // A successful kill() only means a signal was delivered: observe the group actually disappearing.
      if (child.pid && !await processGroupGone(child.pid, 5_000)) groupError = new Error(`process group ${child.pid} still has live members after SIGKILL`);
    }
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (groupError) throw groupError;
  })();
  return cleanupPromise;
}

// 128 + signal number. SIGHUP matters: the launcher runs detached, so a terminal hangup would otherwise orphan Electron.
for (const [signal, exitCode] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(exitCode));
  });
}

try {
  const rendererPort = await freePort();
  let mainPort;
  do { mainPort = await freePort(); } while (mainPort === rendererPort);
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'georama-e2e-'));
  child = spawn(process.execPath, [
    path.join(root, 'scripts/run-electron.mjs'), '.',
    `--remote-debugging-port=${rendererPort}`,
    `--remote-allow-origins=http://127.0.0.1:${rendererPort}`,
    `--user-data-dir=${temporaryDirectory}`,
    // Test-only main inspector: read actual BrowserWindow preferences, not source strings.
    `--inspect=127.0.0.1:${mainPort}`,
  ], {
    cwd: root,
    env: { ...process.env, GEORAMA_E2E: '1', GEORAMA_DEVTOOLS: '0' },
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const spawnError = new Promise((_, reject) => child.once('error', reject));
  console.log(`LAUNCH ${JSON.stringify({ temporaryDirectory, launcherPid: child.pid })}`);
  const pageTarget = await Promise.race([
    targetAt(rendererPort, (target) => target.type === 'page' && target.url.startsWith('georama://app/')),
    spawnError,
  ]);
  const page = await connect(pageTarget.webSocketDebuggerUrl);
  const startupExceptions = [];
  page.on('Runtime.exceptionThrown', (event) => startupExceptions.push(event.exceptionDetails));
  await page.send('Runtime.enable');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !await page.evaluate(`document.readyState === 'complete' && document.querySelector('.app-info')?.textContent.includes('Electron')`)) {
    await delay(100);
  }

  console.log(`READY ${JSON.stringify({ temporaryDirectory, launcherPid: child.pid })}`);

  await check('document title and renderer startup', async () => {
    assert.equal(await page.evaluate('document.title'), "Ge'orama");
    assert.equal(await page.evaluate(`document.querySelector('.app-info')?.textContent.includes('Electron')`), true);
    assert.deepEqual(startupExceptions, [], 'no uncaught startup exceptions');
  });

  await check('trusted app info IPC', async () => {
    const info = await page.evaluate('window.georama.getAppInfo()');
    assert.equal(info.name, "Ge'orama");
    assert.equal(info.id, 'georama');
    assert.equal(info.version, pkg.version);
    assert.equal(info.electron, pkg.devDependencies.electron);
    assert.equal(info.e2e, true);
  });

  await check('asset IPC refuses unselected roots and arbitrary file references', async () => {
    const unavailable = await page.evaluate("window.georama.readUserImage('symbol', 'user://assets/p/tree')");
    assert.deepEqual(unavailable, { ok: false, code: 'NOT_SELECTED' });
    const forbidden = await page.evaluate("window.georama.readUserImage('symbol', 'res://sprites/tree')");
    assert.deepEqual(forbidden, { ok: false, code: 'INVALID' });
    const absolute = await page.evaluate("window.georama.readUserImage('symbol', 'C:\\\\private\\\\secret.png')");
    assert.deepEqual(absolute, { ok: false, code: 'INVALID' });
  });

  await check('renderer has no Node globals', async () => {
    assert.deepEqual(await page.evaluate('[typeof require, typeof process, typeof module]'), ['undefined', 'undefined', 'undefined']);
  });

  await check('minimal frozen preload API', async () => {
    assert.deepEqual(await page.evaluate('Object.keys(window.georama)'), ['getAppInfo', 'selectUserAssets', 'readUserImage']);
    assert.equal(await page.evaluate('Object.isFrozen(window.georama)'), true);
  });

  await check('CSP response header', async () => {
    const policy = await page.evaluate(`fetch(location.href).then(response => response.headers.get('content-security-policy'))`);
    assert.ok(policy?.includes("default-src 'none'"));
    assert.ok(!policy.includes('unsafe-eval'));
    assert.ok(!policy.includes('unsafe-inline'));
  });

  await check('traversal denied with a working legitimate-fetch control', async () => {
    const results = await page.evaluate(`(async () => {
      const legitimate = await fetch('/index.html');
      const attacks = [];
      for (const url of [
        'georama://app/%2e%2e/package.json',
        'georama://app/..%2fpackage.json',
        'georama://app/%2e%2e%2fpackage.json',
      ]) {
        try {
          const response = await fetch(url);
          attacks.push({ url, status: response.status, body: await response.text() });
        } catch (error) { attacks.push({ url, networkError: String(error) }); }
      }
      return { legitimate: legitimate.status, attacks };
    })()`);
    assert.equal(results.legitimate, 200, 'positive control must be a working fetch');
    assert.equal(results.attacks.length, 3);
    for (const result of results.attacks) {
      assert.ok(result.networkError || result.status < 200 || result.status >= 300, `${result.url} unexpectedly succeeded`);
      assert.ok(!result.body?.includes('"name": "georama"'), `${result.url} leaked package.json`);
    }
  });

  await check('CSP blocks eval and executable inline scripts', async () => {
    const result = await page.evaluate(`(async () => {
      const violations = [];
      const listener = event => violations.push(event.effectiveDirective);
      document.addEventListener('securitypolicyviolation', listener);
      let evalBlocked = false;
      try { new Function('return 1')(); } catch (error) { evalBlocked = error instanceof EvalError; }
      // Intentional constant attack payload: prove CSP rejects execution; no untrusted input.
      document.body.insertAdjacentHTML('beforeend', '<script>window.__pwn=1<\/script>');
      // innerHTML-created scripts are inert even without CSP; also try an executable script node.
      const script = document.createElement('script');
      script.textContent = 'window.__pwn=1';
      document.body.append(script);
      await new Promise(resolve => setTimeout(resolve, 100));
      script.remove();
      document.removeEventListener('securitypolicyviolation', listener);
      return { evalBlocked, inlineBlocked: typeof window.__pwn === 'undefined', violations };
    })()`);
    assert.equal(result.evalBlocked, true);
    assert.equal(result.inlineBlocked, true);
    assert.ok(result.violations.includes('script-src'), 'eval must trigger a real CSP violation');
    assert.ok(result.violations.includes('script-src-elem'), 'executable inline script must trigger a real CSP violation');
  });

  await check('external navigation and popups denied, nothing reaches a loopback server', async () => {
    // A loopback server stands in for "the internet": a hardened app must never connect to it.
    const requests = [];
    const server = http.createServer((request, response) => { requests.push(`${request.method} ${request.url}`); response.end('reached'); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const external = `http://127.0.0.1:${server.address().port}/`;
    const events = [];
    for (const method of ['Page.frameRequestedNavigation', 'Page.frameStartedLoading', 'Page.frameNavigated']) {
      page.on(method, () => events.push(method));
    }
    try {
      await page.send('Page.enable');
      const before = await page.evaluate('location.href');
      await page.evaluate(`location.assign(${JSON.stringify(external)})`);
      assert.equal(await page.evaluate(`window.open(${JSON.stringify(external)}) === null`), true, 'window.open is denied');
      await page.evaluate(`(() => {
        const link = document.createElement('a');
        link.href = ${JSON.stringify(external)};
        link.target = '_blank';
        document.body.append(link);
        link.click();
        link.remove();
      })()`);
      // Wait on a real signal, not a fixed sleep: the page must stay quiet for 400 ms after its last navigation event.
      let seen = events.length;
      let lastEvent = Date.now();
      const limit = Date.now() + 5_000;
      while (Date.now() < limit) {
        await delay(100);
        if (events.length !== seen) { seen = events.length; lastEvent = Date.now(); }
        else if (Date.now() - lastEvent >= 400) break;
      }
      assert.equal(await page.evaluate('location.href'), before, 'the page stays on the app document');
      assert.deepEqual(requests, [], 'the loopback server saw no request');
      console.log(`INFO navigation attempts produced ${events.length} CDP navigation events; loopback requests=${requests.length}`);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await check('runtime BrowserWindow hardening and userData identity', async () => {
    const target = await targetAt(mainPort, (entry) => entry.type === 'node');
    const main = await connect(target.webSocketDebuggerUrl);
    const runtime = await main.evaluate(`(async () => {
      const { app, BrowserWindow } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
      const window = BrowserWindow.getAllWindows()[0];
      const contents = window.webContents;
      // Electron omits these consumed options from getLastWebPreferences; use their real APIs.
      contents.openDevTools({ mode: 'detach' });
      await new Promise(resolve => setTimeout(resolve, 200));
      return {
        preferences: contents.getLastWebPreferences(),
        backgroundThrottling: contents.getBackgroundThrottling(),
        spellcheck: contents.session.isSpellCheckerEnabled(),
        devToolsOpened: contents.isDevToolsOpened(),
        name: app.getName(), userData: app.getPath('userData'), appData: app.getPath('appData'),
      };
    })()`);
    for (const [key, expected] of Object.entries({
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
    })) assert.equal(runtime.preferences[key], expected, `runtime ${key}`);
    assert.equal(runtime.backgroundThrottling, false, 'runtime background throttling');
    assert.equal(runtime.spellcheck, false, 'runtime session spellchecking');
    assert.equal(runtime.devToolsOpened, false, 'runtime devTools disabled even when opening is attempted');
    assert.equal(await page.evaluate('isSecureContext'), true, 'custom scheme is a secure context');
    assert.equal(await page.evaluate(`navigator.permissions.query({ name: 'geolocation' }).then(result => result.state)`), 'denied');
    assert.equal(runtime.name, 'georama');
    assert.equal(runtime.userData, temporaryDirectory, 'CLI user-data isolation is effective');
    console.log(`INFO userData=${runtime.userData}; default identity=${path.join(runtime.appData, runtime.name)}`);
  });

  const capabilities = await page.evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { crossOriginIsolated, renderer: gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable' };
  })()`);
  console.log(`INFO crossOriginIsolated=${capabilities.crossOriginIsolated}; WebGL2=${capabilities.renderer}`);
  if (/SwiftShader|llvmpipe/i.test(capabilities.renderer)) console.log('WARN software WebGL renderer detected');
} catch (error) {
  total += 1;
  console.log(`FAIL harness: ${error.stack ?? error.message}`);
} finally {
  try { await cleanup(); } catch (error) {
    total += 1;
    console.log(`FAIL cleanup: ${error.stack ?? error.message}`);
  }
  console.log(`E2E: ${passed}/${total} passed`);
  process.exitCode = passed === total && total > 0 ? 0 : 1;
}
