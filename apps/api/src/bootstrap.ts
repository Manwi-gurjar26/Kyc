import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import express from "express";
import { AppModule, type AppModuleOptions } from "./app.module.js";
import { ApiExceptionFilter } from "./common/errors.js";

/**
 * Builds the application.
 *
 * Shared by main.ts and the e2e tests, so the tests exercise the same
 * middleware stack the server runs — including the raw-body handling, which is
 * the piece most likely to work in a test and fail in production if the two
 * are configured separately.
 */
export async function createApp(
  options: AppModuleOptions,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(options),
    { logger: options.config.NODE_ENV === "test" ? false : ["error", "warn", "log"] },
  );

  /**
   * RAW BODY, FOR WEBHOOK ROUTES ONLY.
   *
   * A webhook signature covers the exact bytes the vendor sent. Once
   * express.json() has parsed and discarded them, `JSON.stringify(req.body)`
   * is a different string — different key order, different whitespace,
   * different unicode escaping — and the signature will not verify. The
   * failure is not immediate: it passes locally against a fake that happens to
   * serialise the same way, and breaks the first time the real vendor sends
   * something slightly different.
   *
   * So the raw buffer is captured by `verify`, which runs before parsing, and
   * kept on the request. The signature is checked against that, never against
   * the parsed object.
   */
  app.use(
    "/v1/webhooks",
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  /**
   * RAW BODY, FOR THE DEVELOPMENT OBJECT STORE.
   *
   * A PUT to /v1/files carries a PDF or a photograph, not JSON. express.raw
   * is configured to accept every media type and takes the bytes exactly as
   * sent, which is what the bucket stores and what the sha256 in the
   * confirmation is computed over — any re-encoding here would make that
   * digest a digest of something else.
   *
   * The limit is the same 25 MB the upload URLs are signed for. Enforced here
   * as well as in the controller because this one rejects the body before it
   * is buffered, and the controller's check is what makes a *smaller* signed
   * limit stick.
   */
  app.use("/v1/files", express.raw({ type: "*/*", limit: "25mb" }));

  /** Everything else needs no raw body. */
  app.use(express.json({ limit: "1mb" }));

  app.useGlobalFilters(new ApiExceptionFilter());

  /**
   * Versioned from the first commit. Mobile clients stay installed for
   * months, so an old app version has to keep working against a newer API —
   * which is only possible if the contract is addressable.
   */
  app.set("query parser", "extended");
  app.enableShutdownHooks();

  return app;
}
