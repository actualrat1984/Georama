import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isNativeAbsolutePath } from '../native-path.ts';

export const SELECTED_FILE_LIMITS = Object.freeze({
  maxReadBytes: 512 * 1024 * 1024,
  maxPathChars: 4096,
});

export type SelectedFileErrorCode =
  | 'PATH'
  | 'EXTENSION'
  | 'LIMIT'
  | 'MISSING'
  | 'TYPE'
  | 'IO'
  | 'CHANGED';

export class SelectedFileError extends Error {
  readonly code: SelectedFileErrorCode;
  constructor(code: SelectedFileErrorCode, message: string) {
    super(message);
    this.name = 'SelectedFileError';
    this.code = code;
  }
}

function toIO(error: unknown): SelectedFileError {
  if (error instanceof SelectedFileError) return error;
  return new SelectedFileError('IO', 'Could not read selected data');
}

const HARD_CAP = 536870912;

function checkCap(maxBytes: unknown): number {
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > HARD_CAP) {
    throw new SelectedFileError('LIMIT', 'Invalid byte limit');
  }
  return maxBytes;
}

function checkFilename(filename: unknown): string {
  if (typeof filename !== 'string') {
    throw new SelectedFileError('PATH', 'Invalid selected path');
  }
  const value = filename as string;
  if (!isNativeAbsolutePath(value, process.platform, SELECTED_FILE_LIMITS.maxPathChars)) {
    throw new SelectedFileError('PATH', 'Invalid selected path');
  }
  if (!(value.endsWith('.json') || value.endsWith('.wonderdraft_map'))) {
    throw new SelectedFileError('EXTENSION', 'Only JSON and map data files may be read');
  }
  return value;
}

function toOpenError(error: unknown): SelectedFileError {
  if (error instanceof SelectedFileError) return error;
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
  if (code === 'ENOENT') return new SelectedFileError('MISSING', 'Selected file is missing');
  if (code === 'ELOOP' || code === 'ENOTDIR') {
    return new SelectedFileError('PATH', 'Selected path contains a link');
  }
  return new SelectedFileError('IO', 'Could not read selected data');
}

interface HeldSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function takeSnapshot(stat: unknown): HeldSnapshot {
  const s = stat as Record<string, unknown>;
  return {
    dev: s['dev'] as bigint,
    ino: s['ino'] as bigint,
    size: s['size'] as bigint,
    mtimeNs: s['mtimeNs'] as bigint,
    ctimeNs: s['ctimeNs'] as bigint,
  };
}

function sameSnapshot(a: HeldSnapshot, b: HeldSnapshot): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function heldStat(handle: { stat(o: unknown): Promise<unknown> }): Promise<HeldSnapshot> {
  let stat: unknown;
  try {
    stat = await handle.stat({ bigint: true });
  } catch (error) {
    if (error instanceof SelectedFileError) throw error;
    throw new SelectedFileError('IO', 'Could not read selected data');
  }
  return takeSnapshot(stat);
}

export async function readSelectedDataFile(filename: string, maxBytes: number): Promise<Uint8Array> {
  const cap = checkCap(maxBytes);
  const safe = checkFilename(filename);
  // Windows does not expose the Linux O_NOFOLLOW guarantee. A preflight
  // rejects ordinary symlink leaves but is NOT race-proof. This API reads
  // explicitly selected files, not files confined beneath an asset root.
  if (process.platform === 'win32') {
    let leaf: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      leaf = await fs.lstat(safe);
    } catch (error) {
      throw toOpenError(error);
    }
    if (leaf.isSymbolicLink()) throw new SelectedFileError('PATH', 'Selected path contains a link');
  }
  const flags = process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(safe, flags);
  } catch (error) {
    throw toOpenError(error);
  }
  let result: Uint8Array | undefined;
  let failure: SelectedFileError | undefined;
  try {
    let stat: Awaited<ReturnType<typeof handle.stat>>;
    try {
      stat = await handle.stat({ bigint: true });
    } catch (error) {
      throw toIO(error);
    }
    if (!stat.isFile()) throw new SelectedFileError('TYPE', 'Selected file must be a regular file');
    const rawSize = (stat as unknown as { size: bigint }).size;
    if (typeof rawSize !== 'bigint') throw new SelectedFileError('IO', 'Could not read selected data');
    if (rawSize < 0n) throw new SelectedFileError('IO', 'Could not read selected data');
    if (rawSize > BigInt(cap)) throw new SelectedFileError('LIMIT', 'Selected file exceeds byte limit');
    const expected = takeSnapshot(stat);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Number(rawSize));
    } catch {
      throw new SelectedFileError('LIMIT', 'Selected file exceeds byte limit');
    }
    let done = 0;
    while (done < bytes.length) {
      let bytesRead: unknown;
      try {
        ({ bytesRead } = await handle.read(bytes, done, bytes.length - done, done));
      } catch (error) {
        throw toIO(error);
      }
      const now = await heldStat(handle);
      if (!sameSnapshot(now, expected)) {
        throw new SelectedFileError('CHANGED', 'Selected file changed while reading');
      }
      if (
        typeof bytesRead !== 'number' ||
        !Number.isInteger(bytesRead) ||
        (bytesRead as number) <= 0 ||
        (bytesRead as number) > bytes.length - done
      ) {
        throw new SelectedFileError('IO', 'Could not read selected data');
      }
      done += bytesRead as number;
    }
    const after = await heldStat(handle);
    if (!sameSnapshot(after, expected)) {
      throw new SelectedFileError('CHANGED', 'Selected file changed while reading');
    }
    result = bytes;
  } catch (error) {
    failure = error instanceof SelectedFileError ? error : toIO(error);
  } finally {
    try {
      await handle.close();
    } catch (error) {
      failure ??= toIO(error);
    }
  }
  if (failure) throw failure;
  if (result === undefined) throw new SelectedFileError('IO', 'Could not read selected data');
  return result;
}
