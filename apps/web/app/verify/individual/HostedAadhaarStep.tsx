"use client";

import { useState, useTransition } from "react";
import { startHostedAadhaar } from "../actions";

/**
 * The Aadhaar step, when the gateway collects it on its own site.
 *
 * There is no number field here and there will never be one. The person signs
 * in to their own DigiLocker account, UIDAI sends them a one-time password
 * there, and they choose what to share with us. We receive a name, a date of
 * birth and a photograph — and no Aadhaar number, because none is sent.
 *
 * That is worth saying on the screen rather than only in a comment. Somebody
 * being asked to prove their identity is entitled to know which of the two
 * things is happening, and "you will not type your Aadhaar number anywhere"
 * is the most reassuring true sentence available here.
 *
 * The button opens a session — which costs a paid call — so it is disabled
 * while one is in flight. A double click must not open two.
 */
export function HostedAadhaarStep() {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function begin() {
    setError(null);
    start(async () => {
      const result = await startHostedAadhaar();

      if (result.error || !result.hostedUrl) {
        setError(result.error?.message ?? "We could not start that just now.");
        return;
      }

      /**
       * A full-page navigation, not a router push: the destination is a
       * government site on another origin, and the person has to see the
       * address bar change to it. That is the one moment they can check they
       * are really at DigiLocker, and routing around it would take that away.
       */
      window.location.href = result.hostedUrl;
    });
  }

  return (
    <div className="frow">
      <div className="frow-top">
        <label>Aadhaar</label>
        <span className="tag">At DigiLocker</span>
      </div>

      <div className="card">
        <p style={{ marginTop: 0 }}>
          You will be taken to <strong>DigiLocker</strong>, the government&rsquo;s
          own service, to sign in and choose whether to share your Aadhaar with
          us.
        </p>
        <p className="hint">
          You will not type your Aadhaar number here, or anywhere on this site.
          The one-time password comes from UIDAI and is entered on their page.
          We receive your name, date of birth and photograph — and no number.
        </p>
      </div>

      <button className="cta" type="button" onClick={begin} disabled={pending}>
        {pending ? "Opening DigiLocker…" : "Continue with DigiLocker →"}
      </button>

      {error && (
        <div className="alert" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <p className="footnote">
        Check the address bar says <span className="mono">digilocker.meripehchaan.gov.in</span>{" "}
        before you sign in. No legitimate service will ask for your DigiLocker
        password anywhere else.
      </p>
    </div>
  );
}
