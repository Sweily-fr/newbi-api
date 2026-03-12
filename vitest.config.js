import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.js'],
    exclude: ['node_modules', 'dist', 'e2e'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      exclude: ['node_modules', 'dist', '__tests__', 'src/tests', 'src/emails'],
      thresholds: {
        statements: 30,
        branches: 20,
        functions: 25,
        lines: 30,
      }
    }
  }
});
