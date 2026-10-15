"use client";

import { useState, useTransition } from "react";
import { fetchGstin, verifyBusiness } from "../actions";

/**
 * Business verification: GSTIN, company PAN or CIN, incorporation
 * certificate, authorised signatory.
 *
 * The GSTIN is asked for first because it answers four questions at once. Its
 * characters 3 to 12 ARE the business PAN, the first two are the state code,
 * and the registry returns the legal name and the constitution. So one number
 * fills most of this screen, and the constitution it returns is what decides
 * whether a CIN is even required — a proprietorship has none, and demanding
 * one would make every proprietor unverifiable.
 */

interface Fetched {
  legalName: string;
  status: string;
  constitution: string;
  businessPan: string;
}

export function BusinessForm() {
  const [gstin, setGstin] = useState("");
  const [found, setFound] = useState<Fetched | null>(null);
  const [cin, setCin] = useState("");
  const [signatoryPan, setSignatoryPan] = useState("");
  const [certificate, setCertificate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const canFetch = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(gstin);
  const canSubmit =
    found !== null && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(signatoryPan) && !pending;

  function lookup() {
    setError(null);
    start(async () => {
      const result = await fetchGstin(gstin);
      if (result.error) {
        setError(result.error.message);
        setFound(null);
        return;
      }
      setFound(result.organisation ?? null);
    });
  }

  function submit() {
    setError(null);
    start(async () => {
      const result = await verifyBusiness({ gstin, cin, signatoryPan });
      if (result.error) setError(result.error.message);
    });
  }

  return (
    <>
      {/* ---- GSTIN ---- */}
      <div className="frow">
        <div className="frow-top">
          <label htmlFor="gstin">GSTIN number</label>
          <span className="tag">Auto-fill</span>
        </div>

        <div className="frow-in">
          <input
            id="gstin"
            type="text"
            autoComplete="off"
            placeholder="27AAACG0561F1ZV"
            style={{ textTransform: "uppercase" }}
            value={gstin}
            onChange={(event) =>
              setGstin(
                event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 15),
              )
            }
          />
          <button
            type="button"
            className="inlinebtn"
            disabled={!canFetch || pending}
            onClick={lookup}
          >
            {pending ? "Fetching…" : "Fetch →"}
          </button>
        </div>

        <p className="hint">
          The checksum is verified here before the lookup is paid for. Characters
          3 to 12 are your business PAN, so it is never asked for separately.
        </p>

        {found && (
          <div className="okchip">
            <span aria-hidden="true">✓</span>
            <span>
              {found.legalName} · {found.status}
            </span>
            <span className="src">GST</span>
          </div>
        )}
      </div>

      {/* ---- company PAN / CIN ---- */}
      <div className="frow">
        <div className="frow-top">
          <label htmlFor="cin">Company PAN / CIN</label>
          <span className="tag">Auto-mapped</span>
        </div>

        <div className="frow-in">
          <input
            id="cin"
            type="text"
            autoComplete="off"
            placeholder={found ? found.businessPan : "Fetch the GSTIN first"}
            style={{ textTransform: "uppercase" }}
            value={cin}
            disabled={!found}
            onChange={(event) =>
              setCin(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 21))
            }
          />
        </div>

        <p className="hint">
          {found
            ? found.constitution.toLowerCase().includes("propriet")
              ? "A proprietorship has no CIN. Leave this empty."
              : "A company needs its CIN, an LLP its LLPIN. The MCA name has to agree with the GST legal name."
            : "Filled from the GST registry once the GSTIN is fetched."}
        </p>
      </div>

      {/* ---- certificate ---- */}
      <div className="frow">
        <div className="frow-top">
          <label htmlFor="certificate">Certificate of incorporation</label>
        </div>

        <label className="upload" htmlFor="certificate">
          <div className="ut">{certificate ?? "Tap to browse"}</div>
          <div className="us">PDF or JPG, up to 25 MB</div>
          <input
            id="certificate"
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            onChange={(event) => setCertificate(event.target.files?.[0]?.name ?? null)}
          />
        </label>
      </div>

      {/* ---- signatory ---- */}
      <div className="frow">
        <div className="frow-top">
          <label htmlFor="signatoryPan">Authorised signatory PAN</label>
          <span className="tag">Director / Partner</span>
        </div>

        <div className="frow-in">
          <input
            id="signatoryPan"
            type="text"
            autoComplete="off"
            placeholder="ABCDE1234F"
            style={{ textTransform: "uppercase" }}
            value={signatoryPan}
            onChange={(event) =>
              setSignatoryPan(
                event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10),
              )
            }
          />
        </div>

        <p className="hint">
          This person signs the PPA. Being verified is not the same as being
          allowed to sign, so Legal also reads the board resolution naming them.
        </p>
      </div>

      {error && (
        <div className="alert" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      <button className="cta" type="button" disabled={!canSubmit} onClick={submit}>
        {pending ? "Verifying…" : "Verify and continue →"}
      </button>

      <p className="secure">
        <span aria-hidden="true">🔒</span> Sent over TLS and stored encrypted
      </p>
    </>
  );
}
