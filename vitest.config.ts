import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * A single Vitest run covers every workspace. Workspace packages resolve to
 * their TypeScript sources rather than `dist`, so tests never need a build
 * step and always exercise the code as written.
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
  },
  resolve: {
    alias: {
      '@octoprice/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
});
