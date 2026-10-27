import { createClient, type DatabaseHandle } from "@kilowattx/db";
import type {
  FaceComparison,
  FaceMatcher,
  KycProvider,
  LocalDiskBucket,
  VendorKycResult,
} from "@kilowattx/integrations";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { DI, loadConfig } from "../config.js";
import { DEV_USER_HEADER } from "../common/session.js";

/**
 * The selfie is compared with the Aadhaar photograph.
 *
 * Somebody completed the flow with a stranger's face in front of the camera,
 * and the case was waved on — because nothing compared the two images at all.
 * These tests pin down what happens now: a clear mismatch is refused with a
 * reason while the person is still on the camera screen, a refused selfie
 * does not count as the selfie on file, and a good match is what the decision
 * is made on.
 *
 * The matcher is a stub keyed on the selfie's bytes. The real one needs 38 MB
 * of models that are fetched per machine; what is under test here is
 * everything around it.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

/** What the stub answers, chosen by a word in the uploaded bytes. */
const ANSWERS: Record<string, FaceComparison> = {
  SAME: { kind: "COMPARED", score: 0.93, cosine: 0.6 },
  STRANGER: { kind: "COMPARED", score: 0.2, cosine: 0.1 },
  OLDPHOTO: { kind: "COMPARED", score: 0.7, cosine: 0.34 },
  NOFACE: { kind: "NO_FACE_IN_SELFIE" },
  TWOFACES: { kind: "SEVERAL_FACES_IN_SELFIE" },
};

const stubMatcher: FaceMatcher = {
  async compare(selfie) {
    const text = Buffer.from(selfie).toString("latin1");
    const word = Object.keys(ANSWERS).find((w) => text.includes(w));
    return ANSWERS[word ?? "SAME"]!;
  },
};

/**
 * A hosted gateway whose result is Aadhaar alone, as DigiLocker's is.
 *
 * The fake gateway's hosted result carries a PAN and a selfie as well, which
 * is exactly the shape that hid the bug: collecting it left nothing
 * outstanding, so deciding on the spot looked right.
 */
const hostedAadhaarOnly: KycProvider = {
  name: "digilocker",
  webhookScheme: "hmac-body",
  aadhaarRoute: "HOSTED",
  async createSession() {
    throw new Error("not used");
  },
  async sendAadhaarOtp() {
    throw new Error("not used");
  },
  async verifyAadhaarOtp() {
    throw new Error("not used");
  },
  async fetchResult(vendorSessionId): Promise<VendorKycResult> {
    return {
      vendorSessionId,
      vendor: "digilocker",
      vendorVersion: "test",
      eventId: `evt_${vendorSessionId}`,
      aadhaar: {
        status: "SUCCESS",
        nameOnRecord: "Anita Desai",
        dateOfBirth: "1986-04-17",
        last4: "1234",
        refToken: vendorSessionId,
        /** A JPEG header is enough: the stub matcher never decodes it. */
        photo: Buffer.from("\xff\xd8\xff aadhaar photo", "latin1").toString("base64"),
      },
      rawResponseKey: `kyc-docs/raw/${vendorSessionId}.json`,
      completedAt: new Date(),
    };
  },
};

let app: NestExpressApplication;
let owner: DatabaseHandle;

const http = () => request(app.getHttpServer());
const as = (userId: string) => ({ [DEV_USER_HEADER]: userId });

beforeAll(async () => {
  owner = createClient({ url: OWNER_URL, maxConnections: 4 });
  app = await createApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: DB_URL,
      KYC_PROVIDER: "fake",
      KYC_WEBHOOK_SECRET: "whsec_selfie_match_e2e_000",
      KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 61).toString("base64"),
      FILE_SIGNING_SECRET: "filesign_selfie_match_e2e_00",
    } as NodeJS.ProcessEnv),
    kycProvider: hostedAadhaarOnly,
    faceMatcher: stubMatcher,
  });
  await app.init();
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

/* ------------------------------------------------------------------ */

