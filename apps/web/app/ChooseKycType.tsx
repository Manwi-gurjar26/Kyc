"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { chooseKycType, type ActionResult } from "./actions";

/**
 * Step 1: which kind of entity is being verified.
 *
 * This choice decides the whole rest of the flow, which is why it is asked
 * first and on its own. An individual needs Aadhaar, PAN and a selfie; a
 * registered business needs a GSTIN, a company PAN or CIN, the certificate of
 * incorporation and a named signatory. Asking for all of it and hiding half is
 * how you get a land owner abandoning the form at "Director Identification
 * Number".
 */

type Entity = "INDIVIDUAL" | "BUSINESS";

const OPTIONS: {
  value: Entity;
  kind: string;
  what: string;
  who: string;
  needs: string;
}[] = [
  {
    value: "INDIVIDUAL",
    kind: "Personal & Residential",
    what: "Individual Prosumer",
    who: "For homeowners, personal land owners and retail solar subscriptions.",
    needs: "Aadhaar OTP and PAN",
  },
  {
    value: "BUSINESS",
    kind: "Commercial & Industrial",
    what: "Registered Business",
    who: "For proprietorships, LLPs, private limited companies and factories.",
    needs: "Company PAN, GSTIN and an authorised signatory",
  },
];

function Continue({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="cta" type="submit" disabled={disabled || pending}>
      {pending ? "Starting…" : "Continue →"}
    </button>
  );
}

export function ChooseKycType() {
  const [entity, setEntity] = useState<Entity | null>(null);

  const [result, submit] = useActionState<ActionResult | null, FormData>(
    chooseKycType,
    null,
  );

  return (
    <form action={submit}>
      <input type="hidden" name="entity" value={entity ?? ""} />

      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="choicecard"
          aria-pressed={entity === option.value}
          onClick={() => setEntity(option.value)}
        >
          <span className="tick" aria-hidden="true">
            ✓
          </span>
          <span className="kind">{option.kind}</span>
          <div className="what">{option.what}</div>
          <p className="who">{option.who}</p>
          <div className="needs">
            <span aria-hidden="true">⌦</span> Requires {option.needs}
          </div>
        </button>
      ))}

      {/*
        Disabled until something is chosen, rather than defaulting to the first
        option. A pre-selected entity is a guess that silently decides which
        documents somebody is about to be asked for.
      */}
      {result?.error ? (
        <div className="alert" role="alert">
          <strong>{result.error.code}</strong> — {result.error.message}
        </div>
      ) : null}

      <Continue disabled={entity === null} />

      <p className="secure">
        <span aria-hidden="true">🔒</span> Submitted over TLS and stored
        encrypted
      </p>
    </form>
  );
}
