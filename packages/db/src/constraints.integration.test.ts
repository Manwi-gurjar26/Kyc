import { panBlindIndex } from "@kilowattx/core";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DatabaseHandle } from "./client.js";
import {
  asRole,
  assertRlsIsEnforceable,
  assertTestDatabase,
  countOf,
  createTestUser,
  openOwnerDatabase,
  openTestDatabase,
  resetTables,
} from "./testing/harness.js";

/**
 * Integration tests against a real Postgres.
 *
 * Every guarantee asserted here lives in the database and nowhere else: a
 * unique index, an RLS policy, a BEFORE UPDATE trigger, transaction
 * atomicity, two sessions racing. None of it can be tested against a fake,
 * because a fake would only prove the fake works.
 */

const KEY = Buffer.alloc(32, 7);

let handle: DatabaseHandle;
let owner: DatabaseHandle;

beforeAll(async () => {
  handle = openTestDatabase();
  owner = openOwnerDatabase();
  // Fails loudly if the app role was ever granted superuser or BYPASSRLS,
  // rather than letting every RLS assertion below silently become a no-op.
  await assertRlsIsEnforceable(owner);
});

afterAll(async () => {
  await handle.close();
  await owner.close();
});

beforeEach(async () => {
  await resetTables(owner);
});

/* ------------------------------------------------------------------ */

