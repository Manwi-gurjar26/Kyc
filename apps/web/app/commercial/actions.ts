"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { ApiCallError, api } from "../../lib/api";
import type { OrganisationView } from "../../lib/kybTypes";

/**
 * The Commercial User flow, step by step.
 *
 * Each action does one thing and returns the server's own view of the
 * business, so the page never has to infer where it is in the flow — the
 * `remainingSteps` the API returns is the state machine, and the UI only
 * renders it. That matters because the steps are not fixed: a proprietorship
 * has no company register, and the API is the thing that knows.
 */

const ORG_COOKIE = "kwx_kyb_org";

export interface KybResult {
  error?: { code: string; message: string; details?: unknown };
  organisation?: OrganisationView;
}

export async function currentOrgId(): Promise<string | null> {
  const store = await cookies();
  return store.get(ORG_COOKIE)?.value ?? null;
}

async function rememberOrg(orgId: string): Promise<void> {
  const store = await cookies();
  store.set(ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
}

export async function forgetOrg(): Promise<void> {
  const store = await cookies();
  store.delete(ORG_COOKIE);
  revalidatePath("/commercial");
}

function failed(error: unknown): KybResult {
  if (error instanceof ApiCallError) {
    return {
      error: {
        code: error.body.code,
        message: error.body.message,
        details: error.body.details,
      },
    };
  }
  throw error;
}

/* ------------------------------------------------------------------ */

/** Records KYB consent. Nothing business-related happens before it. */
export async function giveKybConsent(): Promise<KybResult> {
  try {
    await api("/v1/kyc/consents", {
      method: "POST",
      body: {
        purpose: "KYB_VERIFICATION",
        noticeVersion: "2.1",
        locale: "en",
      },
    });
    revalidatePath("/commercial");
    return {};
  } catch (error) {
    return failed(error);
  }
}

/**
 * Starts the business check from a GSTIN alone.
 *
 * The form asks for nothing else, because everything else is either inside
 * the GSTIN or comes back from the lookup.
 */
export async function lookUpGstin(formData: FormData): Promise<KybResult> {
  const gstin = String(formData.get("gstin") ?? "").trim();

  try {
    const organisation = await api<OrganisationView>("/v1/kyb/organisations", {
      method: "POST",
      body: { gstin },
    });
    await rememberOrg(organisation.id);
    revalidatePath("/commercial");
    return { organisation };
  } catch (error) {
    return failed(error);
  }
}

export async function recordCompanyRegister(formData: FormData): Promise<KybResult> {
  const orgId = String(formData.get("orgId") ?? "");
  const cin = String(formData.get("cin") ?? "").trim();

  try {
    const organisation = await api<OrganisationView>(
      `/v1/kyb/organisations/${orgId}/company-register`,
      { method: "POST", body: { cin } },
    );
    revalidatePath("/commercial");
    return { organisation };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Declares the signed-in person as the signatory.
 *
 * No field for naming somebody else, on purpose: the API would refuse it, and
 * offering it would imply you can nominate a colleague who has not agreed to
 * prove their identity.
 */
export async function declareSignatory(formData: FormData): Promise<KybResult> {
  const orgId = String(formData.get("orgId") ?? "");

  try {
    const organisation = await api<OrganisationView>(
      `/v1/kyb/organisations/${orgId}/signatory`,
      { method: "POST", body: {} },
    );
    revalidatePath("/commercial");
    return { organisation };
  } catch (error) {
    return failed(error);
  }
}

export async function submitKyb(formData: FormData): Promise<KybResult> {
  const orgId = String(formData.get("orgId") ?? "");

  try {
    const organisation = await api<OrganisationView>(
      `/v1/kyb/organisations/${orgId}/submit`,
      { method: "POST", body: {} },
    );
    revalidatePath("/commercial");
    return { organisation };
  } catch (error) {
    return failed(error);
  }
}
