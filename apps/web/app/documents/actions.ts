"use server";

import { revalidatePath } from "next/cache";
import { ApiCallError, api } from "../../lib/api";
import type {
  ConfirmedUploadView,
  DownloadUrlView,
  ParcelView,
  UploadTargetView,
} from "../../lib/documentTypes";

/**
 * Uploading a land document, in the two steps the real flow has.
 *
 * In production the browser PUTs the file straight to the bucket using the
 * signed URL, and the bucket's own event triggers the scan. Here the server
 * action does the PUT, because there is no bucket — but the sequence is the
 * real one, so wiring up a managed bucket means changing where the PUT goes and deleting the
 * confirm call, not restructuring the flow.
 */

export interface UploadResult {
  error?: { code: string; message: string };
  document?: ConfirmedUploadView;
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

export async function uploadDocument(formData: FormData): Promise<UploadResult> {
  const docType = String(formData.get("docType") ?? "");
  const testMarker = String(formData.get("testMarker") ?? "");
  const testKhasra = String(formData.get("testKhasra") ?? "").trim();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { error: { code: "NO_FILE", message: "Choose a file first." } };
  }

  try {
    /**
     * Step one: ask where to put it. The server chooses the key — a
     * client-named key would let one customer write over another's deed.
     */
    const target = await api<UploadTargetView>("/v1/documents/upload-url", {
      method: "POST",
      body: {
        docType,
        fileName: file.name,
        contentType: file.type || "application/pdf",
        sizeBytes: file.size,
        ...(testMarker ? { testMarkers: [testMarker] } : {}),
        ...(testKhasra ? { testKhasra } : {}),
      },
    });

    /**
     * Step two: the upload itself. The content type must be exactly what was
     * signed, or the signature will not match.
     */
    const bytes = await file.arrayBuffer();
    const put = await fetch(target.url, {
      method: "PUT",
      headers: { "content-type": target.contentType },
      body: bytes,
    });

    if (!put.ok) {
      return {
        error: {
          code: "UPLOAD_FAILED",
          message: `The storage endpoint refused the file (${put.status}).`,
        },
      };
    }

    /**
     * Step three, which disappears in production: tell the API the upload
     * finished. A managed bucket emits this event itself, which is why the handler takes a
     * key and a digest rather than anything only a browser would know.
     */
    const digest = await sha256Hex(bytes);

    const document = await api<ConfirmedUploadView>("/v1/documents/confirm", {
      method: "POST",
      body: { storageKey: target.key, sha256: digest },
    });

    revalidatePath("/documents");
    return { document };
  } catch (error) {
    return { error: failure(error) };
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------------------------------------------ */

/**
 * Fetches a fresh URL to view one document.
 *
 * Called on every open rather than held in the page, because the URL lasts
 * sixty seconds and each issue is an audited access. A URL cached in component
 * state would be a view nobody logged.
 */
export async function viewDocument(
  documentId: string,
): Promise<{ error?: { code: string; message: string }; view?: DownloadUrlView }> {
  try {
    const view = await api<DownloadUrlView>(
      `/v1/documents/${documentId}/download-url`,
    );
    return { view };
  } catch (error) {
    return { error: failure(error) };
  }
}

/* ------------------------------------------------------------------ */

/**
 * The caller's own plots, with the verdict and the reasons behind it.
 *
 * Read on every render rather than cached. A parcel's verdict changes when
 * Legal acts, and a cached one would show somebody "under review" for a day
 * after it had already cleared.
 */
export async function listParcels(): Promise<{
  error?: { code: string; message: string };
  parcels?: ParcelView[];
}> {
  try {
    const result = await api<{ parcels: ParcelView[] }>("/v1/land-parcels");
    return { parcels: result.parcels };
  } catch (error) {
    return { error: failure(error) };
  }
}

/**
 * Declaring who else holds a plot.
 *
 * The customer is asked rather than the document being trusted to say. OCR on
 * a faded Jamabandi cannot be relied on to find every name written in a
 * margin, and a co-owner it missed is the one failure that matters here — a
 * lease the others can have set aside once the panels are installed.
 */
export async function declareCoOwners(
  formData: FormData,
): Promise<{ error?: { code: string; message: string }; status?: string }> {
  const parcelId = String(formData.get("parcelId") ?? "");

  /**
   * One name per line. A comma-separated box would mangle the first name that
   * contains a comma, and plenty of registry records do.
   */
  const coOwnerNames = String(formData.get("coOwnerNames") ?? "")
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);

  try {
    const result = await api<{ verificationStatus: string }>(
      `/v1/land-parcels/${parcelId}/co-owners`,
      { method: "POST", body: { coOwnerNames }, idempotencyKey: `co-${parcelId}` },
    );

    revalidatePath("/documents");
    return { status: result.verificationStatus };
  } catch (error) {
    return { error: failure(error) };
  }
}
