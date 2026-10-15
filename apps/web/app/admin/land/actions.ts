"use server";

import { revalidatePath } from "next/cache";
import { ApiCallError, api } from "../../../lib/api";

/**
 * Legal's two decisions on land.
 *
 * Deliberately separate calls, because they are separate questions. Approving
 * a legible Jamabandi says nothing about whether four siblings consent, and
 * recording one as though it answered the other is exactly how a lease gets
 * signed that the other holders can have set aside.
 */

export interface LandActionResult {
  error?: { code: string; message: string };
  status?: string;
}

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof ApiCallError) {
    return { code: error.body.code, message: error.body.message };
  }
  return {
    code: "UNEXPECTED",
    message: error instanceof Error ? error.message : "Something went wrong.",
  };
}

/* ------------------------------------------------------------------ */

export async function reviewDocument(
  formData: FormData,
): Promise<LandActionResult> {
  const documentId = String(formData.get("documentId") ?? "");
  const approved = String(formData.get("approved") ?? "") === "true";
  const reasonCode = String(formData.get("reasonCode") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  /**
   * Checked here as well as by the API. The API is the real block — a reason
   * code is required on a rejection and the request is refused without one —
   * but catching it in the form means the reviewer is told before their work
   * is thrown away.
   */
  if (!approved && !reasonCode) {
    return {
      error: {
        code: "REASON_REQUIRED",
        message:
          "A rejection needs a reason. The customer is about to be asked for another document, and support cannot tell them what to send without one.",
      },
    };
  }

  try {
    const result = await api<{ approved: boolean }>(
      `/v1/admin/documents/${documentId}/review`,
      {
        method: "POST",
        body: {
          approved,
          ...(reasonCode ? { reasonCode } : {}),
          ...(note ? { note } : {}),
        },
        idempotencyKey: `doc-review-${documentId}`,
      },
    );

    revalidatePath("/admin/land");
    return { status: result.approved ? "APPROVED" : "REJECTED" };
  } catch (error) {
    return { error: failure(error) };
  }
}

/* ------------------------------------------------------------------ */

export async function confirmConsent(
  formData: FormData,
): Promise<LandActionResult> {
  const parcelId = String(formData.get("parcelId") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  try {
    const result = await api<{ verificationStatus: string }>(
      `/v1/admin/land-parcels/${parcelId}/co-owner-consent`,
      {
        method: "POST",
        body: { ...(note ? { note } : {}) },
        idempotencyKey: `consent-${parcelId}`,
      },
    );

    revalidatePath("/admin/land");
    return { status: result.verificationStatus };
  } catch (error) {
    return { error: failure(error) };
  }
}

/* ------------------------------------------------------------------ */

/**
 * A fresh URL to open one document.
 *
 * Fetched on each click, never held: the link lasts a minute and every issue
 * is written to the audit log against the reviewer's name. A URL cached in the
 * page would be a view nobody recorded.
 */
export async function openDocument(
  documentId: string,
): Promise<{ error?: { code: string; message: string }; url?: string }> {
  try {
    const result = await api<{ url: string }>(
      `/v1/documents/${documentId}/download-url`,
    );
    return { url: result.url };
  } catch (error) {
    return { error: failure(error) };
  }
}
