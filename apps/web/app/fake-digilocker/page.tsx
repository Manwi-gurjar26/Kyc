import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * A stand-in for DigiLocker, so the hosted flow can be walked without it.
 *
 * The real thing is digilocker.meripehchaan.gov.in, where somebody signs in
 * to their own DigiLocker account, is sent a UIDAI one-time password, and
 * consents to share their Aadhaar. None of that can be rehearsed in
 * development: it needs a real account, a real handset and a government
 * service that is currently refusing our calls.
 *
 * What this page rehearses is the only part that is ours — leaving the site
 * and coming back. That is where a hosted flow actually breaks: a redirect
 * that loses the session id, a return page that cannot tell "declined" from
 * "closed the tab", a person who presses back. Those are our bugs and this is
 * where they are found.
 *
 * DELIBERATELY NOT CONVINCING. It does not borrow DigiLocker's colours, logo
 * or wording, and it says what it is at the top in a banner nobody could miss.
 * A faithful imitation of a government login page is a phishing page that
 * happens to be checked into our repository — and the one habit worth
 * protecting in anybody testing this is suspicion of screens asking for
 * Aadhaar.
 *
 * Refuses to render outside development, like every other fake in this
 * system. See LocalDiskBucket and the fake document scanner.
 */

export const metadata = {
  title: "Stand-in for DigiLocker · KiloWattX",
};

export default async function FakeDigiLockerPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string; redirect_url?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const { session, redirect_url: redirectUrl } = await searchParams;

  if (!session || !redirectUrl) {
    return (
      <div className="flow">
        <h1>Nothing to approve</h1>
        <p className="flowlead">
          This stand-in was opened without a session. Start the verification
          again from the beginning.
        </p>
        <Link className="btn" href="/">
          Back to the start
        </Link>
      </div>
    );
  }

  /**
   * Both outcomes carry the session id back, because the return page has to
   * ask the gateway about a specific session either way — a decline is an
   * answer, not an absence.
   */
  const back = (outcome: "approved" | "declined") => {
    const url = new URL(redirectUrl);
    url.searchParams.set("session", session);
    url.searchParams.set("outcome", outcome);
    return url.toString();
  };

  return (
    <div className="flow">
      <div className="alert" role="status">
        <strong>This is not DigiLocker.</strong> It is a stand-in used in
        development, so the leave-and-return half of the flow can be tested.
        The real one lives at digilocker.meripehchaan.gov.in and is the only
        place you should ever enter a DigiLocker password.
      </div>

      <p className="stepnote">Stand-in · not a government service</p>
      <h1>Share your Aadhaar?</h1>
      <p className="flowlead">
        On the real DigiLocker you would sign in, receive a one-time password
        from UIDAI, and choose whether to share your Aadhaar with KiloWattX.
        Here you simply pick the outcome.
      </p>

      <div className="card">
        <p className="hint" style={{ marginTop: 0 }}>
          Session
          <br />
          <span className="mono">{session}</span>
        </p>
        <p className="hint">
          Returning to
          <br />
          <span className="mono">{redirectUrl}</span>
        </p>
      </div>

      <a className="cta" href={back("approved")}>
        Approve and return →
      </a>

      <a className="btn ghost" href={back("declined")} style={{ marginTop: 10 }}>
        Decline
      </a>

      <p className="footnote">
        Nothing is shared and nothing is verified. The outcome recorded against
        this session is decided by the fake gateway from the session id, not by
        which button you press here — the buttons choose how you come back, and
        the server still asks the gateway what happened. That is the rule being
        rehearsed: the browser never reports the result.
      </p>
    </div>
  );
}
