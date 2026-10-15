import { KYC_PROVIDERS } from "@kilowattx/integrations";
import { describe, expect, test } from "vitest";

/**
 * The worker has to accept every gateway the API accepts.
 *
 * This file exists because they drifted. The API gained "sandbox" while the
 * worker still listed "surepass", so selecting the real gateway brought the
 * API up and left the worker refusing to start on a config error — which
 * means no outbox drain and no reconciliation, while the API looks perfectly
 * healthy. The failure is silent in the worst way: nothing is broken on the
 * surface, notifications simply stop.
 *
 * Both schemas now read `KYC_PROVIDERS`, so they cannot disagree. These tests
 * guard the thing that made the drift possible rather than the one value that
 * happened to be missing.
 */

describe("the list of gateways", () => {
  test("is a single shared constant, not a copy in each app", () => {
    /**
     * Imported from the package both apps depend on. If somebody reintroduces
     * a literal list in either config, this still passes — which is why the
     * next test checks the actual schemas instead.
     */
    expect(KYC_PROVIDERS).toContain("fake");
    expect(KYC_PROVIDERS).toContain("sandbox");
  });

  /**
   * The real assertion: both config schemas accept exactly the same values.
   *
   * Loaded dynamically because the API's config module lives in another app.
   * The worker's own schema is imported from config.js rather than main.js,
   * which self-invokes main() — importing that to read a schema would start
   * the worker.
   */
  test("the API and the worker accept exactly the same gateways", async () => {
    const api = await import("../../api/src/config.js");
    const worker = await import("./config.js");

    /**
     * Each schema is asked, value by value, whether it accepts what the other
     * does. Comparing the enum arrays directly would pass even if one schema
     * had been changed to ignore its list.
     */
    for (const provider of KYC_PROVIDERS) {
      const apiAccepts = api.ConfigSchema.shape.KYC_PROVIDER.safeParse(provider).success;
      const workerAccepts =
        worker.ConfigSchema.shape.KYC_PROVIDER.safeParse(provider).success;

      expect(apiAccepts, `the API should accept ${provider}`).toBe(true);
      expect(workerAccepts, `the worker should accept ${provider}`).toBe(true);
    }
  });

  test("both refuse a gateway that does not exist", async () => {
    const api = await import("../../api/src/config.js");
    const worker = await import("./config.js");

    expect(api.ConfigSchema.shape.KYC_PROVIDER.safeParse("surepass").success).toBe(false);
    expect(worker.ConfigSchema.shape.KYC_PROVIDER.safeParse("surepass").success).toBe(
      false,
    );
  });
});
