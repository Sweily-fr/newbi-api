import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.js"],
    exclude: ["node_modules", "dist", "e2e"],
    // Chaque fichier démarre son propre MongoMemoryServer (~19 mongod). Lancés tous en
    // parallèle, la contention faisait dépasser les timeouts par défaut (hook 10s / test 5s)
    // sur startMongo/clearMongo → "Hook timed out" + E11000 en cascade.
    // On laisse plus de marge ET on plafonne le nombre de forks concurrents pour limiter
    // le nombre de mongod simultanés (démarrages plus rapides, suite fiable).
    hookTimeout: 60000,
    testTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: { maxForks: 4, minForks: 1 },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      exclude: ["node_modules", "dist", "__tests__", "src/tests", "src/emails"],
      thresholds: {
        statements: 45,
        branches: 30,
        functions: 40,
        lines: 45,
      },
    },
  },
});
