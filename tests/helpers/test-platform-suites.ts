/**
 * Unit-test platform contracts.
 *
 * Linux-only files exercise descriptor-relative /proc/self/fd opens, O_NOFOLLOW,
 * POSIX filenames, FIFOs, and Unix process/socket semantics. Windows has
 * separate native secure-reader and selected-file integration tests.
 *
 * Some files contain portable subcases too. Until they are split into shared
 * and platform-specific files, they remain Linux-only as *files* to avoid
 * accidentally interpreting a Linux assertion as a Windows security promise.
 * Do not add a failure here solely to make CI green: classify its mechanism.
 */
export const linuxOnlyUnitTests = Object.freeze([
  'tests/unit/assets-config-strength.test.ts',
  'tests/unit/assets-config.test.ts',
  'tests/unit/assets-open.test.ts',
  'tests/unit/assets-pck-file-strength.test.ts',
  'tests/unit/assets-pck-file.test.ts',
  'tests/unit/assets-store-strength.test.ts',
  'tests/unit/assets-store.test.ts',
  'tests/unit/assets-symbol-store-strength.test.ts',
  'tests/unit/assets-symbol-store.test.ts',
  'tests/unit/assets-theme-store-strength.test.ts',
  'tests/unit/assets-theme-store.test.ts',
  'tests/unit/check-map-assets-cli.test.ts',
  'tests/unit/corpus-runner.test.ts',
  'tests/unit/gl-runner-lifecycle.test.ts',
  'tests/unit/launcher-display.test.ts',
  'tests/unit/map-asset-check-strength.test.ts',
  'tests/unit/map-asset-check.test.ts',
  'tests/unit/protocol.test.ts',
  'tests/unit/selected-config-file-strength.test.ts',
  'tests/unit/selected-config-file.test.ts',
  'tests/unit/selected-data-file-strength.test.ts',
  'tests/unit/selected-data-file.test.ts',
] as const);

export const windowsOnlyUnitTests = Object.freeze([
  'tests/unit/windows-asset-races.test.ts',
  'tests/unit/windows-asset-reader.test.ts',
  'tests/unit/windows-selected-files.test.ts',
] as const);

export function excludedUnitTests(platform: NodeJS.Platform): readonly string[] {
  if (platform === 'linux') return windowsOnlyUnitTests;
  if (platform === 'win32') return linuxOnlyUnitTests;
  // No native asset backend was validated on other platforms.
  return [...linuxOnlyUnitTests, ...windowsOnlyUnitTests];
}
