import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const ASSET_FILE_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxPathChars: 4096,
  maxSegments: 16,
  maxSegmentBytes: 255,
});

export type AssetFileErrorCode = 'PATH' | 'EXTENSION' | 'LIMIT' | 'MISSING' | 'TYPE' | 'IO';

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
  if (typeof root !== 'string' || root.length === 0 || root.length > ASSET_FILE_LIMITS.maxPathChars ||
      !root.startsWith('/') || /[\x00-\x1f\x7f-\x9f\p{Surrogate}]/u.test(root) || path.posix.normalize(root) !== root) {
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
 * Linux-only, read-only byte access beneath an explicitly authorized directory.
 * The explicit root may be a symlink; after canonicalizing it, verify the opened
 * directory identity. Every descendant is opened via a held parent descriptor
 * and O_NOFOLLOW, not by rechecking a joined pathname before a later open.
 * Descendant symlinks (even internal ones) are refused. O_NONBLOCK ensures FIFOs
 * cannot hang an open before fstat rejects non-regular files.
 *
 * This is not a PNG/JSON validator or an IPC capability. Callers must validate
 * the returned bytes. In-place concurrent content changes are rejected when
 * size/mtime/ctime changes; no claim of an atomic snapshot against a privileged
 * actor restoring timestamps is made. Hardlinks are not distinguishable from
 * regular files, and mount/namespace manipulation is outside this boundary.
 */
export async function readAssetFile(
  root: string,
  relative: string,
  maxBytes: number = ASSET_FILE_LIMITS.maxBytes,
): Promise<Uint8Array> {
  // No Windows descriptor-confined backend yet; do not allow any filesystem I/O.
  if (process.platform !== 'linux') throw new AssetFileError('IO', 'Asset reader requires Linux descriptor paths');
  const parts = validate(root, relative, maxBytes);
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
