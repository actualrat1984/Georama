import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  excludedUnitTests, linuxOnlyUnitTests, windowsOnlyUnitTests,
} from '../helpers/test-platform-suites.ts';

describe('unit test platform selection', () => {
  it('lists only existing unit files and never assigns a file to both native platforms', async () => {
    const directory = fileURLToPath(new URL('./', import.meta.url));
    const files = new Set((await readdir(directory)).filter((name) => name.endsWith('.test.ts')));
    const linuxOnly = new Set<string>(linuxOnlyUnitTests);
    const windowsOnly = new Set<string>(windowsOnlyUnitTests);
    expect(linuxOnly.size).toBe(linuxOnlyUnitTests.length);
    expect(windowsOnly.size).toBe(windowsOnlyUnitTests.length);
    for (const file of [...linuxOnly, ...windowsOnly]) {
      expect(file.startsWith('tests/unit/')).toBe(true);
      expect(files.has(file.slice('tests/unit/'.length)), file).toBe(true);
      expect(linuxOnly.has(file) && windowsOnly.has(file), file).toBe(false);
    }
  });

  it('runs Windows-native files only on Windows and Linux descriptor files only on Linux', () => {
    expect(excludedUnitTests('linux')).toEqual(windowsOnlyUnitTests);
    expect(excludedUnitTests('win32')).toEqual(linuxOnlyUnitTests);
    expect(excludedUnitTests('darwin')).toEqual([...linuxOnlyUnitTests, ...windowsOnlyUnitTests]);
    for (const platform of ['linux', 'win32'] as const) {
      const excluded = new Set(excludedUnitTests(platform));
      for (const shared of [
        'tests/unit/asset-ipc.test.ts',
        'tests/unit/ipc-sender.test.ts',
        'tests/unit/windows-asset-bridge.test.ts',
        'tests/unit/native-path.test.ts',
        'tests/unit/core-boundary.test.ts',
      ]) {
        expect(excluded.has(shared), `${platform}: ${shared}`).toBe(false);
      }
    }
  });
});
