# DigiLocker migration — design

**Status:** proposed, awaiting review
**Date:** 21 October 2026

Replaces Aadhaar OKYC, which has been returning `503 Source Unavailable` on
live keys since 16 October and whose endpoint Sandbox's own documentation
records as deprecated by UIDAI.

---

## 1. Why

OKYC is not coming back on its own. The evidence, gathered over five days:

| | |
|---|---|
| `/authenticate` | 200 throughout |
| `/okyc/otp/verify` with a bogus `reference_id` | **200**, "Invalid reference_id" |
| `/okyc/otp/verify` with a real reference | **503** `Source Unavailable` |
| `/okyc/otp` (generate) | **503** `Source Unavailable` since 16 Oct 17:15 |

The split is the whole diagnosis: calls Sandbox answers by itself succeed;
calls that must cross to UIDAI fail. Our credentials, host, entity and request
body are all accepted. Nothing on our side is wrong, and nothing on our side
can fix it.

Sandbox's OKYC documentation carries:

> **Deprecation Notice:** This Aadhaar verification endpoint has been
> deprecated by UIDAI. For a more compliant and reliable verification process,
> we recommend migrating to the DigiLocker-based verification flow.

**DigiLocker is confirmed working on the existing live key.** A session
initiated on 21 October returned 200 with a real government authorization URL
at `digilocker.meripehchaan.gov.in`. No new vendor, no new contract, no new
credential. That is the single fact that makes this a migration rather than a
procurement.

## 2. What the flow becomes

```
1. POST /kyc/digilocker/sessions/init
     { "@entity": "in.co.sandbox.kyc.digilocker.session.request",
       "flow": "signin", "redirect_url": <ours>, "doc_types": ["aadhaar"] }
   -> { "authorization_url": "https://digilocker.meripehchaan.gov.in/...",
        "session_id": "f1bd0342-..." }

2. The person goes to authorization_url.

3. They authenticate AT DIGILOCKER — Aadhaar OTP happens on the
   government's own site — and consent to share the document.

4. DigiLocker -> Sandbox's callback -> our redirect_url.

5. GET /kyc/digilocker/sessions/{session_id}/status  -> status
   then fetch the document / user profile for name, date of birth, photo.
```

### The consequence that matters most

**The Aadhaar number never enters this system.** Not in a request body, not in
a form field, not in memory between two calls. The OTP is handled by UIDAI
through DigiLocker, on a government domain, under the person's own DigiLocker
account.

Everything we built to handle an Aadhaar number carefully — the Verhoeff check
at the boundary, the "capture last4 at send because verify does not return the
number", the challenge table holding a reference id so the number need not be
held, the attempt limiting, the refund-on-outage logic — stops being necessary
because the hazard it guarded is gone. That is a better outcome than making
any of it work.

## 3. How it fits what exists

This is the hosted-session shape, which `KycProvider` already describes:

```ts
createSession(request): Promise<KycSession>   // -> hostedUrl
fetchResult(vendorSessionId): Promise<VendorKycResult>
```

`SandboxKycProvider` throws on both today. The API-side machinery for this
path — `POST /v1/kyc/sessions`, the webhook handler, the replay guard, the
outbox, `applyVendorResult` — was deliberately kept when the hosted-vendor web
path was deleted, on the reasoning that "a gateway with a hosted flow is
exactly what the failover slot is for". It is now needed.

`providers.ts` anticipated this explicitly:

> the Aadhaar route decision — DigiLocker, OVSE, or OTP eKYC — is a
> KycProvider implementation detail

So the seam holds. What follows is an adapter and a page, not a redesign.

## 4. The adapter

`packages/integrations/src/sandboxDigiLockerProvider.ts`, implementing
`KycProvider`:

- `createSession()` — POSTs `/sessions/init`, returns `vendorSessionId` =
  their `session_id`, `hostedUrl` = their `authorization_url`, `expiresAt`
  from `consent_valid_till` in that URL where present, otherwise a short
  default.
- `fetchResult()` — GETs `/sessions/{id}/status`, and on a consented session
  fetches the Aadhaar document, mapping into `VendorKycResult.aadhaar`.
- `sendAadhaarOtp()` / `verifyAadhaarOtp()` — **throw**, the way
  `SandboxKycProvider.createSession()` throws today. This gateway has no OTP
  route of its own, and a silent no-op would look like an OTP that was sent.
- `webhookScheme` — `hmac-body`, shared with the other Sandbox adapters.

It reuses `SandboxClient`, so one access token still serves every Sandbox
adapter in the process.

### Selection

`KYC_PROVIDERS` gains `"digilocker"`. It is declared once in `providers.ts`
and read by both the API and the worker config — that array exists precisely
so a new value cannot be added in one place and missed in the other.

`"sandbox"` stays, and stays broken for Aadhaar. It is not deleted, because
the PAN and GSTIN routes on that adapter work and are not deprecated, and
because a vendor restoring OKYC should not require a code change to test.

## 5. API changes

Small, because the endpoints exist.

- `POST /v1/kyc/sessions` already creates a session and returns `hostedUrl`.
  It currently requires `level`, `role`, `consentId` and an idempotency key —
  all of which still apply, and consent still has to be recorded first.
