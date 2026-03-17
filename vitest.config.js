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
        statements: 45,
        branches: 30,
        functions: 40,
        lines: 45,
      }
    }
  }
});
