import Link from "next/link";
import { collectHostedAadhaar } from "../../verify/actions";
import { StepBar } from "../../StepBar";

/**
 * Where a hosted gateway sends somebody back to.
 *
 * The path is whatever KYC_REDIRECT_URL says, and it is deliberately generic
 * rather than named after DigiLocker: the server hands the gateway this URL,
 * and any hosted provider — DigiLocker now, a failover later — returns here.
 * The page itself does not care which it was.
 *
 * WHAT THIS PAGE IS NOT ALLOWED TO DO: believe the URL it was opened with.
 * A gateway appends its own parameters and anybody can type them, so an
 * `outcome=approved` in the query means only that somebody navigated here
 * with it. The outcome is fetched from the server, which asks the gateway.
 * The query string is used for exactly one thing — knowing which session to
 * ask about — and even that is checked against the signed-in person's own
 * record before anything is collected.
 */

export const metadata = {
  title: "Finishing your verification · KiloWattX",
};

/** What the person is told, per decided status. */
const OUTCOME: Record<string, { heading: string; lead: string }> = {
  VERIFIED: {
    heading: "You are verified",
    lead: "Your identity has been confirmed. Nothing further is needed from you.",
  },
  MANUAL_REVIEW: {
    heading: "With a reviewer now",
    lead:
      "Everything you sent has arrived. A person checks the parts we cannot " +
      "check automatically, which usually takes a working day.",
  },
  REJECTED: {
    heading: "We could not verify you",
    lead:
      "The checks did not pass. If you think that is wrong, contact support " +
      "and quote the date and time.",
  },
  IN_PROGRESS: {
    heading: "Not finished yet",
    lead:
      "We have not received a completed verification for this session. If you " +
      "closed DigiLocker before sharing, you can start again.",
  },
};

export default async function HostedReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string; outcome?: string }>;
}) {
  const { session, outcome } = await searchParams;

  /**
   * No session to ask about. This is the "closed the tab and came back to an
   * old link" case, and it is not an error worth alarming anybody with.
   */
  if (!session) {
    return (
      <div className="flow">
        <StepBar step={2} back="/" />
        <h1>Nothing to finish</h1>
        <p className="flowlead">
          This page needs a verification session to check on, and there is none
          in the link you followed. Starting again takes a moment.
        </p>
        <Link className="cta" href="/verify/individual">
          Start again →
        </Link>
      </div>
    );
  }

  /**
   * Collected even when the gateway said "declined" on its way back.
   *
   * The server has to ask either way: a decline is an answer about this
   * session, and taking the browser's word for it would mean a page that
   * reports a refusal the gateway never issued.
   */
  const collected = await collectHostedAadhaar(session);

  if (collected.error) {
    const declined = outcome === "declined";
    return (
      <div className="flow">
        <StepBar step={2} back="/" />
        <h1>{declined ? "You did not share your Aadhaar" : "We could not finish that"}</h1>
        <p className="flowlead">
          {declined
            ? "Nothing was shared, and nothing has been recorded against you. " +
              "You can start again whenever you are ready."
            : collected.error.message}
        </p>
        <div className="alert" role="alert">
          <strong>{collected.error.code}</strong> — {collected.error.message}
        </div>
        <Link className="cta" href="/verify/individual">
          Try again →
        </Link>
      </div>
    );
  }

  const status = collected.status ?? "IN_PROGRESS";
  const copy = OUTCOME[status] ?? OUTCOME.IN_PROGRESS!;

  return (
    <div className="flow">
      <StepBar step={2} back="/" />

      <p className="stepnote">Step 2 of 4 · KYC</p>
      <h1>{copy.heading}</h1>
      <p className="flowlead">{copy.lead}</p>

      {collected.reasonCodes && collected.reasonCodes.length > 0 && (
        <div className="card">
          <p className="hint" style={{ marginTop: 0 }}>
            What the reviewer will look at
          </p>
          <ul>
            {collected.reasonCodes.map((code) => (
              <li key={code} className="mono">
                {code}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        On to the rest of it. Aadhaar is only the first of three steps, and a
        person who has just come back from a government site has no way of
        knowing that unless this says so.
      */}
      <Link className="cta" href={status === "IN_PROGRESS" ? "/verify/individual" : "/status"}>
        {status === "IN_PROGRESS" ? "Continue — PAN and a photo →" : "See where you stand →"}
      </Link>

      <p className="footnote">
        Your Aadhaar number was never sent to us. You signed in to DigiLocker
        and chose to share it there, and we received only what you agreed to —
        a name, a date of birth and a photograph.
      </p>
    </div>
  );
}
