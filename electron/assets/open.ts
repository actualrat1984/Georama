import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isNativeAbsolutePath } from '../native-path.ts';
import { readWindowsAsset } from './windows-read.ts';

export const ASSET_FILE_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxPathChars: 4096,
  maxSegments: 16,
  maxSegmentBytes: 255,
});

export type AssetFileErrorCode = 'PATH' | 'EXTENSION' | 'LIMIT' | 'MISSING' | 'TYPE' | 'IO' | 'BUSY';

export class AssetFileError extends Error {
  readonly code: AssetFileErrorCode;
  constructor(code: AssetFileErrorCode, message: string) {
    super(message);
    this.name = 'AssetFileError';
    this.code = code;
  }
}

const BAD_CHAR = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\\:<>"|?*\p{Surrogate}]/u;
const DATA_SUFFIXES = Object.freeze(['.png', '.wonderdraft_image', '.wonderdraft_symbols', '.wonderdraft_theme']);

function validate(root: string, relative: string, maxBytes: number): string[] {
  if (!isNativeAbsolutePath(root, process.platform, ASSET_FILE_LIMITS.maxPathChars)) {
    throw new AssetFileError('PATH', 'Asset root must be a normalized absolute directory');
  }
  if (typeof relative !== 'string' || relative.length === 0 || relative.length > ASSET_FILE_LIMITS.maxPathChars ||
      BAD_CHAR.test(relative)) {
    throw new AssetFileError('PATH', 'Invalid relative asset path');
  }
  const parts = relative.split('/');
  if (parts.length > ASSET_FILE_LIMITS.maxSegments || parts.some((part, i) =>
    part.length === 0 || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > ASSET_FILE_LIMITS.maxSegmentBytes ||
    (part.startsWith('.') && !(i === parts.length - 1 && part === '.wonderdraft_symbols')))) {
    throw new AssetFileError('PATH', 'Invalid asset path segment');
  }
  if (!DATA_SUFFIXES.some((suffix) => relative.endsWith(suffix))) {
    throw new AssetFileError('EXTENSION', 'Only image and asset JSON data files may be read');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > ASSET_FILE_LIMITS.maxBytes) {
    throw new AssetFileError('LIMIT', 'Invalid asset byte limit');
  }
  return parts;
}

function ioError(error: unknown): AssetFileError {
  if (error instanceof AssetFileError) return error;
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT') return new AssetFileError('MISSING', 'Asset file or root is missing');
  if (code === 'ELOOP' || code === 'ENOTDIR') return new AssetFileError('PATH', 'Asset path contains a link or non-directory');
  return new AssetFileError('IO', 'Could not read asset data');
}

/**
 * Read-only byte access beneath an explicitly authorized directory.
 *
 * Linux retains its original held-parent-descriptor /proc/self/fd traversal,
 * O_NOFOLLOW and O_NONBLOCK semantics (including a symlinked explicit root).
 * Windows delegates to a separate native helper that holds Win32 directory
 * handles without FILE_SHARE_DELETE, opens each child without reparse traversal,
 * checks opened-handle identity, and returns bytes only after verifying them.
 * Missing/failed native helper => IO, never an unsafe JavaScript fallback.
 *
 * This is not an IPC capability or a PNG/JSON validator. Callers must validate
 * the returned bytes. Neither backend promises atomic snapshots against actors
 * modifying bytes while restoring all observed metadata. Hardlinks, privileged
 * volume manipulation and filesystem filter behavior need separate review.
 */
export async function readAssetFile(
  root: string,
  relative: string,
  maxBytes: number = ASSET_FILE_LIMITS.maxBytes,
): Promise<Uint8Array> {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    throw new AssetFileError('IO', 'Asset reader requires a supported filesystem backend');
  }
  const parts = validate(root, relative, maxBytes);
  if (process.platform === 'win32') {
    const result = await readWindowsAsset(root, relative, maxBytes);
    if (result.bytes !== undefined) return result.bytes;
    const code = result.error ?? 'IO';
    throw new AssetFileError(code, code === 'LIMIT' ? 'Asset exceeds byte limit' : 'Could not read asset data');
  }
  const handles: FileHandle[] = [];
  let result: Uint8Array | undefined;
  let failure: AssetFileError | undefined;
  try {
    const canonical = await fs.realpath(root);
    const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    let directory = await fs.open(canonical, dirFlags);
    handles.push(directory);
    const descriptorPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
    if (await fs.realpath(descriptorPath(directory)) !== canonical) {
      throw new AssetFileError('PATH', 'Asset root changed while opening');
    }
    for (const part of parts.slice(0, -1)) {
      directory = await fs.open(`${descriptorPath(directory)}/${part}`, dirFlags);
      handles.push(directory);
    }
    const file = await fs.open(`${descriptorPath(directory)}/${parts[parts.length - 1]}`, fileFlags);
    handles.push(file);
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new AssetFileError('TYPE', 'Asset must be a regular file');
    if (before.size < 0n || before.size > BigInt(maxBytes)) throw new AssetFileError('LIMIT', 'Asset exceeds byte limit');
    const bytes = new Uint8Array(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0) throw new AssetFileError('IO', 'Asset changed or ended while reading');
      offset += bytesRead;
    }
    const extra = new Uint8Array(1);
    const { bytesRead: extraRead } = await file.read(extra, 0, 1, bytes.length);
    const after = await file.stat({ bigint: true });
    if (after.size > BigInt(maxBytes)) throw new AssetFileError('LIMIT', 'Asset grew beyond byte limit');
    if (extraRead !== 0 || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new AssetFileError('IO', 'Asset changed while reading');
    }
    result = bytes;
  } catch (error) {
    failure = ioError(error);
  } finally {
    for (const handle of handles.reverse()) {
      try { await handle.close(); } catch (error) { failure ??= ioError(error); }
    }
  }
  if (failure) throw failure;
  if (result === undefined) throw new AssetFileError('IO', 'Asset read did not finish');
  return result;
}
