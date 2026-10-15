import { createClient, type DatabaseHandle } from "@kilowattx/db";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";

/**
 * Liveness and readiness.
 *
 * The half worth testing is the failure half. A readiness check that reports
 * healthy whatever happens is indistinguishable from no readiness check at
 * all, right up to the point where it matters — the same reason the fake virus
 * scanner refuses to run in production. So the unreachable-database case is
 * driven here for real, against a closed pool, rather than asserted by
 * inspection.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";

function configFor(databaseUrl: string) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    KYC_PROVIDER: "fake",
    KYC_WEBHOOK_SECRET: "whsec_health_e2e_testing0",
    KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 29).toString("base64"),
    FILE_SIGNING_SECRET: "filesign_health_e2e_testing_00",
  } as NodeJS.ProcessEnv);
}

let app: NestExpressApplication;

function http() {
  return request(app.getHttpServer());
}

beforeAll(async () => {
  app = await createApp({ config: configFor(DB_URL) });
  await app.init();
});

afterAll(async () => {
  await app.close();
});

/* ------------------------------------------------------------------ */

describe("liveness", () => {
  test("answers without a session", async () => {
    const response = await http().get("/healthz").expect(200);
    expect(response.body.status).toBe("ok");
  });

  /**
   * Unversioned, because a probe is infrastructure configuration rather than
   * an API client and should not have to change when the API version does.
   */
  test("is not under the /v1 prefix", async () => {
    await http().get("/v1/healthz").expect(404);
  });

  test("is never cached", async () => {
    const response = await http().get("/healthz").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  /**
   * The whole reason this route is separate from /readyz. If liveness checked
   * the database, a database outage would fail every container's liveness
   * probe and the orchestrator would restart all of them — which does nothing
   * for a database that is down, and kills the containers still serving the
   * requests that never touch it.
   *
   * Asserted by pointing an app at a database that cannot be reached and
   * showing that liveness is still 200.
   */
  test("stays alive when the database is unreachable", async () => {
    const dead = await createApp({
      config: configFor(
        "postgresql://kilowattx_app:local_dev_only@127.0.0.1:1/kilowattx_api_test",
      ),
    });
    await dead.init();

    try {
      await request(dead.getHttpServer()).get("/healthz").expect(200);
    } finally {
      await dead.close();
    }
  });
});

/* ------------------------------------------------------------------ */

describe("readiness", () => {
  test("reports ready when the database answers", async () => {
    const response = await http().get("/readyz").expect(200);
    expect(response.body).toEqual({ status: "ok", database: true });
  });

  test("is never cached", async () => {
    const response = await http().get("/readyz").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  /**
   * 503, not 500. A load balancer takes an instance out of rotation on the
   * former and raises an incident on the latter, and this is the first of
   * those: the handler is fine, its dependency is not.
   */
  test("reports 503 when the database cannot be reached", async () => {
    const dead = await createApp({
      config: configFor(
        "postgresql://kilowattx_app:local_dev_only@127.0.0.1:1/kilowattx_api_test",
      ),
    });
    await dead.init();

    try {
      const response = await request(dead.getHttpServer())
        .get("/readyz")
        .expect(503);
      expect(response.body.code).toBe("NOT_READY");
    } finally {
      await dead.close();
    }
  });

  /**
   * And it must not describe the failure.
   *
   * These routes have no session guard, so the body reaches anybody who can
   * reach the port. A driver error here would name the host, the port, the
   * database and the role it tried to connect as.
   */
  test("a failure gives nothing away", async () => {
    const dead = await createApp({
      config: configFor(
        "postgresql://kilowattx_app:local_dev_only@127.0.0.1:1/kilowattx_api_test",
      ),
    });
    await dead.init();

    try {
      const response = await request(dead.getHttpServer())
        .get("/readyz")
        .expect(503);

      const body = JSON.stringify(response.body);
      for (const leak of [
        "127.0.0.1",
        "kilowattx_app",
        "local_dev_only",
        "ECONNREFUSED",
        "postgres",
      ]) {
        expect(body).not.toContain(leak);
      }
    } finally {
      await dead.close();
    }
  });

  /**
   * Neither route may disclose which vendor is configured. `fake` would tell
   * an anonymous caller that the verification behind this deployment is
   * simulated, which is exactly the thing somebody probing for a way in wants
   * to know.
   */
  test("neither route names the KYC provider", async () => {
    for (const path of ["/healthz", "/readyz"]) {
      const response = await http().get(path).expect(200);
      const body = JSON.stringify(response.body).toLowerCase();
      expect(body).not.toContain("fake");
      expect(body).not.toContain("cashfree");
      expect(body).not.toContain("provider");
    }
  });
});

/* ------------------------------------------------------------------ */

describe("the pool is not exhausted by probing", () => {
  /**
   * A probe runs every few seconds for the life of the deployment, so a
   * connection or a timer leaked per call is a slow failure that only shows up
   * under the load it was meant to report on. Twenty in a row, then an
   * ordinary request, is enough to catch a handler that holds on to either.
   */
  test("many probes in a row leave the API working", async () => {
    for (let i = 0; i < 20; i++) {
      await http().get("/readyz").expect(200);
    }

    await http().get("/healthz").expect(200);
    await http().get("/v1/dev/users").expect(200);
  });
});

/* ------------------------------------------------------------------ */

describe("shutdown", () => {
  /**
   * Writing the readiness probe turned this up: `enableShutdownHooks()` was on,
   * but the database handle is a plain `useValue` provider, so nothing had a
   * hook and the pool was left open until the process exited.
   *
   * It is asserted here rather than in a unit test because the thing being
   * checked is that Nest actually calls the hook in a real application
   * lifecycle — which is the part that was missing, not the closing itself.
   */
  test("closing the app drains the connection pool", async () => {
    const own = await createApp({ config: configFor(DB_URL) });
    await own.init();

    const handle = own.get<DatabaseHandle>("DATABASE_HANDLE");
    await request(own.getHttpServer()).get("/readyz").expect(200);

    await own.close();

    /** postgres-js refuses queries once the pool has been ended. */
    await expect(handle.sql`select 1`).rejects.toThrow();
  });
});
