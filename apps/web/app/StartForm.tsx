"use client";

import { useActionState, useState } from "react";
import { beginVerification, type ActionResult } from "./actions";

/**
 * Consent, then start.
 *
 * The consent text is the screen, not a checkbox buried under a link. DPDP
 * wants a notice per purpose and a way to withdraw, and the notice version
 * shown here is the version recorded against the consent — so the wording and
 * the stored version have to move together.
 */

const SCENARIOS: { id: string; label: string; outcome: string }[] = [
  { id: "pass", label: "Everything passes", outcome: "VERIFIED" },
  {
    id: "low_face_score",
    label: "Old Aadhaar photo, weak face match",
    outcome: "MANUAL REVIEW",
  },
  {
    id: "pan_name_mismatch",
    label: "PAN name differs (married name)",
    outcome: "MANUAL REVIEW",
  },
  {
    id: "pan_inoperative",
    label: "PAN not linked to Aadhaar",
    outcome: "VERIFIED, flagged for TDS",
  },
  {
    id: "pan_deactivated",
    label: "PAN deactivated by the IT Department",
    outcome: "REJECTED",
  },
  { id: "minor", label: "Under 18 on Aadhaar", outcome: "REJECTED" },
  { id: "aadhaar_failed", label: "DigiLocker is down", outcome: "MANUAL REVIEW" },
];

const COPY = {
  en: {
    title: "Before we verify you",
    lead: "We need your permission to check your identity. You choose, and you can take this permission back at any time.",
    heading: "What you are agreeing to",
    checks: "What we check",
    checksValue: "Aadhaar, PAN and a selfie.",
    why: "Why",
    whyValue: "To sign your lease and pay your rent to the right account.",
    who: "Who sees it",
    whoValue:
      "HyperVerge for Aadhaar and the selfie, Signzy for PAN — both hosted in India.",
    howLong: "How long",
    howLongValue: "7 years, because tax law and a 25-year agreement require it.",
    aadhaar: "Your Aadhaar number",
    aadhaarValue:
      "never stored. We keep only the last 4 digits and a reference token.",
    notice:
      "Notice v2.1 · You can withdraw this from Settings → Privacy, and we will delete what the law does not force us to keep.",
    cta: "Give consent and continue",
    role: "Verifying as",
  },
  hi: {
    title: "Verify karne se pehle",
    lead: "Aapki pehchaan jaanchne ke liye hamein aapki anumati chahiye. Faisla aapka hai, aur aap yeh anumati kabhi bhi wapas le sakte hain.",
    heading: "Aap kis baat ke liye haan keh rahe hain",
    checks: "Hum kya jaanchte hain",
    checksValue: "Aadhaar, PAN aur ek selfie.",
    why: "Kyun",
    whyValue:
      "Aapke lease par dastakhat karne aur kiraya sahi account mein bhejne ke liye.",
    who: "Kaun dekhta hai",
    whoValue:
      "Aadhaar aur selfie ke liye HyperVerge, PAN ke liye Signzy — dono India mein hosted.",
    howLong: "Kitne samay tak",
    howLongValue: "7 saal — tax niyam aur 25-saal ke agreement ki wajah se.",
    aadhaar: "Aapka Aadhaar number",
    aadhaarValue:
      "kabhi store nahi hota. Hum sirf aakhri 4 digit aur ek reference token rakhte hain.",
    notice:
      "Notice v2.1 · Settings → Privacy se aap ise wapas le sakte hain; jo kanoon ke liye zaroori nahi, woh hum delete kar denge.",
    cta: "Consent dekar aage badhein",
    role: "Kis roop mein",
  },
} as const;

export function StartForm() {
  const [locale, setLocale] = useState<"en" | "hi">("en");
  const [scenario, setScenario] = useState("pass");
  const t = COPY[locale];

  const [state, submit, pending] = useActionState<ActionResult, FormData>(
    async (_prev, formData) => beginVerification(formData),
    {},
  );

  return (
    <form action={submit}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="testScenario" value={scenario} />

      <div className="btnrow" style={{ marginTop: 0, marginBottom: 20 }}>
        <button
          type="button"
          className="btn ghost"
          aria-pressed={locale === "en"}
          onClick={() => setLocale("en")}
          style={locale === "en" ? { borderColor: "var(--copper)" } : undefined}
        >
          English
        </button>
        <button
          type="button"
          className="btn ghost hi"
          aria-pressed={locale === "hi"}
          onClick={() => setLocale("hi")}
          style={locale === "hi" ? { borderColor: "var(--copper)" } : undefined}
        >
          हिंदी
        </button>
      </div>

      <h2 className={locale === "hi" ? "hi" : undefined}>{t.title}</h2>
      <p className={"lead " + (locale === "hi" ? "hi" : "")}>{t.lead}</p>

      <div className="notice">
        <div className="notice-head">{t.heading}</div>
        <ul className={locale === "hi" ? "hi" : undefined}>
          <li>
            <strong>{t.checks}:</strong> {t.checksValue}
          </li>
          <li>
            <strong>{t.why}:</strong> {t.whyValue}
          </li>
          <li>
            <strong>{t.who}:</strong> {t.whoValue}
          </li>
          <li>
            <strong>{t.howLong}:</strong> {t.howLongValue}
          </li>
          <li>
            <strong>{t.aadhaar}:</strong> {t.aadhaarValue}
          </li>
        </ul>
      </div>

      <div className="field">
        <label htmlFor="role">{t.role}</label>
        <select id="role" name="role" defaultValue="LAND_OWNER">
          <option value="LAND_OWNER">Land Owner — leasing land</option>
          <option value="INVESTOR">Investor — buying units</option>
          <option value="SIGNATORY">Signatory — signing for a business</option>
        </select>
      </div>

      <h2>Which outcome to simulate</h2>
      <p className="lead" style={{ fontSize: 13.5 }}>
        A real vendor decides this from the person&rsquo;s actual documents and
        face. With no vendor, the outcome is chosen here instead — the equivalent
        of keeping a stack of test identities at HyperVerge. The API ignores this
        field in production.
      </p>

      <div className="choices">
        {SCENARIOS.map((option) => (
          <button
            type="button"
            key={option.id}
            className="choice"
            aria-pressed={scenario === option.id}
            onClick={() => setScenario(option.id)}
          >
            <span className="radio" />
            <span>
              <span className="ct">{option.label}</span>
              <span className="cd">ends as {option.outcome}</span>
            </span>
          </button>
        ))}
      </div>

      {state.error ? (
        <div className="alert" role="alert">
          <strong>{state.error.code}</strong> — {state.error.message}
        </div>
      ) : null}

      <p className={"lead " + (locale === "hi" ? "hi" : "")} style={{ fontSize: 13 }}>
        {t.notice}
      </p>

      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Opening session…" : t.cta}
      </button>
    </form>
  );
}
