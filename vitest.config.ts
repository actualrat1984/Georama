import { defineConfig } from 'vitest/config';
import { excludedUnitTests } from './tests/helpers/test-platform-suites.ts';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: [...excludedUnitTests(process.platform)],
    // A few existing parser assertions use tight elapsed-time bounds; avoid
    // unrelated CPU/disk work running at the same time as those checks.
    fileParallelism: false,
  },
});
