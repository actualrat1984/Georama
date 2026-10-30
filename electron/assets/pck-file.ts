import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { PCK_LIMITS, PckError, parsePckIndex, readPckEntry } from '../../src/core/assets/pck.ts';
import type { PckIndex } from '../../src/core/assets/pck.ts';

export const PCK_FILE_LIMITS = Object.freeze({
  maxReadBytes: 64 * 1024 * 1024,
  maxConcurrentReads: 4,
});

export type PckFileErrorCode =
  | 'PATH'
  | 'LIMIT'
  | 'MISSING'
  | 'TYPE'
  | 'IO'
  | 'CHANGED'
  | 'CLOSED'
  | 'BUSY';

export class PckFileError extends Error {
  readonly code: PckFileErrorCode;
  constructor(code: PckFileErrorCode, message: string) {
    super(message);
    this.name = 'PckFileError';
    this.code = code;
  }
}

export interface PckFile {
  readonly fileSize: number;
  readData(path: string, maxBytes?: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

const LEAF = 'Wonderdraft.pck';

function fail(code: PckFileErrorCode, message: string): never {
  throw new PckFileError(code, message);
}

function validateRoot(root: unknown): string {
  if (typeof root !== 'string') fail('PATH', 'Install root must be a normalized absolute directory');
  const value = root as string;
  if (
    value.length === 0 ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    /[\x00-\x1f\x7f-\x9f\p{Surrogate}]/u.test(value) ||
    path.posix.normalize(value) !== value
  ) {
    fail('PATH', 'Install root must be a normalized absolute directory');
  }
  return value;
}

function toFileError(error: unknown): PckFileError {
  if (error instanceof PckFileError) return error;
  if (error instanceof PckError) throw error;
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
  if (code === 'ENOENT') return new PckFileError('MISSING', 'Archive or install root is missing');
  if (code === 'ELOOP' || code === 'ENOTDIR') {
    return new PckFileError('PATH', 'Install path contains a link or non-directory');
  }
  return new PckFileError('IO', 'Could not read archive data');
}

interface Snapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function snapshotOf(stat: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): Snapshot {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}

async function currentSnapshot(handle: FileHandle): Promise<Snapshot> {
  try {
    const stat = await handle.stat({ bigint: true });
    return snapshotOf(stat as unknown as Snapshot);
  } catch (error) {
    throw toFileError(error);
  }
}

async function assertUnchanged(handle: FileHandle, expected: Snapshot): Promise<void> {
  const now = await currentSnapshot(handle);
  if (!sameSnapshot(now, expected)) fail('CHANGED', 'Archive changed while reading');
}

async function readInto(
  handle: FileHandle,
  buffer: Uint8Array,
  bufferOffset: number,
  length: number,
  position: number,
): Promise<void> {
  let done = 0;
  while (done < length) {
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, bufferOffset + done, length - done, position + done));
    } catch (error) {
      throw toFileError(error);
    }
    if (bytesRead <= 0) fail('IO', 'Archive ended while reading');
    done += bytesRead;
  }
}

function u32le(view: DataView, pos: number): number {
  return view.getUint32(pos, true);
}

/**
 * Node/main-only held-descriptor PCK data session (never renderer IPC).
 *
 * The install root is canonicalized once, then held as a directory
 * descriptor; only the fixed Wonderdraft.pck leaf is opened through that
 * descriptor with O_NOFOLLOW|O_NONBLOCK. The archive descriptor is kept for
 * the session and never reopened by pathname, so a renamed or replaced root
 * cannot redirect later reads. Index discovery is a linear metadata scan:
 * the exact 88-byte GDPC v1 header is validated first, then only exact
 * 4-byte path-length fields are read to compute the precise indexEnd within
 * PCK_LIMITS.maxIndexBytes+88; the exact 0..indexEnd prefix is parsed with
 * the unchanged portable parser and no payload byte is read until an
 * allowed readData request. Payload reads are bounded by
 * PCK_FILE_LIMITS.maxReadBytes each and at most maxConcurrentReads in
 * flight. This is not a cache, PNG decoder, store, or evidence CLI.
 */
async function discoverIndex(handle: FileHandle, fileSize: number, expected: Snapshot): Promise<PckIndex> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 88) {
    throw new PckError('TRUNCATED', 'Archive smaller than the PCK header', fileSize);
  }
  await assertUnchanged(handle, expected);
  const header = new Uint8Array(88);
  await readInto(handle, header, 0, 88, 0);
  await assertUnchanged(handle, expected);
  try {
    const index = parsePckIndex(header, fileSize);
    return index;
  } catch (error) {
    if (!(error instanceof PckError) || error.code !== 'TRUNCATED') throw error;
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const fileCount = u32le(view, 84);
  if (fileCount === 0 || fileCount > PCK_LIMITS.maxFiles) {
    throw new PckError('TRUNCATED', 'Archive header does not match its index', 88);
  }
  const cap = PCK_LIMITS.maxIndexBytes + 88;
  let pos = 88;
  for (let i = 0; i < fileCount; i++) {
    if (pos + 4 > fileSize) throw new PckError('TRUNCATED', `Entry ${i} runs past the archive`, pos);
    if (pos + 4 > cap) throw new PckError('LIMIT', 'PCK index exceeds the cap', pos);
    const lenBytes = new Uint8Array(4);
    await readInto(handle, lenBytes, 0, 4, pos);
    await assertUnchanged(handle, expected);
    const pathLength = new DataView(lenBytes.buffer).getUint32(0, true);
    if (pathLength === 0) throw new PckError('FORMAT', `Entry ${i} has an empty path`, pos);
    if (pathLength > PCK_LIMITS.maxPathBytes) {
      throw new PckError('LIMIT', `Entry ${i} path is too long`, pos);
    }
    const next = pos + 4 + pathLength + 32;
    if (!Number.isSafeInteger(next)) throw new PckError('RANGE', `Entry ${i} offset is not safe`, pos);
    if (next > cap) throw new PckError('LIMIT', 'PCK index exceeds the cap', pos);
    if (next > fileSize) throw new PckError('TRUNCATED', `Entry ${i} runs past the archive`, pos);
    pos = next;
  }
  if (pos > cap) throw new PckError('LIMIT', 'PCK index exceeds the cap', pos);
  const prefix = new Uint8Array(pos);
  prefix.set(header, 0);
  if (pos > 88) await readInto(handle, prefix, 88, pos - 88, 88);
  await assertUnchanged(handle, expected);
  return parsePckIndex(prefix, fileSize);
}

