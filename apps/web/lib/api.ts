import { cookies } from "next/headers";

/**
 * Server-side API client.
 *
 * Every call to the NestJS API happens on the server, never from the browser.
 * Three reasons, in order of how much they matter:
 *
 *  1. The development identity header would otherwise be set by the browser,
 *     which means anyone could send any user id. It is bad enough that this
 *     header exists; letting the client control it would be worse.
 *  2. There is no CORS to configure, and no API origin exposed to the page.
 *  3. When Better Auth replaces the header with a session cookie, this is the
 *     only file that changes.
 */

export const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

const USER_COOKIE = "kwx_dev_user";
const ROLES_COOKIE = "kwx_dev_roles";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(`${body.code}: ${body.message}`);
    this.name = "ApiCallError";
  }
}

export async function currentUserId(): Promise<string | null> {
  const store = await cookies();
  return store.get(USER_COOKIE)?.value ?? null;
}

export async function setCurrentUserId(userId: string): Promise<void> {
  const store = await cookies();
  store.set(USER_COOKIE, userId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
}

export async function clearCurrentUser(): Promise<void> {
  const store = await cookies();
  store.delete(USER_COOKIE);
  store.delete(ROLES_COOKIE);
}

/**
 * Staff roles, development only.
 *
 * Better Auth will carry these in the session after Google Workspace SSO and
 * MFA. Until then they are picked from a dropdown, which is exactly as
 * trustworthy as it sounds — hence the API refusing to run its header-based
 * session guard in production at all.
 */
export async function currentStaffRoles(): Promise<string[]> {
  const store = await cookies();
  const raw = store.get(ROLES_COOKIE)?.value ?? "";
  return raw.split(",").map((r) => r.trim()).filter(Boolean);
}

export async function setStaffRoles(roles: string[]): Promise<void> {
  const store = await cookies();
  if (roles.length === 0) {
    store.delete(ROLES_COOKIE);
    return;
  }
  store.set(ROLES_COOKIE, roles.join(","), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
}

interface CallOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Required on every create. The API rejects a request without one. */
  idempotencyKey?: string;
  /** Send the identity header. Off for endpoints that take no session. */
  authenticated?: boolean;
}

/**
 * Calls the API and throws ApiCallError on a non-2xx, carrying the API's own
 * `{ code, message, details }` so pages can branch on the code.
 */
export async function api<T>(path: string, options: CallOptions = {}): Promise<T> {
  const { method = "GET", body, idempotencyKey, authenticated = true } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  if (authenticated) {
    const userId = await currentUserId();
    if (!userId) {
      throw new ApiCallError(401, {
        code: "AUTH_REQUIRED",
        message: "Pick an identity first.",
      });
    }
    headers["x-dev-user-id"] = userId;

    const roles = await currentStaffRoles();
    if (roles.length > 0) headers["x-dev-staff-roles"] = roles.join(",");
  }

  let response: Response;

  /**
   * A dead API must arrive as an ApiCallError like everything else.
   *
   * `fetch` throws a bare TypeError("fetch failed") when nothing is listening,
   * and that is not an ApiCallError — so every caller's `catch (error) { if
   * (error instanceof ApiCallError) ... }` let it straight through and the
   * server action crashed the page. What the user saw was a red Next.js
   * overlay pointing at the <form> in ChooseKycType, which is the one place
   * the problem is not: the API was simply not running.
   */
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      /** KYC status changes constantly; a cached answer is always wrong. */
      cache: "no-store",
    });
  } catch (error) {
    throw new ApiCallError(503, {
      code: "API_UNREACHABLE",
      message:
        "Could not reach the verification service. Please try again in a moment.",
      /** The operator needs the address and the cause; the user does not. */
      details: {
        apiBase: API_BASE,
        path,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }

  const text = await response.text();

  /**
   * Parsed in a try for the same reason: a proxy or a crashed process answers
   * with HTML, and a raw SyntaxError hides both the status and the body.
   */
  let parsed: unknown;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new ApiCallError(502, {
      code: "API_BAD_RESPONSE",
      message: "The verification service returned an unreadable response.",
      details: { apiBase: API_BASE, path, status: response.status, body: text.slice(0, 500) },
    });
  }

  if (!response.ok) {
    throw new ApiCallError(
      response.status,
      (parsed as ApiErrorBody) ?? {
        code: "UNKNOWN",
        message: `API returned ${response.status}`,
      },
    );
  }

  return parsed as T;
}

/* ------------------------------------------------------------------ */
/* Response shapes                                                    */
/* ------------------------------------------------------------------ */

export interface KycStatusView {
  status:
    | "NOT_STARTED"
    | "IN_PROGRESS"
    | "MANUAL_REVIEW"
    | "VERIFIED"
    | "REJECTED"
    | "BLOCKED";
  level: string | null;
  aadhaarLast4: string | null;
  panLast4: string | null;
  reasonCodes: string[];
  remainingSteps: string[];
  verifiedAt: string | null;
  /**
   * How this deployment collects an Aadhaar.
   *
   * "OTP" takes a number and exchanges a code; "HOSTED" sends the person to
   * the gateway's own site and never sees a number. The first screen differs
   * entirely between them, so the page asks rather than assumes.
   */
  aadhaarRoute: "OTP" | "HOSTED";
}

export interface DevUser {
  id: string;
  phoneE164: string;
  displayName: string | null;
  locale: string;
  createdAt: string;
}

/*
 * `SessionResponse` and `Scenario` lived here and are gone with the
 * hosted-vendor path: one described the POST /v1/kyc/sessions reply, the other
 * the test-scenario picker on the form that opened it. The API still serves
 * both endpoints — see the note in app/actions.ts — but nothing in this app
 * calls them, and a response type for a call nobody makes reads as a feature
 * that is still wired up.
 */
