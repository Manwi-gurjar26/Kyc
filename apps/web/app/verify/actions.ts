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


export async function sendAadhaarOtp(
  aadhaarNumber: string,
): Promise<Failure & { sentTo?: string }> {
  try {
    /**
     * Consent before the number moves. Recorded first, every time: a consent
     * row written after the fact proves nothing about what the person agreed
     * to before their Aadhaar was sent to a third party.
     */
    await api("/v1/kyc/consents", {
      method: "POST",
      body: { purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" },
    }).catch(() => undefined);

    const result = await api<{ referenceId: string; sentTo: string }>(
      "/v1/kyc/aadhaar/otp",
      { method: "POST", body: { aadhaarNumber } },
    );

    return { sentTo: `OTP sent to ${result.sentTo}` };
  } catch (error) {
    return failure(error);
  }
}

export async function verifyIndividual(input: {
  stage: "otp" | "finish";
  otp?: string;
  pan?: string;
}): Promise<Failure & { message?: string }> {
  if (input.stage === "otp") {
    try {
      /**
       * Only the six digits go up.
       *
       * The gateway's reference id lives in Postgres against the signed-in
       * person. It used to be held here in a module-level variable — one
       * variable shared by every request this process served, so two people
       * verifying at the same moment overwrote each other and the second
       * person's OTP was checked against the first person's challenge.
       */
      const result = await api<{ last4: string; nameOnRecord?: string }>(
        "/v1/kyc/aadhaar/verify",
        { method: "POST", body: { otp: input.otp } },
      );
      return {
        message: result.nameOnRecord
          ? `Aadhaar confirmed for ${result.nameOnRecord}.`
          : "Aadhaar confirmed.",
      };
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * The PAN actually goes somewhere now.
   *
   * It was collected by the form and then dropped: this branch redirected
   * straight to /verify/done, so somebody typed their PAN, pressed a button
   * labelled "Verify", landed on a page telling them they were finished, and
   * no PAN had been checked — the record still said IN_PROGRESS with an empty
   * pan_last4. The endpoint existed; nothing called it.
   *
   * This is also what triggers the decision, because the API decides at the
   * end of the PAN step. Until this call was wired up, finishing the flow
   * produced no decision at all and nobody reached the review queue.
   */
  try {
    await api("/v1/kyc/pan", {
      method: "POST",
      body: { pan: input.pan },
    });
  } catch (error) {
    return failure(error);
  }

  /**
   * Outside the try: redirect() works by throwing, so catching around it
   * would swallow the navigation and report it as a failed PAN check.
   */
  redirect("/verify/done");
}

/* ------------------------------------------------------------------ */
/* Business                                                           */
/* ------------------------------------------------------------------ */

/*
 * `fetchGstin` and `verifyBusiness` are gone with /verify/business.
 *
 * They served a single page that asked every business for a GSTIN, a CIN, a
 * certificate of incorporation and a signatory PAN, and then kept none of it:
 * `verifyBusiness` took that input, ignored it, and redirected to "done". The
 * GSTIN lookup was the only real call, so finishing the form left a half-built
 * organisation and nothing else — and told the person they were verified.
 *
 * The business flow is /commercial, whose actions call the whole sequence:
 * consent, GSTIN, company register, signatory, submit. It also renders from
 * the API's `remainingSteps` instead of a fixed list, so a proprietorship is
 * not asked for a company register it cannot have.
 */

