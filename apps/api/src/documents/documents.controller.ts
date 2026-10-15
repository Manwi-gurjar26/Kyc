import { canReviewCase } from "@kilowattx/core";
import {
  ConfirmUploadInputSchema,
  DocumentReviewInputSchema,
  UploadUrlInputSchema,
  type ConfirmUploadInput,
  type DocumentReviewInput,
  type UploadUrlInput,
} from "@kilowattx/validation";
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiError } from "../common/errors.js";
import { SessionGuard, sessionOf, type RequestWithSession } from "../common/session.js";
import { StaffGuard } from "../common/staffGuard.js";
import { ZodBody } from "../common/zodPipe.js";
import { DocumentsService } from "./documents.service.js";

/**
 * What a customer can do with their own documents.
 */
@Controller("v1/documents")
@UseGuards(SessionGuard)
export class DocumentsController {
  constructor(
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  /** Somewhere to PUT the file. The browser uploads to the bucket, not here. */
  @Post("upload-url")
  async uploadUrl(
    @Req() request: RequestWithSession,
    @Body(new ZodBody(UploadUrlInputSchema)) body: UploadUrlInput,
  ) {
    const session = sessionOf(request);
    return this.documents.createUploadUrl(session.userId, body);
  }

  /** Called when the PUT finishes. A bucket event takes this over in production. */
  @Post("confirm")
  async confirm(
    @Req() request: RequestWithSession,
    @Body(new ZodBody(ConfirmUploadInputSchema)) body: ConfirmUploadInput,
  ) {
    const session = sessionOf(request);
    return this.documents.confirmUpload(session.userId, body);
  }

  /**
   * A short-lived URL to read one document.
   *
   * Every call writes an audit row, because obtaining the URL is the access —
   * what happens at the bucket afterwards is invisible to us.
   */
  @Get(":id/download-url")
  async downloadUrl(
    @Req() request: RequestWithSession,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const session = sessionOf(request);

    return this.documents.createDownloadUrl({
      documentId: id,
      actorUserId: session.userId,
      isStaff: session.isStaff,
      staffRoles: session.staffRoles,
      ipAddress: request.ip,
    });
  }
}

/* ------------------------------------------------------------------ */

/**
 * The reviewer's side.
 *
 * Separate controller because it is a separate audience behind a separate
 * guard, and because mixing them is how an endpoint ends up protected by the
 * wrong one.
 */
@Controller("v1/admin/documents")
@UseGuards(SessionGuard, StaffGuard)
export class AdminDocumentsController {
  constructor(
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  @Get()
  async queue() {
    return this.documents.reviewQueue();
  }

  @Post(":id/review")
  async review(
    @Req() request: RequestWithSession,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodBody(DocumentReviewInputSchema)) body: DocumentReviewInput,
  ) {
    const session = sessionOf(request);

    /**
     * Land and corporate documents are Legal's call, not compliance's.
     *
     * The guard above only knows whether the caller is staff at all — it has
     * not loaded the document and cannot answer this. Checked here, where the
     * case type is known, rather than by widening the guard: a guard that
     * answered the fine-grained question with coarse information is how
     * "support approved a company's KYB" happens.
     */
    if (!canReviewCase(session.staffRoles, "LAND_DOCUMENTS")) {
      throw ApiError.forbidden(
        "NOT_YOUR_QUEUE",
        "Documents are reviewed by Legal.",
      );
    }

    return this.documents.review({
      documentId: id,
      reviewerUserId: session.userId,
      input: body,
    });
  }
}
