import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignedUrlFileStore } from "@kilowattx/integrations";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";

/**
 * The development object store, over HTTP.
 *
 * These two routes stand in for a managed bucket, and they are the only routes in
 * the API with no session: the signature in the URL *is* the authorisation.
 * That is what makes them worth a test of their own — a mistake here is not a
 * broken feature, it is an open bucket of other people's property deeds.
 */

const FILE_SECRET = "filesign_files_e2e_testing_000";
const BYTES = Buffer.from("%PDF-1.7\nland record\n");

let app: NestExpressApplication;
let root: string;
let store: SignedUrlFileStore;

const KEY = "kyc-docs/usr_e2e/JAMABANDI/deed.pdf";

function http() {
  return request(app.getHttpServer());
}

/** Everything after the path, so supertest can be handed a relative URL. */
function queryOf(url: string): string {
  return `/v1/files${new URL(url).search}`;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "kwx-files-e2e-"));

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test",
    KYC_PROVIDER: "fake",
    KYC_WEBHOOK_SECRET: "whsec_files_e2e_testing00",
    KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 23).toString("base64"),
    FILE_SIGNING_SECRET: FILE_SECRET,
    FILE_BUCKET_ROOT: root,
  } as NodeJS.ProcessEnv);

  app = await createApp({ config });
  await app.init();

  store = new SignedUrlFileStore({
    secret: FILE_SECRET,
    baseUrl: "http://localhost:4000/v1/files",
  });
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

async function uploadUrlFor(key = KEY, contentType = "application/pdf") {
  return store.createUploadUrl({
    key,
    contentType,
    maxBytes: BYTES.length,
    expiresInSeconds: 300,
  });
}

/* ------------------------------------------------------------------ */

describe("uploading with a signed URL", () => {
  test("a correctly signed PUT is accepted and the bytes come back", async () => {
    const upload = await uploadUrlFor();

    await http()
      .put(queryOf(upload.url))
      .set("content-type", "application/pdf")
      .send(BYTES)
      .expect(200);

    const download = await store.createDownloadUrl({ key: KEY });

    const response = await http().get(queryOf(download.url)).expect(200);
    expect(Buffer.from(response.body).equals(BYTES)).toBe(true);
    expect(response.headers["content-type"]).toContain("application/pdf");
  });

  test("an unsigned PUT is refused", async () => {
    await http()
      .put(`/v1/files?key=${encodeURIComponent(KEY)}&exp=99999999999`)
      .set("content-type", "application/pdf")
      .send(BYTES)
      .expect(403);
  });

  test("a PUT with a tampered key is refused", async () => {
    const upload = await uploadUrlFor();
    const tampered = new URL(upload.url);
    tampered.searchParams.set("key", "kyc-docs/somebody_else/JAMABANDI/deed.pdf");

    await http()
      .put(queryOf(tampered.toString()))
      .set("content-type", "application/pdf")
      .send(BYTES)
      .expect(403);
  });

  /**
   * The size limit is signed, so the bucket enforces it rather than trusting
   * the browser to respect what it was told.
   */
  test("a body larger than the signed limit is refused", async () => {
    const upload = await uploadUrlFor();

    await http()
      .put(queryOf(upload.url))
      .set("content-type", "application/pdf")
      .send(Buffer.alloc(BYTES.length + 1, 0x41))
      .expect(413);
  });

  /**
   * Likewise the content type. A URL signed for a PDF must not accept an
   * executable, or "PDFs only" is advice rather than a rule.
   */
  test("a body whose content type is not the signed one is refused", async () => {
    const upload = await uploadUrlFor();

    await http()
      .put(queryOf(upload.url))
      .set("content-type", "application/x-msdownload")
      .send(BYTES)
      .expect(415);
  });

  /** An upload URL is not a download URL: the method is part of the payload. */
  test("an upload URL cannot be used to read", async () => {
    const upload = await uploadUrlFor();
    await http().get(queryOf(upload.url)).expect(403);
  });
});

/* ------------------------------------------------------------------ */

describe("downloading with a signed URL", () => {
  test("an expired URL is refused, and says so", async () => {
    const past = new SignedUrlFileStore({
      secret: FILE_SECRET,
      baseUrl: "http://localhost:4000/v1/files",
      clock: () => new Date(Date.now() - 600_000),
    });

    const download = await past.createDownloadUrl({ key: KEY, expiresInSeconds: 60 });

    const response = await http().get(queryOf(download.url)).expect(403);
    expect(response.body.code).toBe("URL_EXPIRED");
  });

  test("a URL signed with a different secret is refused", async () => {
    const impostor = new SignedUrlFileStore({
      secret: "a-completely-different-secret-1",
      baseUrl: "http://localhost:4000/v1/files",
    });
    const download = await impostor.createDownloadUrl({ key: KEY });

    await http().get(queryOf(download.url)).expect(403);
  });

  /**
   * A valid signature for an object that was never uploaded. 404 is right:
   * the URL is genuine, there is simply nothing there — and conflating it with
   * a signature failure would send somebody debugging the wrong thing.
   */
  test("a valid URL for a missing object is a 404", async () => {
    const download = await store.createDownloadUrl({
      key: "kyc-docs/usr_e2e/JAMABANDI/never-uploaded.pdf",
    });

    await http().get(queryOf(download.url)).expect(404);
  });
});
