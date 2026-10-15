import { defineConfig } from "vitest/config";

/**
 * Integration tests share one Postgres database, and each file truncates the
 * tables in `beforeEach`. Run in parallel, two files truncate each other's
 * rows mid-test, and the failures look like foreign key violations and counts
 * that are off by one — which reads as a bug in the code under test rather
 * than a bug in the test setup.
 *
 * So: one fork, one file at a time, no concurrency within a file.
 *
 * The alternative is a schema per worker, which is faster and worth doing when
 * the suite grows enough to feel slow. It is not worth the machinery yet.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    /** A real database is slower than a pure function. */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
