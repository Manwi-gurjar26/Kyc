import { Controller, Headers, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import type { RequestWithSession } from "../common/session.js";
import { KycService } from "./kyc.service.js";

/**
 * Vendor webhooks.
 *
 * Deliberately NOT behind SessionGuard — the vendor has no session. The
 * signature is the authentication, which is why `verifyWebhook` throws rather
 * than returns when no secret is configured: an unauthenticated endpoint that
 * degrades to "accept anything" is the worst outcome available here.
 */
@Controller("v1/webhooks")
export class WebhooksController {
  constructor(@Inject(KycService) private readonly kyc: KycService) {}

  /**
   * The only thing that can move a KYC record to VERIFIED.
   *
   * Always answers 200 when the request is genuinely from the vendor, even
   * for a duplicate delivery. A replay is the vendor behaving correctly, and
   * answering 4xx to it would make it retry harder — eventually tripping
   * whatever alerting watches the vendor's error rate, for a situation that is
   * working exactly as designed.
   */
  @Post("kyc/:vendor")
  @HttpCode(200)
  async kycWebhook(
    @Param("vendor") vendor: string,
    @Headers("x-webhook-signature") signature: string | undefined,
    @Req() request: RequestWithSession,
  ) {
    const result = await this.kyc.handleWebhook({
      vendor,
      /**
       * The exact bytes, preserved by the raw-body middleware in main.ts. The
       * signature covers these; a re-serialised body would verify in
       * development and fail in production the first time the vendor changes
       * key order or whitespace.
       */
      rawBody: request.rawBody,
      signatureHeader: signature,
    });

    return { received: true, ...result };
  }
}
