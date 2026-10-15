import { ReviewActionInputSchema, type ReviewActionInput } from "@kilowattx/validation";
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { SessionGuard, sessionOf, type RequestWithSession } from "../common/session.js";
import { StaffGuard } from "../common/staffGuard.js";
import { ZodBody } from "../common/zodPipe.js";
import { AdminService } from "./admin.service.js";

/**
 * The review queue, for staff.
 *
 * Both guards, in order: SessionGuard establishes who is asking, StaffGuard
 * requires that they are staff at all. Whether they may decide a particular
 * case is settled inside the service, with the case loaded, by
 * `canReviewCase()`.
 */
@Controller("v1/admin/kyc")
@UseGuards(SessionGuard, StaffGuard)
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  /** The open queue, oldest first, with the thresholds in force. */
  @Get("reviews")
  async queue(@Req() request: RequestWithSession) {
    const session = sessionOf(request);

    const [queue, thresholds, health] = await Promise.all([
      this.admin.queue(session.staffRoles),
      this.admin.currentThresholds(),
      this.admin.queueHealth(),
    ]);

    return { ...queue, thresholds, health };
  }

  /** One case, with everything needed to decide it. */
  @Get("reviews/:id")
  async detail(@Req() request: RequestWithSession, @Param("id") id: string) {
    const session = sessionOf(request);

    const [detail, thresholds] = await Promise.all([
      this.admin.caseDetail(id, session.staffRoles),
      this.admin.currentThresholds(),
    ]);

    return { ...detail, thresholds };
  }

  /**
   * Approve, reject, or ask for a re-upload.
   *
   * One endpoint rather than three, because all three are the same operation
   * with a different outcome, and all three need the same mandatory reason
   * code. Three endpoints would mean three places for the reason-code check
   * to be forgotten.
   */
  @Post("reviews/:id")
  async review(
    @Req() request: RequestWithSession,
    @Param("id") id: string,
    @Body(new ZodBody(ReviewActionInputSchema)) body: ReviewActionInput,
  ) {
    const session = sessionOf(request);

    return this.admin.review({
      recordId: id,
      reviewerUserId: session.userId,
      staffRoles: session.staffRoles,
      action: body.action,
      reasonCode: body.reasonCode,
      note: body.note,
    });
  }
}
