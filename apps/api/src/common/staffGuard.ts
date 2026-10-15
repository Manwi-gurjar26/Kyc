import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ApiError } from "./errors.js";
import { sessionOf, type RequestWithSession } from "./session.js";

/**
 * Requires a staff session.
 *
 * This is the coarse gate: are you staff at all. It deliberately does not
 * decide which cases you may act on, because that depends on the case — a
 * board resolution goes to Legal, a weak face match goes to compliance — and
 * the guard has not loaded the case yet. `canReviewCase()` in packages/core
 * makes that call, inside the service, with the case in hand.
 *
 * Splitting it this way matters: a guard that tried to answer both questions
 * would either need to fetch the case (duplicating the service) or would
 * answer the fine-grained question with coarse information, which is how
 * "support can approve a company's KYB" happens.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = sessionOf(request);

    if (!session.isStaff) {
      /**
       * 404, not 403. A customer poking at /v1/admin should not learn that
       * the path exists, let alone what it is called.
       */
      throw ApiError.notFound("NOT_FOUND", "Not found.");
    }

    return true;
  }
}
