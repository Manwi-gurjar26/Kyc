import { api, currentUserId, type KycStatusView } from "../../lib/api";
import { StatusPoller } from "./StatusPoller";

/**
 * The result.
 *
 * Reads the API's own `/v1/kyc/me`, which returns masked values only: the last
 * four digits and reason codes. There is no endpoint that returns a full PAN,
 * and no Aadhaar number exists anywhere to return.
 */

/** Written for the person reading them, not for the developer. */
const REASON_COPY: Record<string, string> = {
  FACE_MATCH_LOW:
    "Your selfie did not match your Aadhaar photo closely enough for us to decide automatically. Aadhaar photos are often years old, so this is common and usually fine.",
  LIVENESS_FAILED:
    "The camera check did not pass. This happens in poor light, or if the camera was pointed at a photo.",
  PAN_NAME_MISMATCH:
    "The name on your PAN does not match your Aadhaar. A name change after marriage is the usual reason.",
  PAN_DOB_MISMATCH:
    "The date of birth on your PAN does not match your Aadhaar.",
  PAN_ALREADY_USED:
    "This PAN is already on another account. Our team can merge the two if both are yours.",
  PAN_NOT_LINKED_TO_AADHAAR:
    "Your PAN is not linked to your Aadhaar. This does not block anything, but it means a higher TDS rate on what you earn.",
  PAN_DEACTIVATED:
    "The Income Tax Department has deactivated this PAN. It has to be reactivated before we can continue.",
  PAN_FAKE: "The Income Tax Department does not recognise this PAN.",
  PAN_INVALID: "That PAN is not valid.",
  AGE_UNDER_18:
    "Your Aadhaar shows you are under 18. An agreement with a minor cannot be enforced, so we cannot continue.",
  AADHAAR_NOT_VERIFIED:
    "Your Aadhaar details did not come back. You can try again, or use the Aadhaar App route if your mobile is not linked to your Aadhaar.",
  DOCUMENT_LOW_CONFIDENCE:
    "Some fields on your documents were hard to read. A colleague will check them.",
  SIGNATORY_NOT_VERIFIED:
    "The person signing still needs to finish their own verification.",
  GST_CANCELLED: "That GST registration is cancelled.",
  GST_SUSPENDED: "That GST registration is suspended.",
  DEVICE_UNTRUSTED: "We could not confirm this device is genuine.",
};

const VERDICTS = {
  VERIFIED: {
    tone: "ok",
    mark: "✓",
    title: "You are verified",
    sub: "Everything checked out. You can go back and carry on where you left off.",
  },
  MANUAL_REVIEW: {
    tone: "warn",
    mark: "!",
    title: "A colleague is looking at this",
    sub: "Nothing is wrong. Something did not line up neatly enough for us to decide automatically, so a person will — usually within a working day.",
  },
  REJECTED: {
    tone: "bad",
    mark: "×",
    title: "We could not verify you",
    sub: "See below for what went wrong. Some of these can be fixed and retried.",
  },
  IN_PROGRESS: {
    tone: "wait",
    mark: "…",
    title: "Checking your details",
    sub: "This usually takes under a minute. You can close this page — we will message you either way.",
  },
  NOT_STARTED: {
    tone: "wait",
    mark: "–",
    title: "Verification has not started",
    sub: "Nothing has been submitted for this identity yet.",
  },
  BLOCKED: {
    tone: "bad",
    mark: "×",
    title: "This account is on hold",
    sub: "Please contact support.",
  },
} as const;

export default async function StatusPage() {
  const userId = await currentUserId();

  if (!userId) {
    return (
      <div className="card">
        <h1>Pick an identity first</h1>
        <p className="lead">There is nobody to show a status for.</p>
        <a className="btn" href="/">
          Go back
        </a>
      </div>
    );
  }

  const status = await api<KycStatusView>("/v1/kyc/me");
  const verdict = VERDICTS[status.status];
  const settled =
    status.status === "VERIFIED" ||
    status.status === "REJECTED" ||
    status.status === "MANUAL_REVIEW";

  return (
    <>
      {/* Only polls while the outcome can still change. */}
      {!settled ? <StatusPoller /> : null}

      <div className="card">
        <p className="eyebrow">Result</p>

        <div className={"verdict " + verdict.tone}>
          <span className="mark">{verdict.mark}</span>
          <span>
            <span className="title">{verdict.title}</span>
            <span className="sub">{verdict.sub}</span>
          </span>
        </div>

        {status.reasonCodes.length > 0 ? (
          <>
            <h2>Why</h2>
            <ul className="reasons">
              {status.reasonCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                  <span>{REASON_COPY[code] ?? "A colleague will look at this."}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <h2>Your record</h2>
        <dl className="kv">
          <div className="kv-row">
            <dt>Status</dt>
            <dd>
              <span
                className={
                  "pill " +
                  (status.status === "VERIFIED"
                    ? "g"
                    : status.status === "REJECTED" || status.status === "BLOCKED"
                      ? "b"
                      : status.status === "MANUAL_REVIEW"
                        ? "r"
                        : "n")
                }
              >
                {status.status}
              </span>
            </dd>
          </div>
          <div className="kv-row">
            <dt>Level</dt>
            <dd>{status.level ?? "—"}</dd>
          </div>
          <div className="kv-row">
            <dt>Aadhaar</dt>
            <dd>
              {status.aadhaarLast4 ? (
                <>
                  <span className="mono">XXXX XXXX {status.aadhaarLast4}</span>
                  <small>
                    the last four digits are all we hold — the full number never
                    reaches our database
                  </small>
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div className="kv-row">
            <dt>PAN</dt>
            <dd>
              {status.panLast4 ? (
                <>
                  <span className="mono">••••••{status.panLast4}</span>
                  <small>stored encrypted; only the last four are ever shown</small>
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
          {status.remainingSteps.length > 0 ? (
            <div className="kv-row">
              <dt>Still to do</dt>
              <dd>{status.remainingSteps.join(", ")}</dd>
            </div>
          ) : null}
          {status.verifiedAt ? (
            <div className="kv-row">
              <dt>Verified at</dt>
              <dd className="mono">{status.verifiedAt}</dd>
            </div>
          ) : null}
        </dl>

        <div className="btnrow">
          <a className="btn ghost" href="/">
            Start again with another identity
          </a>
        </div>
      </div>

      <p className="footnote">
        {settled
          ? "This status was written by the server after it fetched the result from the vendor and ran decideKyc(). The browser did not decide it."
          : "This page re-checks every two seconds. In production a WebSocket pushes the change instead, and a reconciliation job sweeps sessions that are stuck here because a webhook never arrived."}
      </p>
    </>
  );
}
