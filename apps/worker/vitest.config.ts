import { defineConfig } from "vitest/config";

/**
 * Its own database, and one test at a time. Turborepo runs package tasks in
 * parallel and every integration suite truncates tables, so sharing a
 * database means each suite deletes the other's rows mid-test.
 */
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
