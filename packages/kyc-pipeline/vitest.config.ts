import { defineConfig } from "vitest/config";

/** Its own database, one test at a time. See scripts/setup-test-databases.mjs. */
export default defineConfig({
  test: {
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
