import type { DatabaseHandle } from "@kilowattx/db";
import { Controller, Get, Header, Inject, Logger } from "@nestjs/common";
import { ApiError } from "../common/errors.js";

/**
 * Liveness and readiness, for whatever is watching this process.
 *
 * Two routes rather than one, because they answer two questions whose correct
 * responses to failure are different:
 *
 *   /healthz  is this process alive?       -> restart it if not
 *   /readyz   should it receive traffic?   -> take it out of rotation if not
 *
 * Conflating them makes an outage worse rather than better. A single endpoint
 * that checks the database, wired to a liveness probe, means a database blip
 * fails every container at once, the orchestrator restarts all of them, and
 * the restarts do nothing whatsoever for a database that is down — while also
 * killing the containers that were still serving the requests which never
 * touch it. The outage you had becomes a crash loop.
 *
 * Unversioned on purpose. A probe is infrastructure configuration, not an API
 * client, and should not need reconfiguring the day /v2 appears.
 *
 * NO SESSION GUARD, like the files routes — a load balancer has no session.
 * Unlike the files routes there is nothing here to authorise, so the
 * discipline is the other one: an unauthenticated endpoint must give nothing
 * away. No version, no commit, no hostname, no database error text, and in
 * particular not which KYC provider is configured, since `fake` would tell an
 * anonymous caller that the verification behind this deployment is simulated.
 * Why a check failed goes to the logs, which are already behind access
 * control.
 */

/** Bound on the readiness query. See databaseReachable(). */
const DB_CHECK_TIMEOUT_MS = 2_000;

@Controller()
export class HealthController {
  private readonly logger = new Logger("Health");

  constructor(
    /**
     * The raw handle, for one `select 1`.
     *
     * A string token because that is how app.module already registers it.
     * Deliberately not through `withContext`: there is no user, no RLS context
     * is needed, and wrapping a probe in a transaction only adds another thing
     * that can hang.
     */
    @Inject("DATABASE_HANDLE") private readonly handle: DatabaseHandle,
  ) {}

  /**
   * Alive. Answers from the process itself and checks nothing else.
   *
   * If this route returns at all, the event loop is turning and the HTTP
   * server is accepting connections — which is the whole of what a liveness
   * probe asks. Everything it could additionally check is something a restart
   * cannot fix.
   */
  @Get("healthz")
  @Header("Cache-Control", "no-store")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /**
   * Ready to serve. Checks the database, and only the database.
   *
   * Nearly every route needs Postgres, so a process that cannot reach it has
   * nothing useful to do with a request and belongs out of rotation until it
   * can.
   *
   * The KYC vendor is deliberately NOT checked. Most endpoints never call it,
   * and pulling every container from rotation because a third party is down is
   * an outage inflicted on ourselves on top of theirs. An unreachable vendor
   * is what the reconciliation job and its heartbeat are for.
   *
   * 503 rather than 500: "ask me again shortly" is both true and the signal a
   * load balancer acts on, where a 500 reads as a bug in the handler.
   */
  @Get("readyz")
  @Header("Cache-Control", "no-store")
  async ready(): Promise<{ status: "ok"; database: true }> {
    if (!(await this.databaseReachable())) {
      throw ApiError.serviceUnavailable(
        "NOT_READY",
        "This instance is not currently able to serve requests.",
      );
    }

    return { status: "ok", database: true };
  }

  /**
   * `select 1`, bounded.
   *
   * The bound is the point. A query on a connection that is wedged rather than
   * closed can hang indefinitely, and a probe that hangs is worse than one
   * that fails: the orchestrator learns nothing until its own timeout fires,
   * and meanwhile this handler holds a connection from the pool real traffic
   * needs.
   *
   * Racing leaves the losing query running — postgres-js offers no reliable
   * cancellation — so it is given a catch of its own. Without that, a query
   * rejecting after the timeout has already won is an unhandled rejection,
   * which under Node's default settings terminates the process: a readiness
   * check that kills the server it reports on.
   */
  private async databaseReachable(): Promise<boolean> {
    const query = this.handle.sql`select 1`;
    const settled = query.then(
      () => "ok" as const,
      (error: unknown) => {
        this.logger.error(
          `Readiness: the database is unreachable. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return "failed" as const;
      },
    );

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), DB_CHECK_TIMEOUT_MS);
    });

    try {
      const outcome = await Promise.race([settled, timeout]);

      if (outcome === "timeout") {
        this.logger.error(
          `Readiness: the database did not answer within ${DB_CHECK_TIMEOUT_MS}ms.`,
        );
      }

      return outcome === "ok";
    } finally {
      /** Or each probe keeps the event loop alive for a further two seconds. */
      if (timer) clearTimeout(timer);
    }
  }
}
