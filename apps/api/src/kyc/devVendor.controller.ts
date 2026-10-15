import {
  FakeKybProvider,
  FakeKycProvider,
  type FakeScenario,
} from "@kilowattx/integrations";
import { gstinCheckDigit } from "@kilowattx/validation";
import {
  Body,
  Controller,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { DI, type AppConfig } from "../config.js";
import { ApiError } from "../common/errors.js";
import { KycService } from "./kyc.service.js";

/**
 * Stands in for the vendor's own servers.
 *
 * In production the user finishes the vendor's hosted flow (or their SDK) and
 * the VENDOR calls our webhook. There is no vendor here, so something has to
 * play that part, and it has to do it honestly: this endpoint asks the fake
 * provider for a genuinely signed webhook and feeds it through exactly the
 * same handler a real delivery goes through — signature check, replay guard,
 * server-to-server fetch, decideKyc(), one transaction.
 *
 * It does NOT shortcut to the decision. If it did, local development would
 * exercise a different path from production, and the webhook handling would be
 * untested by the very flow people use most.
 *
 * WHY IT LIVES IN THE API RATHER THAN THE WEB APP: completing a session means
 * producing a valid signature, which needs the webhook secret. That secret
 * must not reach a browser or a second service. So the browser calls this, and
 * the signing stays here.
 *
 * Refused outright in production.
 */
@Controller("v1/dev/kyc-sessions")
export class DevVendorController {
  constructor(
    @Inject(DI.CONFIG) private readonly config: AppConfig,
    @Inject(DI.KYC_PROVIDER) private readonly provider: unknown,
    @Inject(KycService) private readonly kyc: KycService,
  ) {}

  private assertAvailable(): FakeKycProvider {
    if (this.config.NODE_ENV === "production") {
      throw ApiError.notFound("NOT_FOUND", "Not found.");
    }
    if (!(this.provider instanceof FakeKycProvider)) {
      throw ApiError.badRequest(
        "DEV_ENDPOINT_UNAVAILABLE",
        "This endpoint only works with the fake KYC provider.",
      );
    }
    return this.provider;
  }

  /**
   * Example business identifiers that actually validate.
   *
   * A GSTIN has a mod-36 check digit and a CIN has to carry a company name
   * that agrees with the GST legal name, so a hand-typed example is almost
   * always rejected — and somebody trying the Commercial User flow for the
   * first time spends ten minutes fighting a checksum rather than looking at
   * the flow.
   *
   * Computed from the provider's own derivation rather than hard-coded in the
   * UI, so they cannot drift from what the lookups will actually say.
   */
  @Post("kyb-examples")
  async kybExamples() {
    this.assertAvailable();
    const kyb = new FakeKybProvider();

    const gstin = (pan: string, entity = "1") => {
      const first14 = `08${pan}${entity}Z`;
      return first14 + gstinCheckDigit(first14);
    };

    const company = gstin("AADCS9012F");
    const proprietor = gstin("ABCPS4412K");
    const cancelled = gstin("AADCS9012F", "9");

    return {
      examples: [
        {
          label: "Private limited company — everything in order",
          gstin: company,
          cin: kyb.cinForGstin(company),
          outcome: "VERIFIED once the signatory is personally verified",
        },
        {
          label: "Proprietorship — no company register needed",
          gstin: proprietor,
          cin: null,
          outcome: "VERIFIED; the owner's own KYC is the business check",
        },
        {
          label: "Company struck off the register",
          gstin: company,
          cin: kyb.cinForGstin(company, "NPL"),
          outcome: "REJECTED — an active GSTIN does not make a dead company real",
        },
        {
          label: "MCA name disagrees with the GST name",
          gstin: company,
          cin: "U17299RJ2017PTC999999",
          outcome: "MANUAL_REVIEW — wrong CIN, or two different entities",
        },
        {
          label: "GST registration cancelled",
          gstin: cancelled,
          cin: kyb.cinForGstin(cancelled),
          outcome: "REJECTED — no valid B2B invoice can be raised",
        },
      ],
    };
  }

  /**
   * Finishes a session the way the vendor would.
   *
   * The scenario is chosen when the session is OPENED, not here, because that
   * is how a real vendor works too: what comes back depends on what the
   * person's documents and face actually are, not on what the caller asks for
   * at the end.
   */
  @Post(":sessionId/complete")
  async complete(@Param("sessionId") sessionId: string) {
    const provider = this.assertAvailable();

    const webhook = await provider.buildWebhook(sessionId);

    const result = await this.kyc.handleWebhook({
      vendor: provider.name,
      rawBody: Buffer.from(webhook.rawBody, "utf8"),
      signatureHeader: webhook.signatureHeader,
    });

    return {
      ...result,
      scenario: provider.scenarioOf(sessionId),
      /** Non-zero for the late_webhook scenario, which the poller must cover. */
      deliveryDelaySeconds: webhook.delaySeconds,
    };
  }

  /**
   * Opens a session with a chosen scenario, so every outcome is reachable
   * from the browser without editing code.
   *
   * This is the development equivalent of having a stack of test identities at
   * the vendor: one that passes, one with an old Aadhaar photo, one whose PAN
   * was deactivated, one who is sixteen.
   */
  @Post("scenarios")
  async listScenarios(@Body() _body: unknown) {
    this.assertAvailable();
    return {
      scenarios: [
        { id: "pass", label: "Everything passes", outcome: "VERIFIED" },
        {
          id: "low_face_score",
          label: "Old Aadhaar photo, weak face match",
          outcome: "MANUAL_REVIEW",
        },
        {
          id: "liveness_fail",
          label: "Liveness fails (photo of a photo)",
          outcome: "MANUAL_REVIEW",
        },
        {
          id: "pan_name_mismatch",
          label: "PAN name differs (married name)",
          outcome: "MANUAL_REVIEW",
        },
        {
          id: "pan_inoperative",
          label: "PAN not linked to Aadhaar",
          outcome: "VERIFIED (flagged for TDS)",
        },
        {
          id: "pan_deactivated",
          label: "PAN deactivated by the IT Department",
          outcome: "REJECTED",
        },
        { id: "minor", label: "Under 18 on Aadhaar", outcome: "REJECTED" },
        {
          id: "aadhaar_failed",
          label: "DigiLocker down",
          outcome: "MANUAL_REVIEW",
        },
      ] satisfies { id: FakeScenario; label: string; outcome: string }[],
    };
  }
}
