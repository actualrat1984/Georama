import { defineConfig } from 'vitest/config';
import { excludedUnitTests } from './tests/helpers/test-platform-suites.ts';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: [...excludedUnitTests(process.platform)],
    // A few existing assertions enforce strict wall-clock limits. Running
    // unrelated filesystem suites simultaneously makes these nondeterministic.
    fileParallelism: false,
  },
});
