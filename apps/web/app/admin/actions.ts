"use server";

import { revalidatePath } from "next/cache";
import { ApiCallError, api, setStaffRoles } from "../../lib/api";

export interface ReviewResult {
  error?: { code: string; message: string };
  status?: string;
}

/** Development only. Better Auth will carry roles in the session. */
export async function chooseRoles(formData: FormData): Promise<void> {
  const roles = String(formData.get("roles") ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  await setStaffRoles(roles);
  revalidatePath("/admin");
}

/**
 * Records a decision.
 *
 * The reason code is sent, never invented here. Two expected failures come
 * back with codes the page can explain rather than a generic error: somebody
 * else already decided the case, and a reviewer trying to decide their own.
 */
export async function submitReview(formData: FormData): Promise<ReviewResult> {
  const recordId = String(formData.get("recordId") ?? "");
  const action = String(formData.get("action") ?? "");
  const reasonCode = String(formData.get("reasonCode") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  try {
    const result = await api<{ status: string }>(
      `/v1/admin/kyc/reviews/${recordId}`,
      {
        method: "POST",
        body: { action, reasonCode, ...(note ? { note } : {}) },
      },
    );

    revalidatePath("/admin");
    revalidatePath(`/admin/${recordId}`);
    return { status: result.status };
  } catch (error) {
    if (error instanceof ApiCallError) {
      return { error: { code: error.body.code, message: error.body.message } };
    }
    throw error;
  }
}