describe("the test harness refuses to run anywhere dangerous", () => {
  test("accepts a database whose name contains 'test'", () => {
    expect(() =>
      assertTestDatabase("postgresql://u:p@localhost:5434/kilowattx_test"),
    ).not.toThrow();
  });

  test("refuses a database that is not obviously a test database", () => {
    expect(() =>
      assertTestDatabase("postgresql://u:p@localhost:5433/kilowattx"),
    ).toThrow(/must contain "test"/);
  });

  test("refuses a remote host even if the name says test", () => {
    expect(() =>
      assertTestDatabase("postgresql://u:p@db.kilowattx.internal:5432/kyc_test"),
    ).toThrow(/only a database on this machine/);
  });

  /**
   * The allowlist is the point. A blocklist would have to name every managed
   * Postgres host in existence, and the one it failed to name is the one that
   * gets truncated.
   */
  test("accepts the hosts a local setup actually uses", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]) {
      expect(() =>
        assertTestDatabase(`postgresql://u:p@${host}:5434/kilowattx_test`),
      ).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ */

/**
 * The duplicate-PAN rule. This single unique index is the whole free-trial
 * abuse defence, and it has to work on the blind index — not the PAN, which
 * is encrypted and so differs byte-for-byte every time it is stored.
 */
describe("duplicate PAN is caught by the database, not by a query", () => {
  async function insertKycRecord(userId: string, pan: string): Promise<void> {
    const index = panBlindIndex(pan, KEY);
    await owner.sql`
      INSERT INTO kyc_records (subject_type, user_id, level, status, pan_blind_index, pan_last4)
      VALUES ('PERSON', ${userId}, 'FULL', 'IN_PROGRESS', ${index}, ${pan.slice(-4)})
    `;
  }

  test("the same PAN on a second account is rejected", async () => {
    const alice = await createTestUser(owner, "+919800000001", "Alice");
    const bob = await createTestUser(owner, "+919800000002", "Bob");

    await insertKycRecord(alice, "ABCPS4412K");
    await expect(insertKycRecord(bob, "ABCPS4412K")).rejects.toThrow(
      /kyc_records_pan_blind_index_unique/,
    );
  });

  /**
   * The reason the index is computed over the NORMALISED PAN. Two people
   * typing the same PAN with different spacing must still collide, or the
   * rule is trivially bypassed.
   */
  test("a differently formatted version of the same PAN still collides", async () => {
    const alice = await createTestUser(owner, "+919800000001", "Alice");
    const bob = await createTestUser(owner, "+919800000002", "Bob");

    await insertKycRecord(alice, "ABCPS4412K");
    await expect(insertKycRecord(bob, "abcps 4412 k")).rejects.toThrow(
      /pan_blind_index_unique/,
    );
  });

  test("different PANs coexist", async () => {
    const alice = await createTestUser(owner, "+919800000001", "Alice");
    const bob = await createTestUser(owner, "+919800000002", "Bob");

    await insertKycRecord(alice, "ABCPS4412K");
    await insertKycRecord(bob, "AMJPN3301R");
    expect(await countOf(owner, "kyc_records")).toBe(2);
  });

  /**
   * A PAN-only trial record has no PAN yet at the moment it is created, and
   * several such records must be able to exist. Postgres treats NULLs as
   * distinct in a unique index, which is what makes this work — worth a test,
   * because it is the behaviour people most often get wrong.
   */
  test("several records with no PAN yet coexist", async () => {
    const alice = await createTestUser(owner, "+919800000001", "Alice");
    const bob = await createTestUser(owner, "+919800000002", "Bob");

    await owner.sql`
      INSERT INTO kyc_records (subject_type, user_id, level, status)
      VALUES ('PERSON', ${alice}, 'PAN_ONLY', 'IN_PROGRESS'),
             ('PERSON', ${bob}, 'PAN_ONLY', 'IN_PROGRESS')
    `;
    expect(await countOf(owner, "kyc_records")).toBe(2);
  });
});

/* ------------------------------------------------------------------ */

describe("append-only tables cannot be rewritten", () => {
  async function seedCheck(): Promise<string> {
    const userId = await createTestUser(owner, "+919800000010");
    const records = await owner.sql<{ id: string }[]>`
      INSERT INTO kyc_records (subject_type, user_id, level, status)
      VALUES ('PERSON', ${userId}, 'FULL', 'IN_PROGRESS') RETURNING id
    `;
    const checks = await owner.sql<{ id: string }[]>`
      INSERT INTO kyc_checks (kyc_record_id, check_type, status, score, detail)
      VALUES (${records[0]!.id}, 'FACE_MATCH', 'FAILED', 0.68, 'below threshold')
      RETURNING id
    `;
    return checks[0]!.id;
  }

  /**
   * A failed check followed by a passing one must leave both rows. Editing
   * the failure away would erase exactly the pattern a fraud review looks
   * for.
   */
  test("a kyc_check cannot be updated", async () => {
    const id = await seedCheck();
    await expect(
      owner.sql`UPDATE kyc_checks SET status = 'PASSED' WHERE id = ${id}`,
    ).rejects.toThrow(/append-only/);
  });

  test("a kyc_check cannot be deleted", async () => {
    const id = await seedCheck();
    await expect(
      owner.sql`DELETE FROM kyc_checks WHERE id = ${id}`,
    ).rejects.toThrow(/append-only/);
  });

  test("a correcting check can be added alongside the failed one", async () => {
    const id = await seedCheck();
    const [existing] = await owner.sql<{ kyc_record_id: string }[]>`
      SELECT kyc_record_id FROM kyc_checks WHERE id = ${id}
    `;
    await owner.sql`
      INSERT INTO kyc_checks (kyc_record_id, check_type, status, score, attempt_number, detail)
      VALUES (${existing!.kyc_record_id}, 'FACE_MATCH', 'PASSED', 0.84, 2, 'retried in better light')
    `;
    expect(await countOf(owner, "kyc_checks")).toBe(2);
  });

  test("an audit_log row cannot be updated", async () => {
    const rows = await owner.sql<{ id: string }[]>`
      INSERT INTO audit_log (actor_type, action, resource_type)
      VALUES ('SYSTEM', 'kyc.decided', 'kyc_record') RETURNING id
    `;
    await expect(
      owner.sql`UPDATE audit_log SET action = 'nothing.happened' WHERE id = ${rows[0]!.id}`,
    ).rejects.toThrow(/append-only/);
  });

  test("an audit_log row cannot be deleted", async () => {
    const rows = await owner.sql<{ id: string }[]>`
      INSERT INTO audit_log (actor_type, action, resource_type)
      VALUES ('SYSTEM', 'kyc.decided', 'kyc_record') RETURNING id
    `;
    await expect(
      owner.sql`DELETE FROM audit_log WHERE id = ${rows[0]!.id}`,
    ).rejects.toThrow(/append-only/);
  });
});

/* ------------------------------------------------------------------ */

describe("consent can be withdrawn but never rewritten", () => {
  async function seedConsent(): Promise<{ id: string; userId: string }> {
    const userId = await createTestUser(owner, "+919800000020");
    const rows = await owner.sql<{ id: string }[]>`
      INSERT INTO consent_records (user_id, purpose, notice_version, locale)
      VALUES (${userId}, 'KYC_VERIFICATION', '2.1', 'en') RETURNING id
    `;
    return { id: rows[0]!.id, userId };
  }

  test("withdrawal can be recorded", async () => {
    const { id } = await seedConsent();
    await owner.sql`UPDATE consent_records SET withdrawn_at = now() WHERE id = ${id}`;

    const rows = await owner.sql<{ withdrawn_at: string | null }[]>`
      SELECT withdrawn_at FROM consent_records WHERE id = ${id}
    `;
    expect(rows[0]!.withdrawn_at).not.toBeNull();
  });

  /** What someone consented to, and which notice they saw, is fixed forever. */
  test("the purpose cannot be changed", async () => {
    const { id } = await seedConsent();
    await expect(
      owner.sql`UPDATE consent_records SET purpose = 'AGREEMENT_ESIGN' WHERE id = ${id}`,
    ).rejects.toThrow(/only withdrawn_at may be updated/);
  });

  test("the notice version cannot be changed", async () => {
    const { id } = await seedConsent();
    await expect(
      owner.sql`UPDATE consent_records SET notice_version = '9.9' WHERE id = ${id}`,
    ).rejects.toThrow(/only withdrawn_at may be updated/);
  });

  test("consent cannot be deleted", async () => {
    const { id } = await seedConsent();
    await expect(
      owner.sql`DELETE FROM consent_records WHERE id = ${id}`,
    ).rejects.toThrow(/append-only/);
  });

  test("a recorded withdrawal cannot be rewritten", async () => {
    const { id } = await seedConsent();
    await owner.sql`UPDATE consent_records SET withdrawn_at = now() WHERE id = ${id}`;
    await expect(
      owner.sql`UPDATE consent_records SET withdrawn_at = NULL WHERE id = ${id}`,
    ).rejects.toThrow(/cannot be rewritten/);
  });
});

/* ------------------------------------------------------------------ */

/**
 * Row Level Security.
 *
 * These tests exist mainly to prove FORCE ROW LEVEL SECURITY is doing its
 * job: without it, the policies are silently inert for the role that owns the
 * tables, which is the role the application normally connects as. The
 * policies would look present, pass review, and protect nothing.
 */
describe("row level security confines a customer to their own rows", () => {
  async function seedTwoCustomers() {
    const alice = await createTestUser(owner, "+919800000031", "Alice");
    const bob = await createTestUser(owner, "+919800000032", "Bob");

    await owner.sql`
      INSERT INTO kyc_records (subject_type, user_id, level, status)
      VALUES ('PERSON', ${alice}, 'FULL', 'VERIFIED'),
             ('PERSON', ${bob}, 'FULL', 'VERIFIED')
    `;
    return { alice, bob };
  }

  test("a customer sees exactly one kyc_record: their own", async () => {
    const { alice } = await seedTwoCustomers();

    const rows = await asRole(handle, "customer", alice, (tx) =>
      tx<{ user_id: string }[]>`SELECT user_id FROM kyc_records`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(alice);
  });

  test("a customer cannot see another customer's record even by id", async () => {
    const { alice, bob } = await seedTwoCustomers();

    const rows = await asRole(handle, "customer", alice, (tx) =>
      tx`SELECT id FROM kyc_records WHERE user_id = ${bob}`,
    );
    expect(rows).toHaveLength(0);
  });

  test("staff see every record", async () => {
    await seedTwoCustomers();

    const rows = await asRole(handle, "staff", null, (tx) =>
      tx`SELECT id FROM kyc_records`,
    );
    expect(rows).toHaveLength(2);
  });

  /**
   * A customer has no write path to their own KYC status at all. The only
   * things that set it are decideKyc() under the system role and a reviewer
   * under the staff role.
   */
  test("a customer cannot promote their own KYC status", async () => {
    const { alice } = await seedTwoCustomers();

    const updated = await asRole(handle, "customer", alice, (tx) =>
      tx`UPDATE kyc_records SET status = 'VERIFIED' WHERE user_id = ${alice} RETURNING id`,
    );
    expect(updated).toHaveLength(0);
  });

  test("a request with no role set sees nothing", async () => {
    await seedTwoCustomers();

    const rows = await asRole(handle, "customer", null, (tx) =>
      tx`SELECT id FROM kyc_records`,
    ).catch(() => []);
    expect(rows).toHaveLength(0);
  });

  test("a customer sees only their own documents", async () => {
    const { alice, bob } = await seedTwoCustomers();
    await owner.sql`
      INSERT INTO documents (owner_user_id, doc_type, storage_key)
      VALUES (${alice}, 'SELFIE', 'kyc-docs/alice/selfie.jpg'),
             (${bob}, 'SALE_DEED', 'kyc-docs/bob/deed.pdf')
    `;

    const rows = await asRole(handle, "customer", alice, (tx) =>
      tx<{ storage_key: string }[]>`SELECT storage_key FROM documents`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.storage_key).toContain("alice");
  });

  test("a customer sees only the checks belonging to their own record", async () => {
    const { alice, bob } = await seedTwoCustomers();
    const records = await owner.sql<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM kyc_records
    `;
    for (const record of records) {
      await owner.sql`
        INSERT INTO kyc_checks (kyc_record_id, check_type, status)
        VALUES (${record.id}, 'PAN', 'PASSED')
      `;
    }
    expect(await countOf(owner, "kyc_checks")).toBe(2);

    const visible = await asRole(handle, "customer", alice, (tx) =>
      tx`SELECT id FROM kyc_checks`,
    );
    expect(visible).toHaveLength(1);
    expect(bob).toBeTruthy();
  });
});