async function consentedUser(): Promise<string> {
  const phone = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const user = await http().post("/v1/dev/users").send({ phoneE164: phone, locale: "en" });
  const userId = user.body.id as string;
  await http()
    .post("/v1/kyc/consents")
    .set(as(userId))
    .send({ purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" })
    .expect(201);
  return userId;
}

/** Somebody who has just come back from DigiLocker, through the real collect. */
async function backFromDigiLocker(): Promise<string> {
  const userId = await consentedUser();
  const session = `dl_${Math.random().toString(36).slice(2, 12)}`;

  await owner.sql.unsafe(
    `INSERT INTO kyc_records (user_id, subject_type, level, status, vendor, vendor_session_id)
     VALUES ('${userId}', 'PERSON', 'FULL', 'IN_PROGRESS', 'digilocker', '${session}')`,
  );

  await http().post("/v1/kyc/sessions/collect").set(as(userId)).expect(201);
  return userId;
}

/** The real upload pipeline; `word` steers the stub matcher. */
async function selfie(userId: string, word: string, expected: number) {
  const target = await http()
    .post("/v1/documents/upload-url")
    .set(as(userId))
    .send({ docType: "SELFIE", fileName: "selfie.jpg", contentType: "image/jpeg", sizeBytes: 2048 })
    .expect(201);

  await http()
    .put(`/v1/files${new URL(target.body.url).search}`)
    .set("content-type", "image/jpeg")
    .send(Buffer.from(`\xff\xd8\xff ${word}`, "latin1"))
    .expect(200);

  return http()
    .post("/v1/documents/confirm")
    .set(as(userId))
    .send({ storageKey: target.body.key, sha256: "f".repeat(64) })
    .expect(expected);
}

function somePan(): string {
  return `ABCPS${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}K`;
}

/* ------------------------------------------------------------------ */

describe("coming back from DigiLocker", () => {
  /**
   * The bug underneath this one: the Aadhaar alone was decided, so every
   * DigiLocker verification landed in MANUAL_REVIEW with PAN_MISSING and
   * SELFIE_MISSING before the person had been asked for either.
   */
  test("is one step done, not a decision made", async () => {
    const userId = await backFromDigiLocker();

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.status).toBe("IN_PROGRESS");
    expect(me.body.remainingSteps).toEqual(["PAN", "SELFIE"]);
    expect(me.body.aadhaarLast4).toBe("1234");
  });

  test("keeps the Aadhaar photograph, as a key into the bucket", async () => {
    const userId = await backFromDigiLocker();

    const rows = await owner.sql.unsafe(
      `SELECT aadhaar_photo_key FROM kyc_records WHERE user_id = '${userId}'`,
    );
    const key = (rows[0] as unknown as { aadhaar_photo_key: string | null }).aadhaar_photo_key;

    expect(key).toMatch(new RegExp(`^kyc-docs/${userId}/AADHAAR_PHOTO/.+\\.jpg$`));
    const stored = await app.get<LocalDiskBucket>(DI.FILE_BUCKET).get(key!);
    expect(stored?.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

describe("the selfie against the Aadhaar photograph", () => {
  test("a stranger's face is refused, with tries left", async () => {
    const userId = await backFromDigiLocker();

    const response = await selfie(userId, "STRANGER", 400);
    expect(response.body.code).toBe("FACE_MISMATCH");
    expect(response.body.message).toMatch(/does not match the photo on your Aadhaar/);
    expect(response.body.details).toEqual({ attemptsLeft: 2 });
  });

  /** Otherwise the refused stranger would satisfy the step on its own. */
  test("a refused selfie does not count as the selfie on file", async () => {
    const userId = await backFromDigiLocker();
    await selfie(userId, "STRANGER", 400);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.remainingSteps).toContain("SELFIE");
  });

  test("no face, or two, is refused with a reason the person can act on", async () => {
    const userId = await backFromDigiLocker();

    expect((await selfie(userId, "NOFACE", 400)).body.code).toBe("SELFIE_NO_FACE");
    expect((await selfie(userId, "TWOFACES", 400)).body.code).toBe("SELFIE_SEVERAL_FACES");
  });

  /**
   * Refusing for ever would lock a genuine person out behind a bad Aadhaar
   * photograph, so the third clear mismatch is kept — and reviewed.
   */
  test("the third clear mismatch is kept and goes to a person", async () => {
    const userId = await backFromDigiLocker();

    expect((await selfie(userId, "STRANGER", 400)).body.details).toEqual({ attemptsLeft: 2 });
    expect((await selfie(userId, "STRANGER", 400)).body.details).toEqual({ attemptsLeft: 1 });
    const third = await selfie(userId, "STRANGER", 201);
    expect(third.body.faceCheck).toBe("REVIEW");

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.status).toBe("MANUAL_REVIEW");
    expect(me.body.reasonCodes).toContain("FACE_MATCH_LOW");
  });

  test("a matching face, then a PAN, verifies — flagged that liveness was not checked", async () => {
    const userId = await backFromDigiLocker();

    const accepted = await selfie(userId, "SAME", 201);
    expect(accepted.body.faceCheck).toBe("MATCHED");

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.status).toBe("VERIFIED");
    expect(me.body.reasonCodes).toContain("LIVENESS_NOT_CHECKED");

    const checks = await owner.sql.unsafe(
      `SELECT c.check_type, c.status, c.score FROM kyc_checks c
         JOIN kyc_records r ON r.id = c.kyc_record_id
        WHERE r.user_id = '${userId}' AND c.check_type = 'FACE_MATCH'`,
    );
    expect(checks).toHaveLength(1);
    expect((checks[0] as unknown as { status: string }).status).toBe("PASSED");
  });

  /** The band an old Aadhaar photograph lands in: not refused, not passed. */
  test("a weak match is accepted but reviewed", async () => {
    const userId = await backFromDigiLocker();

    const accepted = await selfie(userId, "OLDPHOTO", 201);
    expect(accepted.body.faceCheck).toBe("REVIEW");

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.status).toBe("MANUAL_REVIEW");
    expect(me.body.reasonCodes).toContain("FACE_MATCH_LOW");
  });

  /** A retake after a refusal is what the decision is made on. */
  test("the stranger is refused, the real face is then accepted", async () => {
    const userId = await backFromDigiLocker();

    await selfie(userId, "STRANGER", 400);
    await selfie(userId, "SAME", 201);
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.status).toBe("VERIFIED");
  });
});
