import { isLiveSandboxKey, type KycProviderName } from "@kilowattx/integrations";
import { Controller, Get, Header, Inject } from "@nestjs/common";
import { DI, type AppConfig } from "../config.js";
import { ApiError } from "../common/errors.js";

/**
 * Which verification gateway this deployment is talking to, for the web app's
 * environment chip.
 *
 * The chip was a hardcoded "Fake vendor · nothing is really verified", which
 * stayed on screen after KYC_PROVIDER moved to digilocker with a live key —
 * so a page doing real Aadhaar verifications told whoever was looking at it
 * that nothing was being checked. The web app has no config of its own to
 * read; the API is the one that knows.
 *
 * Development only, for the reason /healthz gives nothing away: telling an
 * anonymous caller that a deployment runs `fake` tells them its verification
 * is simulated. Registered only outside production, and it checks NODE_ENV
 * itself as well.
 */

export interface DevEnvironment {
  kycProvider: KycProviderName;
  /**
   * Whose identities the vendor is checking. `live` means real people's
   * Aadhaar; `test` means the vendor's test host; null for `fake`, which
   * calls no vendor at all.
   *
   * Follows the key rather than NODE_ENV, exactly as SandboxClient picks its
   * host, so the two cannot disagree.
   */
  vendorEnvironment: "live" | "test" | null;
}

@Controller("v1/dev/environment")
export class DevEnvironmentController {
  constructor(@Inject(DI.CONFIG) private readonly config: AppConfig) {}

  @Get()
  @Header("Cache-Control", "no-store")
  get(): DevEnvironment {
    if (this.config.NODE_ENV === "production") {
      throw ApiError.notFound("NOT_FOUND", "Not found.");
    }

    const provider = this.config.KYC_PROVIDER;
    const key = this.config.KYC_VENDOR_CLIENT_ID;

    return {
      kycProvider: provider,
      vendorEnvironment:
        provider === "fake" || !key ? null : isLiveSandboxKey(key) ? "live" : "test",
    };
  }
}
