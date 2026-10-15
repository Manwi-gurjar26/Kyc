import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";

/**
 * Creating the session a visitor arrives with.
 *
 * This endpoint stands in for sign-in, and the shape it accepts is what the
 * verification flow depends on. It required a display name, which was a fair
 * assumption while a developer typed one into a form — and wrong the moment a
 * session is created for somebody who has just landed on the page and told us
 * nothing yet.
 *
 * The name is not ours to invent. `displayNameFor()` feeds `verifiedName` in
 * LandService, which is compared against the owner name on a jamabandi to
 * decide whether a parcel goes to a human. A placeholder written here would
 * travel all the way into that comparison and quietly corrupt it, so the
 * absence has to stay an absence until Aadhaar supplies the real one.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";

let app: NestExpressApplication;

function http() {
  return request(app.getHttpServer());
}

/** Unique per run, because phone is the unique identity on this platform. */
function phone(): string {
  return `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

beforeAll(async () => {
  app = await createApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: DB_URL,
      KYC_PROVIDER: "fake",
      KYC_WEBHOOK_SECRET: "whsec_devusers_e2e_test0",
      KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 31).toString("base64"),
      FILE_SIGNING_SECRET: "filesign_devusers_e2e_test_000",
    } as NodeJS.ProcessEnv),
  });
  await app.init();
});

afterAll(async () => {
  await app.close();
});

/* ------------------------------------------------------------------ */

describe("creating a session for somebody who has just arrived", () => {
  /**
   * The bug this file was written for. A visitor pressing Continue on the
   * first screen has given us a phone number at most, and in this build not
   * even that — so the session has to be creatable without a name.
   */
  test("a user can be created with no display name at all", async () => {
    const response = await http()
      .post("/v1/dev/users")
      .send({ phoneE164: phone(), locale: "en" })
      .expect(201);

    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  /** The web client sends an explicit null rather than omitting the key. */
  test("an explicit null is accepted the same way", async () => {
    const response = await http()
      .post("/v1/dev/users")
      .send({ phoneE164: phone(), displayName: null, locale: "en" })
      .expect(201);

    expect(response.body.id).toBeTruthy();
  });

  /**
   * And the absence is stored as an absence.
   *
   * This is the assertion that matters. If a placeholder were substituted
   * here it would become the verified name, and the land-record name match
   * would run against a string nobody ever claimed.
   */
  test("a missing name is stored as null, never as a placeholder", async () => {
    const response = await http()
      .post("/v1/dev/users")
      .send({ phoneE164: phone(), locale: "en" })
      .expect(201);

    expect(response.body.displayName).toBeNull();
  });

  test("a name that is given is still kept", async () => {
    const response = await http()
      .post("/v1/dev/users")
      .send({ phoneE164: phone(), displayName: "Ramesh Kumar Sharma", locale: "en" })
      .expect(201);

    expect(response.body.displayName).toBe("Ramesh Kumar Sharma");
  });

  /**
   * Relaxing the name must not relax the phone number, which is the unique
   * identity on this platform and the one field that genuinely is required.
   */
  test("the phone number is still required and still validated", async () => {
    await http().post("/v1/dev/users").send({ locale: "en" }).expect(400);

    await http()
      .post("/v1/dev/users")
      .send({ phoneE164: "+15551234567", locale: "en" })
      .expect(400);
  });

  /** An empty string is not a name, and must not be stored as one. */
  test("an empty or one-character name is refused rather than stored", async () => {
    await http()
      .post("/v1/dev/users")
      .send({ phoneE164: phone(), displayName: "", locale: "en" })
      .expect(400);

    await http()
      .post("/v1/dev/users")
      .send({ phoneE164: phone(), displayName: "R", locale: "en" })
      .expect(400);
  });
});
