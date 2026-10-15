"use client";

import { useActionState, useState } from "react";
import type { KybExample, OrganisationView } from "../../lib/kybTypes";
import {
  declareSignatory,
  forgetOrg,
  lookUpGstin,
  recordCompanyRegister,
  submitKyb,
  type KybResult,
} from "./actions";

/**
 * The business check, rendered from the server's own view of it.
 *
 * `remainingSteps` is the state machine. This component decides nothing about
 * which steps exist — a proprietorship has no company register, and the API is
 * what knows that. A second copy of the rules here would eventually disagree
 * with the one that decides.
 */

const GST_STATUS_TONE: Record<string, string> = {
  ACTIVE: "g",
  CANCELLED: "b",
  SUSPENDED: "b",
  UNKNOWN: "n",
};

const COMPANY_STATUS_COPY: Record<string, string> = {
  ACTIVE: "Active on the MCA register",
  STRUCK_OFF: "Struck off the register — this company no longer legally exists",
  UNDER_LIQUIDATION: "Under liquidation",
  DORMANT: "Dormant — a colleague will look at this",
};

const VERDICTS: Record<string, { tone: string; mark: string; title: string; sub: string }> = {
  VERIFIED: {
    tone: "ok",
    mark: "✓",
    title: "Your business is verified",
    sub: "The power purchase agreement is open for signing, and your invoices will carry this GSTIN.",
  },
  MANUAL_REVIEW: {
    tone: "warn",
    mark: "!",
    title: "Our legal team is reading this",
    sub: "Something did not line up neatly enough to decide automatically. Nobody automates who may bind a company for twenty-five years.",
  },
  REJECTED: {
    tone: "bad",
    mark: "×",
    title: "We cannot verify this business",
    sub: "See the detail below. Some of these can be fixed and resubmitted.",
  },
};

export function KybFlow({
  organisation,
  examples,
}: {
  organisation: OrganisationView | null;
  examples: KybExample[];
}) {
  if (!organisation) {
    return <GstinStep examples={examples} />;
  }

  const settled =
    organisation.kybStatus === "VERIFIED" ||
    organisation.kybStatus === "REJECTED" ||
    organisation.kybStatus === "MANUAL_REVIEW";

  return (
    <>
      <BusinessSummary organisation={organisation} />

      {settled ? (
        <Verdict organisation={organisation} />
      ) : (
        <>
          {organisation.remainingSteps.includes("COMPANY_REGISTER") ? (
            <CompanyRegisterStep organisation={organisation} examples={examples} />
          ) : null}

          {organisation.remainingSteps.includes("SIGNATORY") ? (
            <SignatoryStep organisation={organisation} />
          ) : null}

          {organisation.remainingSteps.includes("SIGNATORY_PERSONAL_KYC") ? (
            <SignatoryKycStep organisation={organisation} />
          ) : null}

          {organisation.remainingSteps.length === 0 ? (
            <SubmitStep organisation={organisation} />
          ) : null}
        </>
      )}

      <form action={forgetOrg}>
        <button className="btn ghost" type="submit" style={{ marginTop: 20 }}>
          Start with a different GSTIN
        </button>
      </form>
    </>
  );
}

/* ------------------------------------------------------------------ */