- A return endpoint is needed: the person comes back to us, and we then ask
  the gateway what happened. `POST /v1/kyc/sessions/:id/collect` — fetches the
  result server-to-server and applies it through `applyVendorResult`, which
  already runs `decideKyc()` and writes the decision, the checks and the
  outbox event in one transaction.
- The browser is never trusted to report the outcome. It tells us the person
  came back; we ask the gateway what actually happened. This is the same rule
  the deleted `completeVendorFlow` observed, and it survives the migration.

### `remainingSteps` has a dependency that will break

`statusFor()` decides the Aadhaar step is done by `record.aadhaarLast4`.
DigiLocker may not return the last four digits at all — the document it
shares is the person's Aadhaar record, and a masked number is not guaranteed
in a form we can slice.

`decideFromSteps()` already uses the **reference token** rather than the last
four, on the reasoning that the last four are written when an OTP is merely
requested and prove nothing. `remainingSteps` must move to the same signal.
If the last four are genuinely unavailable, `aadhaar_last4` becomes nullable
in practice and the masked display on the status page loses that detail.

**This needs confirming against a real response before building.**

## 6. Web changes

`/verify/individual` loses its first half:

- the Aadhaar number input, its grouping and Verhoeff hinting — gone
- the OTP input, resend and attempt messaging — gone
- in their place: one "Continue with DigiLocker" button that creates a session
  and navigates to `hostedUrl`

`/verify/digilocker/return` — new. Reads the session from the URL, calls the
collect endpoint, and shows the outcome. It must handle: consent refused, the
person closing the tab and returning later, and a session that has expired.

The selfie and PAN steps are unchanged, and the decision point is unchanged.

## 7. What gets deleted, and when

Not in the first pass. The OTP code stays until a DigiLocker session has been
completed end to end against the live gateway by a real person, because the
only thing worse than a dead Aadhaar route is two of them.

When it goes, it is:

- `sendAadhaarOtp` / `verifyAadhaarOtp` on `KycProvider` and both adapters
- `startAadhaarOtp` / `confirmAadhaarOtp` / `claimChallenge` / `dropChallenge`
  / `refundAttempt` in `KycService`
- `POST /v1/kyc/aadhaar/otp` and `/aadhaar/verify`
- the `aadhaar_otp_challenges` table, by a migration that drops it
- `MAX_OTP_ATTEMPTS`, `OTP_CHALLENGE_MINUTES`, and the fake provider's OTP
  conventions

### In-flight records

Nobody can currently be mid-flow, because the gateway refuses both calls. But
records exist with `aadhaar_last4` written and no `aadhaar_ref_token` — people
who requested an OTP that could never be verified. They are not verified and
must not appear so. They keep `status = IN_PROGRESS` and `AADHAAR` in their
remaining steps, and walking the new flow fills in the rest. No data migration
is required; the absence of a reference token already means "not verified"
everywhere that matters.

## 8. DPDP

This improves the position, which is unusual for a migration.

- **No Aadhaar number, ever.** The strongest control is the one where the data
  never arrives.
- **Consent moves to the government's own screen**, where the person sees
  exactly which documents they are sharing and with whom. Our own consent row
  is still written first — nothing reaches the gateway without it.
- **Biometrics are unchanged and still need a retention rule.** We will still
  hold an Aadhaar photograph and a selfie, and migration 0012 says explicitly
  that retention was not settled by it. This spec does not settle it either.
  It remains the outstanding compliance item and it needs an owner.

## 9. Unknowns

These are the things to confirm against a real response rather than the docs,
because the OKYC field mapping matched the documentation and still cost days:

1. **What the document fetch returns** — the exact field names for name, date
   of birth, photograph, and anything usable as a reference token.
2. **Whether the last four digits are available at all** (see §5).
3. **Whether `status` distinguishes** consent-refused from
   not-finished-yet. The return page needs to tell a person who declined from
   a person who closed the tab.
4. **Session lifetime** — `consent_valid_till` appears in the authorization
   URL; whether the session id outlives it is not documented.
5. **Whether the redirect_url must be registered** with Sandbox or DigiLocker
   for production. `localhost:3000` was accepted at init; that is not proof it
   will be honoured on the return leg.

## 10. Testing

- **Adapter unit tests** against the documented envelopes, with an injected
  client — the pattern already used for the photograph pass-through.
- **A fake DigiLocker provider** so the whole flow is walkable without the
  gateway, as `FakeKycProvider` does today. Its `hostedUrl` points at a local
  stand-in page that returns immediately.
- **e2e** for the API: create session → collect → decision written, mirroring
  `decision.e2e.test.ts`.
- **Driven in a real browser**, which is how the last four bugs in this
  codebase were found. The external hop cannot be driven headlessly, so the
  live leg needs a person.

## 11. Order of work

1. Adapter + unit tests, behind `KYC_PROVIDER=digilocker`. Nothing
   user-facing changes.
2. Confirm the response shapes with one real session. **Needs a person with a
   DigiLocker account.** Resolve §9 before going further.
3. Collect endpoint + e2e tests.
4. Fake DigiLocker provider, so the flow is walkable in development.
5. Web: the new entry point and return page.
6. Only then: delete the OTP path and drop its table.

Steps 1 and 2 are the ones worth doing immediately. Step 2 is the gate: if the
field mapping is not what the documentation implies, the design above changes
before any of it is built on.
