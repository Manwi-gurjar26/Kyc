"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  ApiCallError,
  api,
  clearCurrentUser,
  currentUserId,
  setCurrentUserId,
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
export async function chooseKycType(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const entity = String(formData.get("entity") ?? "");

  /**
   * Reported rather than redirected away from. Bouncing back to this same
   * screen told the person nothing about why their click did nothing.
   */
  if (entity !== "INDIVIDUAL" && entity !== "BUSINESS") {
    return {
      error: {
        code: "ENTITY_REQUIRED",
        message: "Please choose whether you are an individual or a business.",
      },
    };
  }

  /**
   * The session call is the one thing here that can fail, and it used to take
   * the page down with it: an unreachable API threw out of this action and
   * Next.js rendered its error overlay over the form. Returned as a result
   * instead, so the screen stays up and says what happened.
   */
  try {
    await ensureSession();
  } catch (error) {
    if (error instanceof ApiCallError) {
      return { error: { code: error.body.code, message: error.body.message } };
    }
    throw error;
  }

  /**
   * Outside the try on purpose. `redirect()` works by throwing, so catching
   * around it would swallow the navigation and report it as a failure.
   */
  redirect(entity === "INDIVIDUAL" ? "/verify/individual" : "/verify/business");
}

/* ------------------------------------------------------------------ */
/* The KYC flow                                                       */
/* ------------------------------------------------------------------ */

/*
 * The hosted-vendor path is gone, and `beginVerification` and
 * `completeVendorFlow` with it.
 *
 * It opened a vendor session and sent the person off to the vendor's own site
 * to finish — leave our page, come back, webhook reports the outcome. That is
 * a real shape and some gateways offer it, but the one this system runs on
 * does not: Sandbox's Aadhaar OKYC is two server-to-server calls, OTP out and
 * OTP back, which is why `SandboxKycProvider.createSession()` throws rather
 * than returning an empty session.
 *
 * So the button led to a 500 the moment the fake adapter was switched off. One
 * path in, now, through /verify/individual and /verify/business — the OTP is
 * asked for on our own page, which is also the better flow: nobody is sent to
 * a domain they do not recognise in the middle of handing over an Aadhaar
 * number.
 *
 * The API side is deliberately left standing. POST /v1/kyc/sessions, the
 * webhook handler, the replay guard and the outbox are vendor-agnostic, and a
 * gateway with a hosted flow is exactly what the failover slot is for. What is
 * removed here is the route users could walk into, not the capability.
 */

export async function restart(): Promise<void> {
  redirect("/");
}