function GstinStep({ examples }: { examples: KybExample[] }) {
  const [gstin, setGstin] = useState("");
  const [state, submit, pending] = useActionState<KybResult, FormData>(
    async (_prev, formData) => lookUpGstin(formData),
    {},
  );

  return (
    <div className="card">
      <p className="eyebrow">Step 2 · Your GST number</p>
      <h1>One number is all we need</h1>
      <p className="lead">
        Your GSTIN tells us your legal name, your constitution, your state and
        your business PAN. There is nothing else to type — and nothing else for
        you to get wrong.
      </p>

      {state.error ? (
        <div className="alert" role="alert">
          <strong>{state.error.code}</strong> — {state.error.message}
        </div>
      ) : null}

      <form action={submit}>
        <div className="field">
          <label htmlFor="gstin">GSTIN</label>
          <input
            id="gstin"
            name="gstin"
            type="text"
            required
            maxLength={15}
            autoComplete="off"
            placeholder="08AADCS9012F1ZH"
            value={gstin}
            onChange={(event) =>
              setGstin(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ""))
            }
          />
          <p className="hint">
            15 characters · the last one is a checksum we verify before spending
            a lookup
            {gstin.length >= 12 ? ` · chars 3–12 are your business PAN` : ""}
          </p>
        </div>

        <button className="btn" type="submit" disabled={pending || gstin.length !== 15}>
          {pending ? "Looking it up…" : "Look up my business"}
        </button>
      </form>

      {examples.length > 0 ? (
        <>
          <h2>Identifiers that will actually validate</h2>
          <p className="lead" style={{ fontSize: 13.5 }}>
            A GSTIN carries a mod-36 check digit, so an invented one is rejected
            before any lookup happens. These are computed by the API from the
            fake provider&rsquo;s own derivation, so they cannot drift from what
            the lookups will say.
          </p>

          <div className="choices">
            {examples.map((example, index) => (
              <button
                type="button"
                key={`${example.gstin}-${index}`}
                className="choice"
                aria-pressed={gstin === example.gstin}
                onClick={() => setGstin(example.gstin)}
              >
                <span className="radio" />
                <span>
                  <span className="ct">{example.label}</span>
                  <span className="cd">
                    <span className="mono">{example.gstin}</span>
                    {example.cin ? (
                      <>
                        {" · CIN "}
                        <span className="mono">{example.cin}</span>
                      </>
                    ) : null}
                    <br />
                    ends as {example.outcome}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function BusinessSummary({ organisation }: { organisation: OrganisationView }) {
  return (
    <div className="card">
      <p className="eyebrow">From the GST registry</p>
      <h1>{organisation.legalName}</h1>

      <dl className="kv">
        <div className="kv-row">
          <dt>GSTIN</dt>
          <dd>
            <span className="mono">{organisation.gstin}</span>
            <small>
              characters 3 to 12 are your business PAN, so we never ask for it
              separately
            </small>
          </dd>
        </div>
        <div className="kv-row">
          <dt>Registration</dt>
          <dd>
            <span className={"pill " + (GST_STATUS_TONE[organisation.gstStatus] ?? "n")}>
              {organisation.gstStatus}
            </span>
            {organisation.gstStatus !== "ACTIVE" ? (
              <small>
                A cancelled or suspended registration cannot carry a valid B2B
                invoice, so this will be rejected on submission.
              </small>
            ) : null}
          </dd>
        </div>
        <div className="kv-row">
          <dt>Constitution</dt>
          <dd>
            {organisation.constitution ?? "—"}
            <small>
              {organisation.requiresCompanyRegister
                ? "so we also check the MCA company register"
                : "no company register applies"}
            </small>
          </dd>
        </div>
        <div className="kv-row">
          <dt>Business PAN</dt>
          <dd>
            <span className="mono">••••••{organisation.businessPanLast4 ?? "----"}</span>
            <small>taken out of the GSTIN and verified</small>
          </dd>
        </div>
        {organisation.cinOrLlpin ? (
          <div className="kv-row">
            <dt>Company</dt>
            <dd>
              <span className="mono">{organisation.cinOrLlpin}</span>
              {organisation.companyStatus ? (
                <small>
                  {COMPANY_STATUS_COPY[organisation.companyStatus] ??
                    organisation.companyStatus}
                </small>
              ) : null}
            </dd>
          </div>
        ) : null}
        <div className="kv-row">
          <dt>Business check</dt>
          <dd>
            <span
              className={
                "pill " +
                (organisation.kybStatus === "VERIFIED"
                  ? "g"
                  : organisation.kybStatus === "REJECTED"
                    ? "b"
                    : organisation.kybStatus === "MANUAL_REVIEW"
                      ? "r"
                      : "n")
              }
            >
              {organisation.kybStatus}
            </span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CompanyRegisterStep({
  organisation,
  examples,
}: {
  organisation: OrganisationView;
  examples: KybExample[];
}) {
  const [cin, setCin] = useState("");
  const [state, submit, pending] = useActionState<KybResult, FormData>(
    async (_prev, formData) => recordCompanyRegister(formData),
    {},
  );

  const suggestion = examples.find((e) => e.gstin === organisation.gstin && e.cin);

  return (
    <div className="card">
      <p className="eyebrow">Still to do · company register</p>
      <h1>Confirm the company</h1>
      <p className="lead">
        You are a {organisation.constitution?.toLowerCase() ?? "registered company"},
        so we also check you against the Ministry of Corporate Affairs register.
        An active GST registration does not tell us whether the company still
        exists — and a company that has been struck off cannot be bound by a
        twenty-five year agreement.
      </p>

      {state.error ? (
        <div className="alert" role="alert">
          <strong>{state.error.code}</strong> — {state.error.message}
        </div>
      ) : null}

      <form action={submit}>
        <input type="hidden" name="orgId" value={organisation.id} />

        <div className="field">
          <label htmlFor="cin">CIN</label>
          <input
            id="cin"
            name="cin"
            type="text"
            required
            maxLength={21}
            autoComplete="off"
            placeholder="U17299RJ2017PTC058441"
            value={cin}
            onChange={(event) =>
              setCin(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ""))
            }
          />
          <p className="hint">
            21 characters · L or U, industry, state, year, class, number
          </p>
        </div>

        {suggestion?.cin ? (
          <button
            type="button"
            className="btn ghost"
            style={{ marginBottom: 16 }}
            onClick={() => setCin(suggestion.cin!)}
          >
            Use the matching example CIN
          </button>
        ) : null}

        <div className="btnrow" style={{ marginTop: 0 }}>
          <button className="btn" type="submit" disabled={pending || cin.length !== 21}>
            {pending ? "Checking the register…" : "Check the company register"}
          </button>
        </div>
      </form>

      <p className="footnote">
        An LLP would give an LLPIN instead. That lookup is not built yet, and
        the API says so rather than storing the number and deciding as though it
        had been checked.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SignatoryStep({ organisation }: { organisation: OrganisationView }) {
  const [state, submit, pending] = useActionState<KybResult, FormData>(
    async (_prev, formData) => declareSignatory(formData),
    {},
  );

  return (
    <div className="card">
      <p className="eyebrow">Still to do · who signs</p>
      <h1>Will you be signing?</h1>
      <p className="lead">
        A twenty-five year agreement is only safe if the right person signs it.
        The signatory verifies their own identity — Aadhaar, PAN and a selfie —
        and shows what gives them the authority to bind the company.
      </p>

      {state.error ? (
        <div className="alert" role="alert">
          <strong>{state.error.code}</strong> — {state.error.message}
        </div>
      ) : null}

      <form action={submit}>
        <input type="hidden" name="orgId" value={organisation.id} />
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Recording…" : "Yes, I will be signing"}
        </button>
      </form>

      <p className="footnote">
        There is deliberately no way to nominate a colleague here. That would be
        asserting authority over somebody who has not agreed to prove their own
        identity — and the point of this step is that the person signing proves
        theirs.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SignatoryKycStep({ organisation }: { organisation: OrganisationView }) {
  const status = organisation.signatory?.personalKycStatus ?? "NOT_STARTED";

  return (
    <div className="card">
      <p className="eyebrow">Still to do · your own verification</p>
      <h1>Verify yourself as the signatory</h1>
      <p className="lead">
        The business side is in hand. What is left is your own identity, which
        is exactly the same check an individual does — and it is a separate
        gate, so a sound company whose signatory is unverified is not a verified
        business.
      </p>

      <dl className="kv" style={{ marginBottom: 20 }}>
        <div className="kv-row">
          <dt>Your KYC</dt>
          <dd>
            <span
              className={
                "pill " +
                (status === "VERIFIED"
                  ? "g"
                  : status === "REJECTED"
                    ? "b"
                    : status === "MANUAL_REVIEW"
                      ? "r"
                      : "n")
              }
            >
              {status}
            </span>
          </dd>
        </div>
      </dl>

      <div className="btnrow" style={{ marginTop: 0 }}>
        <a className="btn" href="/">
          {status === "NOT_STARTED"
            ? "Verify my identity"
            : "See my verification status"}
        </a>
      </div>

      <p className="footnote">
        Already verified as an investor or a land owner? Then this is already
        done — KYC belongs to a person, not a role, so Aadhaar, PAN and the
        selfie carry over and only the proof of authority is new.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SubmitStep({ organisation }: { organisation: OrganisationView }) {
  const [state, submit, pending] = useActionState<KybResult, FormData>(
    async (_prev, formData) => submitKyb(formData),
    {},
  );

  return (
    <div className="card">
      <p className="eyebrow">Ready</p>
      <h1>Submit for a decision</h1>
      <p className="lead">
        Everything is in. Both gates are checked together, once: the business and
        the person signing.
      </p>

      {state.error ? (
        <div className="alert" role="alert">
          <strong>{state.error.code}</strong> — {state.error.message}
        </div>
      ) : null}

      <div className="tickline">
        <i>✓</i> GST registration checked
      </div>
      {organisation.cinOrLlpin ? (
        <div className="tickline">
          <i>✓</i> MCA company register checked
        </div>
      ) : null}
      <div className="tickline">
        <i>✓</i> Signatory declared and personally verified
      </div>

      <form action={submit}>
        <input type="hidden" name="orgId" value={organisation.id} />
        <button className="btn" type="submit" disabled={pending} style={{ marginTop: 18 }}>
          {pending ? "Submitting…" : "Submit the business check"}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Verdict({ organisation }: { organisation: OrganisationView }) {
  const verdict = VERDICTS[organisation.kybStatus];
  if (!verdict) return null;

  return (
    <div className="card">
      <p className="eyebrow">Result</p>

      <div className={"verdict " + verdict.tone}>
        <span className="mark">{verdict.mark}</span>
        <span>
          <span className="title">{verdict.title}</span>
          <span className="sub">{verdict.sub}</span>
        </span>
      </div>

      {organisation.gstStatus !== "ACTIVE" ? (
        <div className="alert" role="status">
          Your GST registration shows as <strong>{organisation.gstStatus}</strong>.
          A cancelled or suspended registration cannot carry a valid B2B invoice,
          so no PPA can be signed against it.
        </div>
      ) : null}

      {organisation.companyStatus && organisation.companyStatus !== "ACTIVE" ? (
        <div className="alert" role="status">
          The MCA register shows this company as{" "}
          <strong>{organisation.companyStatus.replace("_", " ").toLowerCase()}</strong>.
        </div>
      ) : null}

      <p className="footnote">
        {organisation.kybStatus === "MANUAL_REVIEW"
          ? "This is now in Legal's review queue. The board resolution always goes to a person — nobody automates who may bind a company for twenty-five years."
          : "This status was written by the server after the lookups came back and decideKyc() ran. The browser did not decide it."}
      </p>
    </div>
  );
}
