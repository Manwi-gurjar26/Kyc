import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";

/**
 * What the web app's environment chip is told.
 *
 * The chip said "Fake vendor · nothing is really verified" while the API was
 * running DigiLocker on a live key. The answer has to follow the config the
 * API actually started with, and the live/test call has to follow the key the
 * way SandboxClient does.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";

let app: NestExpressApplication | undefined;

async function start(env: Record<string, string>) {
  app = await createApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: DB_URL,
      KYC_WEBHOOK_SECRET: "whsec_devenv_e2e_test_000",
      KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 41).toString("base64"),
      FILE_SIGNING_SECRET: "filesign_devenv_e2e_test_0000",
      ...env,
    } as NodeJS.ProcessEnv),
  });
  await app.init();
  return request(app.getHttpServer());
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /v1/dev/environment", () => {
  test("the fake provider calls no vendor", async () => {
    const http = await start({ KYC_PROVIDER: "fake" });

    const res = await http.get("/v1/dev/environment").expect(200);

    expect(res.body).toEqual({ kycProvider: "fake", vendorEnvironment: null });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("DigiLocker on a live key is reported as live", async () => {
    const http = await start({
      KYC_PROVIDER: "digilocker",
      KYC_VENDOR_CLIENT_ID: "key_live_devenv_e2e",
      KYC_VENDOR_CLIENT_SECRET: "secret_live_devenv_e2e",
    });

    const res = await http.get("/v1/dev/environment").expect(200);

    expect(res.body).toEqual({ kycProvider: "digilocker", vendorEnvironment: "live" });
  });

  test("DigiLocker on a test key is reported as test", async () => {
    const http = await start({
      KYC_PROVIDER: "digilocker",
      KYC_VENDOR_CLIENT_ID: "key_test_devenv_e2e",
      KYC_VENDOR_CLIENT_SECRET: "secret_test_devenv_e2e",
    });

    const res = await http.get("/v1/dev/environment").expect(200);

    expect(res.body).toEqual({ kycProvider: "digilocker", vendorEnvironment: "test" });
  });
});
