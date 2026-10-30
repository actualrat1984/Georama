import path from 'node:path';

const BAD_UNICODE = /[\x00-\x1f\x7f-\x9f\p{Surrogate}]/u;
// Windows also treats these names as devices when they have an extension.
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
const BAD_WIN_COMPONENT = /[<>:"|?*]/;

/**
 * Canonical absolute host paths only. On Windows this intentionally accepts
 * drive-qualified paths, not UNC, device, verbatim, or drive-relative paths.
 * Those forms need separate review before becoming read capabilities.
 *
 * Pure policy function so both platform decisions can be tested on either OS.
 * This is lexical validation, not a filesystem authorization or confinement
 * check; read functions must independently enforce their I/O policy.
 */
export function isNativeAbsolutePath(
  value: unknown,
  platform: string = process.platform,
  maxChars = 4096,
): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars || BAD_UNICODE.test(value)) {
    return false;
  }
  if (platform !== 'win32') {
    // Retain the original POSIX contract, including its permitted punctuation.
    return value.startsWith('/') && path.posix.normalize(value) === value;
  }
  if (!/^[A-Za-z]:\\/.test(value) || value.includes('/') || path.win32.normalize(value) !== value) {
    return false;
  }
  const remaining = value.slice(3);
  if (remaining === '') return true; // Canonical drive root, e.g. C:\
  const segments = remaining.split('\\');
  return segments.every((segment) =>
    segment.length > 0 &&
    !segment.endsWith('.') &&
    !segment.endsWith(' ') &&
    !BAD_WIN_COMPONENT.test(segment) &&
    !RESERVED_DEVICE.test(segment)
  );
}
