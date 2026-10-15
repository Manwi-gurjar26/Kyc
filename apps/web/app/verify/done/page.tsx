import { api, currentUserId, type KycStatusView } from "../../../lib/api";
import { StepBar } from "../../StepBar";

/**
 * The finished state.
 *
 * Read from the record rather than from whatever the previous screen believed.
 * The decision is made on the server by decideKyc(), and a page that congratulated
 * somebody on the strength of a form submit would be telling them an outcome
 * nothing had decided yet.
 */
export const metadata = {
  title: "Identity verified · KiloWattX",
};

const TONE: Record<string, { mark: string; title: string; sub: string }> = {
  VERIFIED: {
    mark: "✓",
    title: "Identity verified",
    sub: "KYC is done once and reused across all your roles. Next, link your electricity connection.",
  },
  MANUAL_REVIEW: {
    mark: "!",
    title: "A colleague is checking this",
    sub: "Nothing is wrong. Something did not line up neatly enough to decide automatically, so a person will — usually within a working day.",
  },
  REJECTED: {
    mark: "×",
    title: "We could not verify you",
    sub: "See the reasons below. Some of these can be corrected and tried again.",
  },
  IN_PROGRESS: {
    mark: "…",
    title: "Checking your details",
    sub: "This usually takes under a minute.",
  },
  NOT_STARTED: {
    mark: "–",
    title: "Nothing submitted yet",
    sub: "Start the verification from the beginning.",
  },
  BLOCKED: {
    mark: "×",
    title: "This account is on hold",
    sub: "Please contact support.",
  },
};

export default async function DonePage() {
  const userId = await currentUserId();

  if (!userId) {
    return (
      <div className="flow">
        <StepBar step={1} />
        <h1>Nothing to show yet</h1>
        <p className="flowlead">Start the verification from the beginning.</p>
        <a className="cta" href="/">
          Start →
        </a>
      </div>
    );
  }

  const status = await api<KycStatusView>("/v1/kyc/me").catch(() => null);
  const tone = TONE[status?.status ?? "NOT_STARTED"] ?? TONE.NOT_STARTED!;

  return (
    <div className="flow">
      <StepBar step={4} />

      <div className="bigtick" aria-hidden="true">
        {tone.mark}
      </div>

      <h1 style={{ textAlign: "center" }}>{tone.title}</h1>
      <p className="flowlead" style={{ textAlign: "center" }}>
        {tone.sub}
      </p>

      {status?.aadhaarLast4 && (
        <div className="donerow">
          <div>
            <div className="dt">Aadhaar</div>
            <div className="dd">⋯⋯ {status.aadhaarLast4}</div>
          </div>
          <span className="dstate">Linked</span>
        </div>
      )}

      {status?.panLast4 && (
        <div className="donerow">
          <div>
            <div className="dt">PAN</div>
            <div className="dd">••••••{status.panLast4}</div>
          </div>
          <span className="dstate">Verified</span>
        </div>
      )}

      {/*
        The reasons are shown on any outcome that has them, not only a refusal.
        A verified record can still carry a flag worth reading.
      */}
      {status && status.reasonCodes.length > 0 && (
        <ul className="reasons" style={{ marginTop: 14 }}>
          {status.reasonCodes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
      )}

      <a className="cta" href="/status">
        See the full status →
      </a>

      <p className="secure">
        <span aria-hidden="true">🔒</span> Stored encrypted, retained as long as
        the law requires and no longer
      </p>
    </div>
  );
}