class HeldPckFile implements PckFile {
  readonly fileSize: number;
  private handle: FileHandle;
  private readonly index: PckIndex;
  private readonly expected: Snapshot;
  private closed = false;
  private active = 0;
  private closePromise: Promise<void> | undefined;
  private readonly fd: number;

  constructor(handle: FileHandle, index: PckIndex, expected: Snapshot, fileSize: number) {
    this.handle = handle;
    this.index = index;
    this.expected = expected;
    this.fileSize = fileSize;
    this.fd = handle.fd;
    void this.fd;
  }

  async readData(entryPath: string, maxBytes: number = PCK_FILE_LIMITS.maxReadBytes): Promise<Uint8Array> {
    if (typeof entryPath !== 'string') fail('PATH', 'Entry path must be a string');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PCK_FILE_LIMITS.maxReadBytes) {
      fail('LIMIT', 'Invalid read byte limit');
    }
    if (this.closed) fail('CLOSED', 'Archive session is closed');
    if (this.active >= PCK_FILE_LIMITS.maxConcurrentReads) {
      fail('BUSY', 'Too many concurrent archive reads');
    }
    this.active += 1;
    try {
      const handle = this.handle;
      const expected = this.expected;
      const source = {
        size: this.fileSize,
        read: async (offset: number, length: number): Promise<Uint8Array> => {
          if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 0 ||
            length > this.fileSize ||
            offset > this.fileSize - length
          ) {
            throw new PckError('RANGE', 'Entry does not fit in this archive', 0);
          }
          await assertUnchanged(handle, expected);
          const out = new Uint8Array(length);
          await readInto(handle, out, 0, length, offset);
          await assertUnchanged(handle, expected);
          return out;
        },
      };
      return await readPckEntry(source, this.index, entryPath, maxBytes);
    } catch (error) {
      if (error instanceof PckError || error instanceof PckFileError) throw error;
      throw toFileError(error);
    } finally {
      this.active -= 1;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const handle = this.handle;
    this.closePromise = (async () => {
      while (this.active > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      try {
        await handle.close();
      } catch (error) {
        throw toFileError(error);
      }
    })();
    return this.closePromise;
  }
}

export async function openPckFile(installRoot: string): Promise<PckFile> {
  // Fail closed until a Windows held-handle implementation is independently verified.
  if (process.platform !== 'linux') fail('IO', 'Archive reader requires Linux descriptor paths');
  const root = validateRoot(installRoot);
  let rootHandle: FileHandle | undefined;
  let archiveHandle: FileHandle | undefined;
  const done = async (error: unknown): Promise<never> => {
    if (archiveHandle) {
      try {
        await archiveHandle.close();
      } catch {
        /* owned descriptor released on best effort */
      }
      archiveHandle = undefined;
    }
    if (rootHandle) {
      try {
        await rootHandle.close();
      } catch {
        /* owned descriptor released on best effort */
      }
      rootHandle = undefined;
    }
    if (error instanceof PckError || error instanceof PckFileError) throw error;
    throw toFileError(error);
  };
  try {
    let canonical: string;
    try {
      canonical = await fs.realpath(root);
    } catch (error) {
      throw toFileError(error);
    }
    const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    try {
      rootHandle = await fs.open(canonical, dirFlags);
    } catch (error) {
      rootHandle = undefined;
      throw toFileError(error);
    }
    const held = rootHandle;
    let identity: string;
    try {
      identity = await fs.realpath(`/proc/self/fd/${held.fd}`);
    } catch (error) {
      throw toFileError(error);
    }
    if (identity !== canonical) fail('PATH', 'Install root changed while opening');
    try {
      archiveHandle = await fs.open(`/proc/self/fd/${held.fd}/${LEAF}`, fileFlags);
    } catch (error) {
      archiveHandle = undefined;
      throw toFileError(error);
    }
    const archive = archiveHandle;
    try {
      await held.close();
    } catch (error) {
      throw toFileError(error);
    }
    rootHandle = undefined;
    let stat: Awaited<ReturnType<FileHandle['stat']>>;
    try {
      stat = await archive.stat({ bigint: true });
    } catch (error) {
      throw toFileError(error);
    }
    const big = stat as unknown as Snapshot & { size: bigint; isFile(): boolean };
    if (!stat.isFile()) fail('TYPE', 'Archive must be a regular file');
    if (big.size <= 0n || big.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail('IO', 'Archive size is not usable');
    }
    const fileSize = Number(big.size);
    const expected = snapshotOf(big);
    let index: PckIndex;
    try {
      index = await discoverIndex(archive, fileSize, expected);
    } catch (error) {
      if (error instanceof PckError || error instanceof PckFileError) throw error;
      throw toFileError(error);
    }
    const session = new HeldPckFile(archive, index, expected, fileSize);
    archiveHandle = undefined;
    return session;
  } catch (error) {
    return done(error);
  }
}
