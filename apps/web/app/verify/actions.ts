"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { ApiCallError, api } from "../../lib/api";

/**
 * The verification flow, server side.
 *
 * Every call runs here rather than in the browser, so the Aadhaar number goes
 * straight from this server to the gateway and never sits in client-side
 * JavaScript, a fetch log or a browser extension's reach.
 */

export interface Failure {
  error?: { code: string; message: string };
}

function failure(error: unknown): Failure {
  if (error instanceof ApiCallError) {
    return { error: { code: error.body.code, message: error.body.message } };
  }
  return {
    error: {
      code: "UNEXPECTED",
      message: "Something went wrong on our side. Please try again.",
    },
  };
}

/* ------------------------------------------------------------------ */
/* The hosted Aadhaar route                                           */
/* ------------------------------------------------------------------ */

/**
 * Opens a hosted session and hands back where to send the person.
 *
 * Consent is recorded first and separately, because nothing may reach a
 * gateway before there is a row saying what was agreed to — and this call
 * costs money the moment it succeeds.
 */
export async function startHostedAadhaar(): Promise<
  Failure & { hostedUrl?: string }
> {
  try {
    const consent = await api<{ id: string }>("/v1/kyc/consents", {
      method: "POST",
      body: { purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" },
    });

    const session = await api<{ hostedUrl?: string }>("/v1/kyc/sessions", {
      method: "POST",
      /** One key per genuine attempt, so a double click opens one session. */
      idempotencyKey: `web-${randomUUID()}`,
      body: {
        level: "FULL",
        role: "LAND_OWNER",
        locale: "en",
        consentId: consent.id,
      },
    });

    if (!session.hostedUrl) {
      return {
        error: {
          code: "NO_HOSTED_URL",
          message:
            "The verification service did not give us anywhere to send you. Please try again shortly.",
        },
      };
    }

    return { hostedUrl: session.hostedUrl };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Asks the server what came of a session, once the person is back.
 *
 * The browser reports only that they returned. What actually happened is
 * fetched from the gateway server-to-server, which is why this sends nothing
 * but the session id — there is no outcome the page could tell us that we
 * would believe.
 */
export async function collectHostedAadhaar(
  vendorSessionId: string,
): Promise<Failure & { status?: string; reasonCodes?: string[] }> {
  try {
    const result = await api<{ status: string; reasonCodes: string[] }>(
      `/v1/kyc/sessions/${encodeURIComponent(vendorSessionId)}/collect`,
      { method: "POST" },
    );
    return { status: result.status, reasonCodes: result.reasonCodes };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------------ */
/* Selfie                                                             */
/* ------------------------------------------------------------------ */

/**
 * Asks for somewhere to put the selfie.
 *
 * Two calls rather than one, because the bytes do not come through here. The
 * server mints a URL that is signed for one key, one content type and one
 * size, the browser sends the image to it, and then the second call records
 * that it arrived. An image routed through this action instead would mean
 * every selfie passing through the web server's memory and logs for no gain.
 *
 * The URL is safe to hand to the browser: it is signed for a PUT of one
 * object and expires in minutes. It is not a credential for anything else.
 */
export async function startSelfieUpload(input: {
  sizeBytes: number;
}): Promise<Failure & { url?: string; key?: string }> {
  try {
    const target = await api<{ url: string; key: string }>(
      "/v1/documents/upload-url",
      {
        method: "POST",
        body: {
          docType: "SELFIE",
          fileName: "selfie.jpg",
          contentType: "image/jpeg",
          sizeBytes: input.sizeBytes,
        },
      },
    );

    return { url: target.url, key: target.key };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Records that the upload landed, which is what starts the virus scan.
 *
 * Until this runs the object is in the bucket and unknown to us — there is no
 * `documents` row, so nothing has been scanned and the decision step treats
 * the person as having no selfie at all. That is the right default: an
 * unscanned file is not evidence.
 */
export async function confirmSelfie(input: {
  storageKey: string;
  sha256: string;
}): Promise<Failure & { scanStatus?: string }> {
  try {
    const confirmed = await api<{ scanStatus?: string }>("/v1/documents/confirm", {
      method: "POST",
      body: { storageKey: input.storageKey, sha256: input.sha256 },
    });

    return { scanStatus: confirmed.scanStatus };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------------ */
/* Individual                                                         */
/* ------------------------------------------------------------------ */

/*
 * `sendAadhaarOtp` and `verifyIndividual` are gone.
 *
 * They took an Aadhaar number, asked the gateway to send a one-time password
 * to the mobile registered against it, and sent the code back. Aadhaar is
 * collected at DigiLocker now — on the government's own site, under the
 * person's own account — so no number and no code passes through this
 * application at all.
 *
 * The provider methods and the challenge table are deliberately still there.
 * No DigiLocker verification has completed end to end yet, and the only thing
 * worse than one dead Aadhaar route is two: flipping KYC_PROVIDER back is the
 * fallback, and deleting the code behind it would remove that.
 */

/**
 * Submits the PAN, which is also what triggers the decision.
 *
 * What is left of `verifyIndividual` once its OTP stage went. The API decides
 * at the end of the PAN step, so this call is what moves somebody out of
 * IN_PROGRESS and into the review queue.
 */
export async function submitPan(pan: string): Promise<Failure> {
  try {
    await api("/v1/kyc/pan", { method: "POST", body: { pan } });
  } catch (error) {
    return failure(error);
  }

  /**
   * Outside the try: redirect() works by throwing, so catching around it
   * would swallow the navigation and report it as a failed PAN check.
   */
  redirect("/verify/done");
}
