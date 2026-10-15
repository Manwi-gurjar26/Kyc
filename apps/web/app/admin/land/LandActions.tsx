"use client";

import { useState, useTransition } from "react";
import { confirmConsent, openDocument, reviewDocument } from "./actions";

/**
 * The buttons a reviewer actually presses.
 *
 * Every one of them states what it will do before it does it. A reviewer
 * deciding somebody's land ownership from a queue row has to know whether
 * "approve" means "this scan is legible" or "this land may be leased" — they
 * are different decisions, and the labels say which.
 */

/* ------------------------------------------------------------------ */

export function DocumentActions({
  documentId,
  scanStatus,
  canAct,
}: {
  documentId: string;
  scanStatus: string;
  /** False for a staff role that may read this queue but not act on it. */
  canAct: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [opening, setOpening] = useState(false);

  /**
   * No link is ever minted for an infected file, for anybody — including
   * Legal. A reviewer opening one to "see what it is" is the exact outcome the
   * scan exists to prevent, so the button is not offered rather than offered
   * and refused.
   */
  const readable = scanStatus === "CLEAN";

  /**
   * A reviewer who cannot act is not offered the buttons.
   *
   * The API refuses them anyway — that is the real block — but a button that
   * is known in advance to fail is worse than no button: it reads as a bug
   * rather than as a boundary, and somebody will fill in the rejection form
   * before finding out.
   *
   * Reading the queue is still allowed, including opening a document, because
   * a second pair of eyes on the evidence is useful even when the decision is
   * not theirs. The access is logged either way.
   */

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const outcome = await reviewDocument(formData);
      if (outcome.error) setError(outcome.error.message);
      else setResult(outcome.status ?? null);
    });
  }

  async function open() {
    setOpening(true);
    const outcome = await openDocument(documentId);
    setOpening(false);
    if (outcome.error) setError(outcome.error.message);
    else if (outcome.url) window.open(outcome.url, "_blank", "noopener");
  }

  if (result) {
    return (
      <p className="submono">
        {result === "APPROVED" ? "Approved" : "Rejected"} — the plot&rsquo;s
        verdict has been worked out again.
      </p>
    );
  }

  return (
    <>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <div className="btnrow">
        {readable ? (
          <button
            className="btn ghost"
            type="button"
            onClick={open}
            disabled={opening}
          >
            {opening ? "Getting a link…" : "Open the document"}
          </button>
        ) : (
          <span className="submono">
            Not openable — this file has not scanned clean.
          </span>
        )}

        {readable && canAct && !rejecting && (
          <>
            <form action={submit} style={{ display: "inline" }}>
              <input type="hidden" name="documentId" value={documentId} />
              <input type="hidden" name="approved" value="true" />
              <button className="btn" type="submit" disabled={pending}>
                {pending ? "Recording…" : "The scan is legible"}
              </button>
            </form>
            <button
              className="btn ghost"
              type="button"
              onClick={() => setRejecting(true)}
            >
              Ask for a better copy
            </button>
          </>
        )}
      </div>

      {readable && !canAct && (
        <p className="submono">
          Deciding a land document is Legal&rsquo;s. You can read it and open
          it; the decision is not yours to record.
        </p>
      )}

      {rejecting && (
        <form action={submit}>
          <input type="hidden" name="documentId" value={documentId} />
          <input type="hidden" name="approved" value="false" />

          <div className="field">
            <label htmlFor={`reason-${documentId}`}>Why</label>
            <select id={`reason-${documentId}`} name="reasonCode" required>
              <option value="">Choose a reason…</option>
              <option value="DOCUMENT_ILLEGIBLE">Cannot be read</option>
              <option value="DOCUMENT_INCOMPLETE">Pages missing</option>
              <option value="DOCUMENT_WRONG_TYPE">Not the document asked for</option>
              <option value="DOCUMENT_EXPIRED">Too old to rely on</option>
              <option value="DOCUMENT_SUSPECTED_FORGERY">Looks altered</option>
            </select>
            <p className="hint">
              Required. The customer is about to be asked for another document,
              and support cannot tell them what to send without this.
            </p>
          </div>

          <div className="field">
            <label htmlFor={`note-${documentId}`}>Note for the file</label>
            <textarea id={`note-${documentId}`} name="note" rows={3} />
          </div>

          <div className="btnrow">
            <button className="btn" type="submit" disabled={pending}>
              {pending ? "Recording…" : "Reject"}
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => setRejecting(false)}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

export function ConsentActions({
  parcelId,
  coOwnerNames,
  canAct,
}: {
  parcelId: string;
  coOwnerNames: string[];
  canAct: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const outcome = await confirmConsent(formData);
      if (outcome.error) setError(outcome.error.message);
      else setStatus(outcome.status ?? null);
    });
  }

  if (status) {
    return <p className="submono">Consent recorded — the plot is now {status}.</p>;
  }

  if (!canAct) {
    return (
      <p className="submono">
        Waiting on Legal to confirm that all{" "}
        {coOwnerNames.length + 1} holders have agreed.
      </p>
    );
  }

  return (
    <form action={submit}>
      <input type="hidden" name="parcelId" value={parcelId} />

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <div className="field">
        <label htmlFor={`consent-${parcelId}`}>
          How the consent was obtained
        </label>
        <textarea
          id={`consent-${parcelId}`}
          name="note"
          rows={3}
          placeholder={`Spoke to ${coOwnerNames[0] ?? "each holder"} by phone on …`}
        />
        <p className="hint">
          Confirming this says every person named on the record has agreed to
          the lease — not that the paperwork is legible, which is the separate
          decision above. A lease missing one holder&rsquo;s agreement can be
          set aside after the panels are installed.
        </p>
      </div>

      <div className="btnrow">
        <button className="btn" type="submit" disabled={pending}>
          {pending
            ? "Recording…"
            : `All ${coOwnerNames.length + 1} holders have agreed`}
        </button>
      </div>
    </form>
  );
}
