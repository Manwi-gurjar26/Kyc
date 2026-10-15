import { canReviewCase } from "@kilowattx/core";
import {
  CoOwnerConsentInputSchema,
  CoOwnersInputSchema,
  type CoOwnerConsentInput,
  type CoOwnersInput,
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
import { LandService } from "./land.service.js";

/**
 * The customer's own plots.
 */
@Controller("v1/land-parcels")
@UseGuards(SessionGuard)
export class LandController {
  constructor(@Inject(LandService) private readonly land: LandService) {}

  @Get()
  async list(@Req() request: RequestWithSession) {
    const session = sessionOf(request);
    return this.land.listForUser(session.userId);
  }

  /**
   * Declaring who else holds the land.
   *
   * A POST rather than a PATCH because it is an assertion the customer is
   * making about their own land, and one we hold them to — not a field being
   * edited.
   */
  @Post(":id/co-owners")
  async coOwners(
    @Req() request: RequestWithSession,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodBody(CoOwnersInputSchema)) body: CoOwnersInput,
  ) {
    const session = sessionOf(request);
    return this.land.declareCoOwners(session.userId, id, body);
  }
}

/* ------------------------------------------------------------------ */

@Controller("v1/admin/land-parcels")
@UseGuards(SessionGuard, StaffGuard)
export class AdminLandController {
  constructor(@Inject(LandService) private readonly land: LandService) {}

  @Get()
  async queue() {
    return this.land.reviewQueue();
  }

  @Post(":id/co-owner-consent")
  async confirmConsent(
    @Req() request: RequestWithSession,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodBody(CoOwnerConsentInputSchema)) body: CoOwnerConsentInput,
  ) {
    const session = sessionOf(request);

    /**
     * Land is Legal's, like every other land question. The guard above knows
     * only that the caller is staff; this is the part that knows which queue
     * they belong to.
     */
    if (!canReviewCase(session.staffRoles, "LAND_DOCUMENTS")) {
      throw ApiError.forbidden(
        "NOT_YOUR_QUEUE",
        "Land parcels are reviewed by Legal.",
      );
    }

    return this.land.confirmConsent(id, session.userId, body);
  }
}
