"use client";

import { useState, useTransition } from "react";
import {
  CONFIDENCE_FLOOR,
  labelFor,
  orderedFields,
  type ConfirmedUploadView,
} from "../../lib/documentTypes";
import { uploadDocument, viewDocument } from "./actions";

/**
 * The upload, and what came back from it.
 *
 * The outcome is shown in full — including the confidence per field — because
 * a customer who can see that the khasra number was read at 0.62 understands
 * why they are being asked to check it. "Under review" with no explanation is
 * what generates the support call.
 */

const DOC_TYPES = [
  { value: "JAMABANDI", label: "Jamabandi (record of rights)" },
  { value: "KHASRA_KHATAUNI", label: "Khasra / Khatauni" },
  { value: "MUTATION_RECORD", label: "Mutation record" },
  { value: "SALE_DEED", label: "Sale deed" },
];

/**
 * Development only, and visible as such.
 *
 * The same reasoning as the KYC scenario picker: an outcome nobody can reach
 * is an outcome nobody tests, and the one that matters most here — an infected
 * file — is not something to produce by finding real malware.
 */
const TEST_MARKERS = [
  { value: "", label: "Clean, fully legible" },
  { value: "partial", label: "Faded — two fields illegible" },
  { value: "lowconf", label: "Barely legible throughout" },
  { value: "unreadable", label: "Blank or corrupt page" },
  { value: "owner-anita-desai", label: "Records are in somebody else's name" },
  { value: "infected", label: "Infected file" },
  { value: "scanfail", label: "Virus scanner unreachable" },
];

export function UploadPanel() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ConfirmedUploadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  function submit(formData: FormData) {
    setError(null);
    setResult(null);

    startTransition(async () => {
      const outcome = await uploadDocument(formData);
      if (outcome.error) setError(outcome.error.message);
      else setResult(outcome.document ?? null);
    });
  }

  /**
   * A fresh URL on every open, never a cached one. The link lasts sixty
   * seconds and each issue is an audited access — a URL held in component
   * state would be a view nobody logged.
   */
  async function open(documentId: string) {
    setOpening(true);
    const outcome = await viewDocument(documentId);
    setOpening(false);

    if (outcome.error) {
      setError(outcome.error.message);
      return;
    }
    if (outcome.view) window.open(outcome.view.url, "_blank", "noopener");
  }

  return (
    <>
      <form action={submit}>
        <div className="field">
          <label htmlFor="docType">Which document is this?</label>
          <select id="docType" name="docType" defaultValue="JAMABANDI">
            {DOC_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="file">The scan or photograph</label>
          <input
            id="file"
            name="file"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/heic,image/heif"
            required
          />
          <p className="hint">
            PDF or a photo, up to 25&nbsp;MB. A phone photo of the original is
            fine as long as the khasra number is readable.
          </p>
        </div>

        <div className="field">
          <label htmlFor="testMarker">
            Simulated scan outcome <span className="mono">(dev only)</span>
          </label>
          <select id="testMarker" name="testMarker" defaultValue="">
            {TEST_MARKERS.map((marker) => (
              <option key={marker.value} value={marker.value}>
                {marker.label}
              </option>
            ))}
          </select>
          <p className="hint">
            There is no real virus scanner or OCR behind this yet. This picks
            which answer the stand-in gives, so every outcome can be walked
            through. The API drops this field in production.
          </p>
        </div>

        <div className="field">
          <label htmlFor="testKhasra">
            Khasra number to report <span className="mono">(dev only)</span>
          </label>
          <input
            id="testKhasra"
            name="testKhasra"
            type="text"
            placeholder="127/3"
            pattern="[0-9]{1,4}(/[0-9]{1,4})?"
          />
          <p className="hint">
            Leave blank for the default plot. Set it to register a second,
            different plot — or to the same number as another account, which is
            how the duplicate-claim check can be seen working.
          </p>
        </div>

        <div className="btnrow">
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "Uploading and scanning…" : "Upload document"}
          </button>
        </div>
      </form>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      {result && <Outcome result={result} onOpen={open} opening={opening} />}
    </>
  );
}

/* ------------------------------------------------------------------ */

function Outcome({
  result,
  onOpen,
  opening,
}: {
  result: ConfirmedUploadView;
  onOpen: (id: string) => void;
  opening: boolean;
}) {
  const fields = orderedFields(result.fields);

  if (result.scanStatus === "INFECTED") {
    return (
      <div className="card">
        <p className="eyebrow">Rejected</p>
        <h2>This file failed the virus scan</h2>
        <p className="lead">
          It has been quarantined and cannot be opened — not by you, and not by
          our reviewers either. Nothing was read from it.
        </p>
        <p className="hint">
          If this was unexpected, the file may have been altered in transit or
          by something on the device it came from. Try exporting a fresh copy
          from the original source.
        </p>
      </div>
    );
  }

  if (result.scanStatus === "ERRORED") {
    return (
      <div className="card">
        <p className="eyebrow">Not finished</p>
        <h2>We could not scan this file yet</h2>
        <p className="lead">
          The virus scanner did not answer, so the file is being held
          unscanned. We will retry automatically — nothing is lost, and nothing
          is approved in the meantime.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <p className="eyebrow">
        {result.needsManualReview ? "Needs a second look" : "Read successfully"}
      </p>
      <h2>
        {result.needsManualReview
          ? "A person will check this one"
          : "We read your document"}
      </h2>

      <p className="lead">
        {result.needsManualReview
          ? fields.length === 0
            ? "We could not read anything off this scan, so somebody from our team will look at it directly. You do not need to do anything."
            : `${result.lowConfidenceFieldCount} of the ${fields.length} fields were not clear enough to rely on, so somebody will check them against the original.`
          : "Everything came through clearly. Please confirm it matches the document in front of you."}
      </p>

      {fields.length > 0 && (
        <div className="kv">
          {fields.map(([name, field]) => {
            const low = field.confidence < CONFIDENCE_FLOOR;
            return (
              <div className="kv-row" key={name}>
                <span>{labelFor(name)}</span>
                <span className={low ? "mono" : undefined}>
                  {field.value}{" "}
                  <span className="submono">
                    {low
                      ? `unclear · ${(field.confidence * 100).toFixed(0)}%`
                      : `${(field.confidence * 100).toFixed(0)}%`}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="btnrow">
        <button
          className="btn ghost"
          type="button"
          onClick={() => onOpen(result.documentId)}
          disabled={opening}
        >
          {opening ? "Getting a link…" : "Open the document"}
        </button>
      </div>

      <p className="footnote">
        Opening it issues a link that expires in one minute, and records the
        access against your name.
      </p>
    </div>
  );
}
