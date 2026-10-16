# Support ticket — Aadhaar OKYC verify returns 503 "Source Unavailable"

Everything below is observed, not inferred. Send it as-is; the questions at the
bottom are the ones whose answers decide what we build next.

Replace `<your account email>` and `<your workspace name>` before sending. Do
not paste the API key or secret — they have never been the problem here, and
the `transaction_id` values are what let them find the calls.

---

## To: Sandbox support (support@sandbox.co.in / dashboard ticket)

**Subject:** Aadhaar OKYC — `/kyc/aadhaar/okyc/otp/verify` returns 503 "Source
Unavailable" while `/otp` succeeds. Is OKYC withdrawn, and is DigiLocker the
required path?

Hello,

We are integrating Aadhaar OKYC on live keys and have hit a consistent failure
on the second call. OTP generation works; OTP verification does not.

### What works

`POST /kyc/aadhaar/okyc/otp` on `https://api.sandbox.co.in` returns **200**
with a `reference_id`, and the OTP **does arrive** on the registered mobile.
So our key, host, authentication, entity and request body are all accepted.

### What fails

`POST /kyc/aadhaar/okyc/otp/verify` returns **HTTP 503** with
`"Source Unavailable"`, on every attempt, over roughly an hour:

| Time (IST, 16 Oct 2026) | Result | `transaction_id` |
|---|---|---|
| 12:51:32 | HTTP 503 on verify | not captured |
| 12:59:14 | HTTP 200, `status` reported the OTP as expired — see note below | not captured |
| 13:00:05 | HTTP 503 `Source Unavailable` on verify | not captured |
| 13:50:00 | HTTP 503 `Source Unavailable` on verify | not captured |
| 14:04:04 | HTTP 503 `Source Unavailable` on verify | `7228a8bd-640e-4221-be67-f6078f2cdfa6` |

Please start with `7228a8bd-640e-4221-be67-f6078f2cdfa6` — that is the one call
we can hand you a reference for. Five failures across 73 minutes, all on the
same endpoint, with OTP generation succeeding throughout.

The 12:59 response is worth noting because it proves the endpoint can answer
properly: that one came back 200 and correctly told us the OTP had expired. The
503s are therefore not a malformed request on our side — the same request shape
got a sensible answer once.

### Our request

Exactly as documented, to `https://api.sandbox.co.in/kyc/aadhaar/okyc/otp/verify`:

```json
{
  "@entity": "in.co.sandbox.kyc.aadhaar.okyc.request",
  "reference_id": "<the reference_id returned by /otp>",
  "otp": "<6 digits from the SMS>"
}
```

Headers: `Authorization: <JWT from /authenticate>`, `x-api-key: <live key>`,
`x-api-version: 1.0.0`, `Content-Type: application/json`.

`reference_id` is sent as a **string**. We confirmed that is correct — see the
probe below, where a number is rejected outright.

### The endpoint itself is working

Before writing to you we checked whether the endpoint was responding at all,
by calling verify with a deliberately nonexistent `reference_id` so that no
real verification could take place:

| `reference_id` sent as | Result |
|---|---|
| string `"9999999"` | **HTTP 200**, `data.message` = `"Invalid reference_id"`, `transaction_id` `d6f5e10a-1039-40f9-bbad-1632f64474cf` |
| number `9999999` | **HTTP 400**, `"Invalid request body"`, `transaction_id` `88fb8322-e691-45f5-aa97-e52b3f1e9ff3` |

Two things follow. First, `reference_id` must be a string, which is what we
send. Second, and more usefully: **the endpoint is alive and adjudicating
requests normally.** A bogus reference gets a clean, correct answer.

So the 503 is not the endpoint being down or withdrawn. It appears only when
the call carries a *real* `reference_id` and therefore has to reach UIDAI. A
bogus reference is rejected by your own layer and never gets that far.

That points at the UIDAI leg of the call specifically, which is why our main
question is about entitlement rather than availability.

### What we suspect

Our account can **generate** OTPs — your API accepts the request and a real
SMS is delivered. What it cannot do is **retrieve the eKYC record**. Our
understanding is that the retrieval half is the UIDAI-licensed part, gated by
AUA/KUA onboarding rather than by API access.

