"use client";

import { useState, useTransition } from "react";
import type { ParcelView } from "../../lib/documentTypes";
import { declareCoOwners } from "./actions";

/**
 * The plots we have on file, and where each one stands.
 *
 * The reasons are shown in full, including the ones that block nothing. A
 * customer who can read "another account has registered this khasra number
 * since you did — your own registration stands" understands their position;
 * the same situation rendered as a bare "under review" badge produces a phone
 * call to support and no information.
 */

const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "Being checked",
  MANUAL_REVIEW: "With our team",
  VERIFIED: "Ready to lease",
  REJECTED: "Cannot be used",
  BLOCKED: "Blocked",
};

export function ParcelList({ parcels }: { parcels: ParcelView[] }) {
  if (parcels.length === 0) {
    return (
      <div className="card">
        <p className="eyebrow">Your plots</p>
        <h2 style={{ marginTop: 0 }}>No land on file yet</h2>
        <p className="lead">
          Upload a Jamabandi or Khasra&nbsp;Khatauni above. We read the khasra
          number off it and that becomes the plot a lease can be signed for.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <p className="eyebrow">Your plots</p>
        <h2 style={{ marginTop: 0 }}>
          {parcels.length} plot{parcels.length === 1 ? "" : "s"} on file
        </h2>
        <p className="lead">
          A lease is signed for one plot and names its khasra number, so a plot
          still being checked does not hold up one that is ready.
        </p>
      </div>

      {parcels.map((parcel) => (
        <Parcel key={parcel.id} parcel={parcel} />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */

function Parcel({ parcel }: { parcel: ParcelView }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const outcome = await declareCoOwners(formData);
      if (outcome.error) setError(outcome.error.message);
      else setEditing(false);
    });
  }

  /**
   * A flag is not a problem the customer has to solve, so it is kept apart
   * from the reasons that are. Mixing them would make every dispute look like
   * something they had done wrong.
   */
  const blocking = parcel.reasons.filter((r) => r.severity !== "FLAG");
  const flags = parcel.reasons.filter((r) => r.severity === "FLAG");

  return (
    <div className="card">
      <div className="verdict">
        <h2 style={{ margin: 0 }}>
          Khasra <span className="mono">{parcel.khasraNumber}</span>
        </h2>
        <span className="pill">
          {STATUS_LABEL[parcel.verificationStatus] ?? parcel.verificationStatus}
        </span>
      </div>

      <div className="kv">
        {parcel.village && (
          <div className="kv-row">
            <span>Village</span>
            <span>{parcel.village}</span>
          </div>
        )}
        {parcel.district && (
          <div className="kv-row">
            <span>District</span>
            <span>{parcel.district}</span>
          </div>
        )}
        {parcel.areaAcres && (
          <div className="kv-row">
            <span>Area</span>
            <span>{parcel.areaAcres} acres</span>
          </div>
        )}
        {parcel.ownerNameOnRecord && (
          <div className="kv-row">
            <span>Name on the record</span>
            <span>
              {parcel.ownerNameOnRecord}
              {parcel.ownerNameMatchScore !== null && (
                <span className="submono">
                  {" "}
                  {Math.round(Number(parcel.ownerNameMatchScore) * 100)}% match
                </span>
              )}
            </span>
          </div>
        )}
        <div className="kv-row">
          <span>Held with others</span>
          <span>
            {parcel.coOwnerNames.length === 0
              ? "No — you alone"
              : `${parcel.coOwnerNames.join(", ")}${
                  parcel.coOwnerConsentConfirmed ? " · consent confirmed" : ""
                }`}
          </span>
        </div>
      </div>

      {blocking.length > 0 && (
        <div className="reasons">
          <div className="notice-head">What is holding this up</div>
          <ul>
            {blocking.map((reason) => (
              <li key={reason.code}>{reason.detail}</li>
            ))}
          </ul>
        </div>
      )}

      {flags.length > 0 && (
        <div className="notice">
          <div className="notice-head">For your information</div>
          <ul>
            {flags.map((reason) => (
              <li key={reason.code}>{reason.detail}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      {editing ? (
        <form action={submit}>
          <input type="hidden" name="parcelId" value={parcel.id} />
          <div className="field">
            <label htmlFor={`co-${parcel.id}`}>
              Everyone else named on the record
            </label>
            <textarea
              id={`co-${parcel.id}`}
              name="coOwnerNames"
              rows={4}
              defaultValue={parcel.coOwnerNames.join("\n")}
              placeholder={"Sunita Sharma\nMohan Lal Sharma"}
            />
            <p className="hint">
              One name per line, exactly as the record spells it. Leave it empty
              if the land is yours alone. We contact each person named before a
              lease is signed — a lease missing a co-owner&rsquo;s agreement can
              be set aside later, which is why we ask rather than guess.
            </p>
          </div>
          <div className="btnrow">
            <button className="btn" type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => setEditing(false)}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="btnrow">
          <button
            className="btn ghost"
            type="button"
            onClick={() => setEditing(true)}
          >
            {parcel.coOwnerNames.length === 0
              ? "This land is held with others"
              : "Change who holds it"}
          </button>
        </div>
      )}
    </div>
  );
}
