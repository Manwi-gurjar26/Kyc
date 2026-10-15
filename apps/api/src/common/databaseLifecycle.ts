import type { DatabaseHandle } from "@kilowattx/db";
import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";

/**
 * Closes the connection pool when the process is shutting down.
 *
 * `enableShutdownHooks()` was already on, but the database handle is a plain
 * `useValue` provider, so nothing had a hook to run and the pool was simply
 * left open until the process exited. Found while writing the readiness probe,
 * which is the one piece of code whose whole job is to know what state this
 * instance is in.
 *
 * Why it matters, in order of how soon you notice:
 *
 *   * In the test suite, every e2e file left a pool of ten connections open
 *     for the life of the run. Eight files is eighty connections against a
 *     database that does not need them, which is slow and eventually hits
 *     `max_connections`.
 *
 *   * On a rolling deploy, SIGTERM ends with the sockets dropped rather than
 *     closed. The Postgres backends then sit until they time out, holding
 *     whatever the dropped transaction held — so the new container starts up
 *     competing with the old one's abandoned locks. A shutdown that does not
 *     drain the pool is not a graceful shutdown; it is an abrupt one with a
 *     delay in front of it.
 *
 * `close()` has its own five-second bound in createClient, so a connection
 * that will not close cannot hold the shutdown open indefinitely.
 */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger("Database");

  constructor(@Inject("DATABASE_HANDLE") private readonly handle: DatabaseHandle) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    try {
      await this.handle.close();
    } catch (error) {
      /**
       * Logged, never re-thrown. A pool that will not drain must not stop the
       * rest of the shutdown sequence — the process is going away regardless,
       * and an exception here would leave the remaining hooks unrun.
       */
      this.logger.error(
        `Could not close the connection pool cleanly${signal ? ` on ${signal}` : ""}. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
