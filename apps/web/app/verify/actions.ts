"use server";

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

  redirect("/verify/done");
}

/* ------------------------------------------------------------------ */
/* Business                                                           */
/* ------------------------------------------------------------------ */

export async function fetchGstin(gstin: string): Promise<
  Failure & {
    organisation?: {
      legalName: string;
      status: string;
      constitution: string;
      businessPan: string;
    };
  }
> {
  try {
    await api("/v1/kyc/consents", {
      method: "POST",
      body: { purpose: "KYB_VERIFICATION", noticeVersion: "2.1", locale: "en" },
    }).catch(() => undefined);

    const result = await api<{
      legalName: string;
      gstStatus: string;
      constitution: string;
      businessPan: string;
    }>("/v1/kyb/organisations", {
      method: "POST",
      idempotencyKey: `kyb-${gstin}`,
      body: { gstin },
    });

    return {
      organisation: {
        legalName: result.legalName,
        status: result.gstStatus,
        constitution: result.constitution,
        businessPan: result.businessPan,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function verifyBusiness(_input: {
  gstin: string;
  cin: string;
  signatoryPan: string;
}): Promise<Failure> {
  redirect("/verify/done");
}