If that is what "Source Unavailable" means for an account without that
entitlement, please confirm it, because the current behaviour is expensive to
diagnose: OTP generation succeeds and sends a real SMS to a real person, and
only the second call fails.

### Questions

1. What does 503 "Source Unavailable" mean on
   `/kyc/aadhaar/okyc/otp/verify` specifically? Is it an outage, or is it how
   a missing UIDAI entitlement surfaces?
2. Is our account licensed for Aadhaar eKYC **retrieval**, not just OTP
   generation? If not, what onboarding is required and what is the lead time?
3. Your OKYC documentation carries this notice:

   > **Deprecation Notice:** This Aadhaar verification endpoint has been
   > deprecated by UIDAI. For a more compliant and reliable verification
   > process, we recommend migrating to the DigiLocker-based verification flow.

   Given that, is OKYC still a supported path for a new integration, or should
   we go straight to DigiLocker? If OKYC is being retired, on what date?
4. Should `/otp` succeed and send a real OTP if the verify call cannot
   complete for our account? A successful send that cannot be followed through
   costs us a call and sends a stranger an OTP for nothing.
5. For DigiLocker: does our existing live key cover it, or does it need
   separate onboarding or UIDAI/AUA licensing?
6. Were we billed for the failed verify calls listed above?

### Account

- Account email: `<your account email>`
- Workspace: `<your workspace name>`
- API key prefix: `key_live_09f82ad1…` (full key not included)
- Environment: live host, `https://api.sandbox.co.in`

Thank you,
<your name>

---

## Internal notes — not part of the ticket

### Getting more `transaction_id` values

Their `transaction_id` ties our log line to their record of the call. It was
being discarded on every error, which is why the first four rows have
timestamps and nothing else. `sandboxClient.ts` now appends
`[transaction_id: …]` to gateway errors, and the 14:04 row is the first one
captured.

One id is enough to open the ticket. For more:

```
grep -iE "aadhaar|vendor|transaction_id" <api log> | tail -20
```

### What we already ruled out

- **Credentials** — `/authenticate` returns 200 on both hosts.
- **Wrong host** — fixed earlier; `key_live_` keys now go to
  `api.sandbox.co.in`. A live key against the test host returns 403
  "Use test API key for test environment", which is a different error.
- **Entitlement** — OTP generation succeeds and real SMS arrives, so OKYC is
  not simply switched off at the account level.
- **Our response parsing** — verified against their reference page:
  `data.status === "VALID"`, `data.name`, `data.date_of_birth` as `DD-MM-YYYY`,
  `transaction_id` at the envelope root. The adapter matches. It read their
  "OTP expired" response correctly at 12:59, which demonstrates the parsing works.

### Still unproven

No live verify has ever succeeded, so the **success path** mapping has not been
exercised against a real response. When one succeeds, check that
`nameOnRecord` is the actual name and not empty before trusting it.

### Correction to an earlier conclusion

This document first argued that UIDAI had withdrawn the endpoint and that the
503 was the deprecation taking effect. **That was wrong**, and the probe above
is what disproved it: the endpoint answers a bogus `reference_id` with a clean
HTTP 200 and "Invalid reference_id". A withdrawn endpoint does not do that.

The deprecation notice is real and still matters for planning, but it is not
the cause of this failure. The cause is specific to the UIDAI leg of a verify
call carrying a genuine reference — most likely entitlement, possibly an
outage. Hence the reordered questions.

### If entitlement is the answer, or OKYC is retired

DigiLocker is a redirect flow: initiate a session, send the user to a
DigiLocker URL where they authenticate and consent, then fetch the documents
server-to-server. That is the hosted-session shape the `KycProvider` interface
already describes — `createSession()`, `hostedUrl`, `fetchResult()` — and the
API-side session, webhook, replay-guard and outbox machinery is still in place
for it. The web redirect path was removed and would need rebuilding against
DigiLocker's real URL.

`providers.ts` anticipated this: the Aadhaar route decision between DigiLocker,
OVSE and OTP eKYC was always meant to be a provider implementation detail.
