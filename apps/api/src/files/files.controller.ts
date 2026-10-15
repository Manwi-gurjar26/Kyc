import type { FileStore, LocalDiskBucket } from "@kilowattx/integrations";
import {
  Controller,
  Get,
  Inject,
  Put,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiError } from "../common/errors.js";
import { DI } from "../config.js";

/**
 * The development object store.
 *
 * A managed bucket replaces these two routes and the URL signing together, because a real
 * bucket does both itself. Until then the API serves the URLs it mints.
 *
 * These are the only routes in the API with no session guard, and that is
 * deliberate rather than an oversight: the signature in the URL *is* the
 * authorisation. A browser PUTs straight here, and in production it will PUT
 * straight to the bucket, where no session of ours exists either.
 *
 * Which means every refusal below has to be enforced here rather than assumed
 * from a caller being logged in.
 */
@Controller("v1/files")
export class FilesController {
  constructor(
    @Inject(DI.FILE_STORE) private readonly files: FileStore,
    @Inject(DI.FILE_BUCKET) private readonly bucket: LocalDiskBucket,
  ) {}

  /* ---------------------------------------------------------------- */

  @Put()
  async upload(@Req() request: Request, @Res() response: Response) {
    const url = absoluteUrlOf(request);
    const verdict = this.files.verify(url, { method: "PUT", now: new Date() });

    if (!verdict.valid) {
      throw rejection(verdict.reason);
    }

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw ApiError.badRequest(
        "EMPTY_BODY",
        "No file was sent. The body must be the raw bytes of the object.",
      );
    }

    /**
     * The signed limits, enforced here.
     *
     * They were signed precisely so they would not depend on the client
     * respecting what it was told. Reading them back out of the URL is safe
     * because the signature already covered them — a client that edited either
     * one never reached this line.
     */
    const signedMax = Number(new URL(url).searchParams.get("max") ?? "0");
    if (signedMax > 0 && body.length > signedMax) {
      throw ApiError.payloadTooLarge(
        "FILE_TOO_LARGE",
        `This URL was signed for at most ${signedMax} bytes; the body is ${body.length}.`,
      );
    }

    const signedType = new URL(url).searchParams.get("ct");
    const sentType = (request.header("content-type") ?? "").split(";")[0]!.trim();

    if (signedType && sentType && sentType !== signedType) {
      throw ApiError.unsupportedMediaType(
        "CONTENT_TYPE_MISMATCH",
        `This URL was signed for ${signedType}; the request sent ${sentType}.`,
      );
    }

    await this.bucket.put(verdict.key, body, signedType ?? sentType);

    /** No body. Nothing about the stored object is secret from its uploader,
     *  but nothing about it is useful to them either. */
    response.status(200).json({ key: verdict.key, sizeBytes: body.length });
  }

  /* ---------------------------------------------------------------- */

  @Get()
  async download(@Req() request: Request, @Res() response: Response) {
    const verdict = this.files.verify(absoluteUrlOf(request), {
      method: "GET",
      now: new Date(),
    });

    if (!verdict.valid) {
      throw rejection(verdict.reason);
    }

    const stored = await this.bucket.get(verdict.key);

    /**
     * 404, not 403. The URL is genuine and there is simply nothing there —
     * conflating that with a signature failure would send somebody debugging
     * the wrong problem entirely.
     */
    if (!stored) {
      throw ApiError.notFound("OBJECT_NOT_FOUND", "No such object.");
    }

    response
      .status(200)
      .setHeader("content-type", stored.contentType)
      /**
       * Never cached. These URLs are short-lived on purpose, and a copy in a
       * shared cache would outlive the window and be served to somebody the
       * audit log never recorded.
       */
      .setHeader("cache-control", "no-store, private")
      /** Opened in a viewer, not executed as a page on our own origin. */
      .setHeader("content-disposition", "inline")
      .setHeader("x-content-type-options", "nosniff")
      .send(stored.bytes);
  }
}

/* ------------------------------------------------------------------ */

/**
 * Rebuilds the URL the signature was computed over.
 *
 * The host matters because it was part of the signed `baseUrl`. Taken from the
 * request rather than from configuration so that a URL minted for one host
 * does not silently verify against another.
 */
function absoluteUrlOf(request: Request): string {
  const host = request.header("host") ?? "localhost";
  const protocol = request.protocol === "https" ? "https" : "http";
  return `${protocol}://${host}${request.originalUrl}`;
}

/**
 * Every signature failure answers 403 with its own code.
 *
 * One status, several codes: whether a URL was forged or merely stale changes
 * nothing about what the caller may do, but it changes everything about what
 * an operator should look at. An expired reviewer tab is noise; a signature
 * mismatch is somebody trying.
 */
function rejection(reason: string): ApiError {
  const codes: Record<string, string> = {
    EXPIRED: "URL_EXPIRED",
    MISSING_SIGNATURE: "URL_NOT_SIGNED",
    MALFORMED_SIGNATURE: "URL_MALFORMED",
    SIGNATURE_MISMATCH: "URL_SIGNATURE_INVALID",
  };

  const messages: Record<string, string> = {
    EXPIRED: "This link has expired. Ask for a new one.",
    MISSING_SIGNATURE: "This link is not signed.",
    MALFORMED_SIGNATURE: "This link is malformed.",
    SIGNATURE_MISMATCH: "This link is not valid.",
  };

  return ApiError.forbidden(
    codes[reason] ?? "URL_SIGNATURE_INVALID",
    messages[reason] ?? "This link is not valid.",
  );
}
