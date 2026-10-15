import { defineConfig } from "vitest/config";

/**
 * The e2e suite boots a real Nest app against the shared test database and
 * truncates tables between tests, so it runs one file and one test at a time —
 * the same reason packages/db does.
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
  esbuild: {
    // NestJS decorators. Metadata emission is not available in esbuild, which
    // is why every provider uses an explicit @Inject(TOKEN).
    target: "es2022",
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    },
  },
});
