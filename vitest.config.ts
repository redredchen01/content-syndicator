import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Co-located tests under src/**/__tests__/*.test.ts and scripts/
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    environment: 'node',
    globals: true,
    // Each test starts with a clean module cache so DB-backed tests using
    // `:memory:` can run in isolation. Plan Unit 14.
    isolate: true,
    // Fast fail loud — preflight scripts and runtime helpers should not flake.
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/types/**',
        'src/index.ts',
        'src/server.ts', // covered by integration smoke, not vitest
      ],
    },
  },
});
