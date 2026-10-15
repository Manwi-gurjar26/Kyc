"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  ApiCallError,
  api,
  clearCurrentUser,
  currentUserId,
  setCurrentUserId,
  type SessionResponse,
} from "../lib/api";

/**
 * Server actions.
 *
 * Every one of these runs on the server, so the API call carries the identity
 * header without the browser ever seeing or setting it. When Better Auth
 * replaces that header with a real session, nothing in this file changes
 * except `lib/api.ts`.
 */

export interface ActionResult {
  error?: { code: string; message: string };
}

/* ------------------------------------------------------------------ */
/* Identity (development only)                                        */
/* ------------------------------------------------------------------ */

export async function createIdentity(formData: FormData): Promise<ActionResult> {
  const phoneE164 = String(formData.get("phoneE164") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim();

  try {
    const user = await api<{ id: string }>("/v1/dev/users", {
      method: "POST",
      authenticated: false,
      body: { phoneE164, displayName, locale: "en" },
    });
    await setCurrentUserId(user.id);
  } catch (error) {
    if (error instanceof ApiCallError) {
      return { error: { code: error.body.code, message: error.body.message } };
    }
    throw error;
  }

  revalidatePath("/");
  return {};
}

export async function selectIdentity(formData: FormData): Promise<void> {
  const userId = String(formData.get("userId") ?? "");
  if (userId) await setCurrentUserId(userId);
  revalidatePath("/");
}

export async function signOut(): Promise<void> {
  await clearCurrentUser();
  redirect("/");
}

/* ------------------------------------------------------------------ */
/* Starting, for somebody who has just arrived                        */
/* ------------------------------------------------------------------ */

/**
 * Makes sure there is a session, without asking anybody to pick one.
 *
 * The identity picker was development scaffolding standing in for sign-in, and
 * it had no business on the path a real visitor walks: somebody arriving to
 * verify their own Aadhaar cannot choose their row from a list of strangers.
 *
 * So a session is created on the spot. The placeholder phone number is the one
 * dishonest thing left on this path and it is deliberately obvious —
 * +9199xxxxxxxx with random digits — because the real thing is a phone OTP,
 * and the number has to come from that rather than from here. Better Auth
 * replaces this function; nothing else on the flow changes when it does.
 */
async function ensureSession(): Promise<string> {
  const existing = await currentUserId();
  if (existing) return existing;

  const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const user = await api<{ id: string }>("/v1/dev/users", {
    method: "POST",
    authenticated: false,
    body: {
      phoneE164: `+9199${digits}`,
      displayName: null,
      locale: "en",
    },
  });

  await setCurrentUserId(user.id);
  return user.id;
}

/**
 * Step 1: the entity type decides which of the two flows follows.
 *
 * Validated here rather than trusted, because it arrives from a hidden input
 * and chooses which checks somebody is about to be put through.
 */
export async function chooseKycType(formData: FormData): Promise<void> {
  const entity = String(formData.get("entity") ?? "");
  if (entity !== "INDIVIDUAL" && entity !== "BUSINESS") {
    redirect("/");
  }

  await ensureSession();
  redirect(entity === "INDIVIDUAL" ? "/verify/individual" : "/verify/business");
}

/* ------------------------------------------------------------------ */
/* The KYC flow                                                       */
/* ------------------------------------------------------------------ */

/**
 * Records consent, opens a vendor session, and sends the user into the
 * vendor's hosted flow.
 *
 * Consent first, always. Nothing reaches a vendor — and nothing costs us a
 * vendor call — before there is a row saying what the person agreed to and
 * which version of the notice they were shown.
 */
export async function beginVerification(formData: FormData): Promise<ActionResult> {
  const locale = String(formData.get("locale") ?? "en") === "hi" ? "hi" : "en";
  const role = String(formData.get("role") ?? "LAND_OWNER");
  const testScenario = String(formData.get("testScenario") ?? "pass");

  let session: SessionResponse;

  try {
    const consent = await api<{ id: string }>("/v1/kyc/consents", {
      method: "POST",
      body: {
        purpose: "KYC_VERIFICATION",
        noticeVersion: "2.1",
        locale,
      },
    });

    session = await api<SessionResponse>("/v1/kyc/sessions", {
      method: "POST",
      /**
       * A fresh key per genuine attempt. Re-submitting the same form must not
       * open — and bill us for — a second vendor session, which is what the
       * key prevents server-side; generating it here means one key per click.
       */
      idempotencyKey: `web-${randomUUID()}`,
      body: {
        level: "FULL",
        role,
        consentId: consent.id,
        locale,
        testScenario,
      },
    });
  } catch (error) {
    if (error instanceof ApiCallError) {
      return { error: { code: error.body.code, message: error.body.message } };
    }
    throw error;
  }

  /**
   * In production this would be the vendor's own URL on their origin. Here it
   * is a local page standing in for it, so the shape of the flow — leave our
   * site, come back — is the same shape that will ship.
   */
  redirect(`/vendor/${session.vendorSessionId}?locale=${locale}`);
}

/**
 * Completes the vendor's side.
 *
 * Calls the API's dev endpoint, which asks the fake provider for a genuinely
 * signed webhook and feeds it through the real handler: signature check,
 * replay guard, server-to-server fetch, decideKyc(), one transaction. The
 * browser is not trusted to report an outcome, because in production the
 * browser will not be the thing reporting it.
 */
export async function completeVendorFlow(formData: FormData): Promise<ActionResult> {
  const sessionId = String(formData.get("sessionId") ?? "");

  try {
    await api(`/v1/dev/kyc-sessions/${sessionId}/complete`, {
      method: "POST",
      authenticated: false,
    });
  } catch (error) {
    if (error instanceof ApiCallError) {
      return { error: { code: error.body.code, message: error.body.message } };
    }
    throw error;
  }

  redirect("/status");
}

export async function restart(): Promise<void> {
  redirect("/");
}
