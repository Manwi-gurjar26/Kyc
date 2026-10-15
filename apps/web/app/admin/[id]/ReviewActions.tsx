"use client";

import { useActionState, useState } from "react";
import { REASON_CODES } from "../../../lib/adminTypes";
import { submitReview, type ReviewResult } from "../actions";

/**
 * Approve, reject, or ask for a re-upload.
 *
 * A reason code is required before the form will submit, and the codes are a
 * fixed list rather than free text — the audit log has to be searchable, and
 * "looks fine" typed forty different ways is not. The note is where the prose
 * goes, and it stays internal: it may discuss the person, so it never travels
 * in the notification payload.
 */

type Action = "APPROVE" | "REJECT" | "REQUEST_RESUBMISSION";

const ACTIONS: { id: Action; label: string; tone: string; help: string }[] = [
  {
    id: "APPROVE",
    label: "Approve",
    tone: "ok",
    help: "Clears the case. The customer can carry on immediately.",
  },
  {
    id: "REQUEST_RESUBMISSION",
    label: "Ask for a re-upload",
    tone: "warn",
    help: "Sends it back to the customer with your reason. Neither approved nor rejected.",
  },
  {
    id: "REJECT",
    label: "Reject",
    tone: "bad",
    help: "Ends the case. Use this when the details or documents are genuinely wrong.",
  },
];

export function ReviewActions({ recordId }: { recordId: string }) {
  const [action, setAction] = useState<Action | null>(null);
  const [reasonCode, setReasonCode] = useState("");

  const [state, submit, pending] = useActionState<ReviewResult, FormData>(
    async (_prev, formData) => submitReview(formData),
    {},
  );

  if (state.status) {
    return (
      <>
        <div
          className={
            "verdict " +
            (state.status === "VERIFIED"
              ? "ok"
              : state.status === "REJECTED"
                ? "bad"
                : "warn")
          }
        >
          <span className="mark">
            {state.status === "VERIFIED" ? "✓" : state.status === "REJECTED" ? "×" : "↩"}
          </span>
          <span>
            <span className="title">Recorded — now {state.status}</span>
            <span className="sub">
              The customer has been notified through the outbox, and your name
              and reason are on the audit log.
            </span>
          </span>
        </div>
        <a className="btn ghost" href="/admin">
          ← Back to the queue
        </a>
      </>
    );
  }

  const reasons = action ? REASON_CODES[action] ?? [] : [];

  return (
    <form action={submit}>
      <input type="hidden" name="recordId" value={recordId} />
      <input type="hidden" name="action" value={action ?? ""} />

      {state.error ? (
        <div className="alert" role="alert">
          <strong>{state.error.code}</strong> — {state.error.message}
          {state.error.code === "CASE_ALREADY_DECIDED" ? (
            <>
              {" "}
              <a href="/admin">Refresh the queue</a>.
            </>
          ) : null}
        </div>
      ) : null}

      <div className="choices">
        {ACTIONS.map((option) => (
          <button
            type="button"
            key={option.id}
            className="choice"
            aria-pressed={action === option.id}
            onClick={() => {
              setAction(option.id);
              setReasonCode("");
            }}
          >
            <span className="radio" />
            <span>
              <span className="ct">{option.label}</span>
              <span className="cd">{option.help}</span>
            </span>
          </button>
        ))}
      </div>

      {action ? (
        <>
          <div className="field">
            <label htmlFor="reasonCode">Reason (required)</label>
            <select
              id="reasonCode"
              name="reasonCode"
              required
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value)}
            >
              <option value="">Choose a reason…</option>
              {reasons.map((reason) => (
                <option key={reason.code} value={reason.code}>
                  {reason.label}
                </option>
              ))}
            </select>
            <p className="hint">
              {reasonCode ? reasonCode : "stored on the audit log and searchable"}
            </p>
          </div>

          <div className="field">
            <label htmlFor="note">Note for colleagues (optional)</label>
            <textarea
              id="note"
              name="note"
              rows={3}
              maxLength={2000}
              placeholder="Aadhaar photo is from 2013. Same person, clearly."
            />
            <p className="hint">
              internal only — never sent to the customer
            </p>
          </div>

          <button className="btn" type="submit" disabled={pending || !reasonCode}>
            {pending ? "Recording…" : `Record: ${action.replace(/_/g, " ").toLowerCase()}`}
          </button>
        </>
      ) : null}
    </form>
  );
}
