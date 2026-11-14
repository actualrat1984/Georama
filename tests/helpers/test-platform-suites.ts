/**
 * Test files are shared by default. Only backend-specific filesystem contracts
 * are excluded on the host that cannot offer that backend. Every exception has
 * an explanation in docs/TEST-PLATFORMS.md.
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
  // No native reader backend has been validated on other operating systems.
  return [...linuxOnlyUnitTests, ...windowsOnlyUnitTests];
}
