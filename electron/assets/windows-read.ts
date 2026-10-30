import { spawn } from 'node:child_process';
import path from 'node:path';

export type WindowsReadError = 'PATH' | 'EXTENSION' | 'LIMIT' | 'MISSING' | 'TYPE' | 'IO' | 'BUSY';

export interface WindowsReadResult {
  readonly bytes?: Uint8Array;
  readonly error?: WindowsReadError;
}

export const WINDOWS_ASSET_HELPER_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxConcurrent: 4,
  timeoutMs: 60_000,
  terminationGraceMs: 3_000,
});

const MESSAGES = new Set(['PATH', 'LIMIT', 'MISSING', 'TYPE', 'IO']);
// Direct callers of readAssetFile can bypass the asset-store's four-read limit.
// Enforce a process-wide budget here as well, and release only when the child
// has closed (not when its timeout or output cap first fires).
let activeHelpers = 0;
let configuredHelper: string | undefined;

/**
 * Bind the helper to the application installation root, never to process.cwd().
 * Call once from trusted Electron main startup, before registering asset IPC.
 * Tests may supply their own checkout root, also independently of cwd.
 * Packaged builds remain fail-closed until the helper is installed there.
 */
export function configureWindowsAssetHelper(appRoot: string): void {
  if (configuredHelper !== undefined) throw new Error('Windows helper already configured');
  if (typeof appRoot !== 'string' || !path.isAbsolute(appRoot)) {
    throw new Error('Windows helper requires an absolute application root');
  }
  configuredHelper = path.join(appRoot, 'out', 'windows', 'georama-win-asset-read.exe');
}

/**
 * A dedicated Windows process opens/checks each HANDLE before emitting bytes.
 * No JavaScript realpath/lstat/exists preflight is used for authorization.
 * A missing helper or invalid response fails closed; no JS read fallback.
 *
 * The executable location is fixed at startup from the trusted app directory.
 * Production packaging and helper authentication are NOT implemented here.
 */
export function readWindowsAsset(
  root: string,
  relative: string,
  maxBytes: number,
): Promise<WindowsReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
      maxBytes > WINDOWS_ASSET_HELPER_LIMITS.maxBytes) {
    return Promise.resolve({ error: 'LIMIT' });
  }
  if (activeHelpers >= WINDOWS_ASSET_HELPER_LIMITS.maxConcurrent) {
    return Promise.resolve({ error: 'BUSY' });
  }

  const binary = configuredHelper;
  if (binary === undefined) return Promise.resolve({ error: 'IO' });
  activeHelpers += 1;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(binary, [root, relative, String(maxBytes)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
  } catch {
    activeHelpers -= 1;
    return Promise.resolve({ error: 'IO' });
  }

  return new Promise<WindowsReadResult>((resolve) => {
    let settled = false;
    let released = false;
    let forcedError: WindowsReadError | undefined;
    let stderr = '';
    let count = 0;
    const chunks: Buffer[] = [];
    let terminationGrace: ReturnType<typeof setTimeout> | undefined;

    function releaseSlot(): void {
      if (released) return;
      released = true;
      activeHelpers -= 1;
    }

    function finish(result: WindowsReadResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (terminationGrace !== undefined) clearTimeout(terminationGrace);
      chunks.length = 0;
      resolve(result);
    }

    function terminate(error: WindowsReadError): void {
      if (forcedError !== undefined || settled) return;
      forcedError = error;
      chunks.length = 0; // release partial unverified bytes before waiting
      try { child.kill(); } catch { /* fall through to bounded grace */ }
      // Wait for streams to close before resolving where possible. If a child
      // remains unresponsive, resolve IO/LIMIT but keep its concurrency slot
      // reserved until close: never start more children against a stuck one.
      if (!settled) {
        terminationGrace = setTimeout(
          () => finish({ error }),
          WINDOWS_ASSET_HELPER_LIMITS.terminationGraceMs,
        );
      }
    }

    const watchdog = setTimeout(() => terminate('IO'), WINDOWS_ASSET_HELPER_LIMITS.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || forcedError !== undefined) return;
      if (chunk.byteLength > maxBytes - count) {
        terminate('LIMIT');
        return;
      }
      count += chunk.byteLength;
      chunks.push(chunk);
    });
    child.stdout?.once('error', () => terminate('IO'));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (stderr.length < 256) stderr += chunk.toString('utf8').slice(0, 256 - stderr.length);
    });
    child.stderr?.once('error', () => terminate('IO'));

    child.once('error', () => {
      // A spawn failure has no running process. An error from an already
      // spawned process (for example an unsuccessful kill) must not release
      // its slot until the process/streams actually close.
      if (child.pid === undefined) {
        releaseSlot();
        finish({ error: 'IO' });
      } else {
        terminate('IO');
      }
    });
    child.once('close', (code) => {
      releaseSlot();
      if (forcedError !== undefined) return finish({ error: forcedError });
      if (code === 0 && stderr === '') {
        const bytes = Buffer.concat(chunks, count);
        return finish({ bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
      }
      const token = stderr.trim();
      finish({ error: MESSAGES.has(token) ? token as WindowsReadError : 'IO' });
    });
  });
}
