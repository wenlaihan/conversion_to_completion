import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // The browser app imports the compiled engine from dist/. Under test it resolves
      // to the TypeScript source instead, so the web smoke test exercises the same code
      // the other suites do and does not need a build step to have run first.
      {
        find: /^\.\.\/dist\/(.*)\.js$/,
        replacement: `${fileURLToPath(new URL('./src/', import.meta.url))}$1.ts`,
      },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
