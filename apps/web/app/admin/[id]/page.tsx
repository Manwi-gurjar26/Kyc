import { api, currentStaffRoles } from "../../../lib/api";
import type { CaseDetailResponse } from "../../../lib/adminTypes";
import { Portrait } from "./Portrait";
import { ReviewActions } from "./ReviewActions";

/**
 * One case, with the evidence a decision is actually made on.
 *
 * The guide is specific about what a reviewer needs, and the reason is the
 * commonest failure: Aadhaar photographs are often a decade old and 320 pixels
 * wide, so a weak face match usually means an old photo rather than a
 * different person. A reviewer handed only the number 0.68 cannot tell those
 * apart. Handed both images, they can in a second.
 */

const CHECK_LABEL: Record<string, string> = {
  AADHAAR: "Aadhaar",
  PAN: "PAN",
  LIVENESS: "Liveness",
  FACE_MATCH: "Face match",
  GST: "GST",
  CIN: "Company (CIN)",
  LLPIN: "LLP (LLPIN)",
  LAND_DOCUMENTS: "Land documents",
  NAME_MATCH: "Name match",
};

const ACTION_LABEL: Record<string, string> = {
  "kyc.decided": "Decided automatically",
  "kyc.reviewed": "Reviewed by a person",
};

export default async function CaseDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const roles = await currentStaffRoles();
  const detail = await api<CaseDetailResponse>(`/v1/admin/kyc/reviews/${id}`);

  const threshold = detail.thresholdsUsed?.faceMatch ?? detail.thresholds.faceMatch;
  const score = detail.faceMatchScore;
  const settled = detail.status !== "MANUAL_REVIEW";

  return (
    <>
      <div className="card">
        <p className="eyebrow">
          <a href="/admin">← Queue</a> · case {detail.id.slice(0, 8)}
        </p>
        <h1>{detail.subjectName ?? "Unnamed"}</h1>

        <dl className="kv">
          <div className="kv-row">
            <dt>Status</dt>
            <dd>
              <span
                className={
                  "pill " +
                  (detail.status === "VERIFIED"
                    ? "g"
                    : detail.status === "REJECTED" || detail.status === "BLOCKED"
                      ? "b"
                      : detail.status === "MANUAL_REVIEW"
                        ? "r"
                        : "n")
                }
              >
                {detail.status}
              </span>
            </dd>
          </div>
          <div className="kv-row">
            <dt>Kind</dt>
            <dd>
              {detail.caseType} · level {detail.level}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Waiting</dt>
            <dd className="mono">
              {detail.waitingHours < 1 ? "<1h" : `${detail.waitingHours}h`}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Aadhaar</dt>
            <dd>
              {detail.aadhaarLast4 ? (
                <>
                  <span className="mono">XXXX XXXX {detail.aadhaarLast4}</span>
                  <small>
                    the last four digits are all that exists — there is no
                    column that could hold the full number
                  </small>
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div className="kv-row">
            <dt>PAN</dt>
            <dd>
              {detail.panLast4 ? (
                <>
                  <span className="mono">••••••{detail.panLast4}</span>
                  <small>
                    stored encrypted; decrypting it is a separate, logged action
                  </small>
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Vendor</dt>
            <dd className="mono">
              {detail.vendor ?? "—"} {detail.vendorVersion ?? ""}
            </dd>
          </div>
        </dl>
      </div>

      {/* ---------------- the two photographs ---------------- */}

      {/*
        Shown whenever there is a face to compare OR a score to show.
        It used to require a score, which made the section invisible on the
        gateway this system actually runs on: that gateway sells no face match,
        so `faceMatchScore` is always null and the one screen whose purpose is
        comparing two photographs never rendered them.
      */}
      {score !== null || detail.selfieUrl || detail.aadhaarPhotoUrl ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>The two photographs</h2>

          <div className="faces">
            <figure className="face">
              <Portrait seed={detail.id} variant="selfie" src={detail.selfieUrl} />
              <figcaption>
                <span className="facelabel">Selfie, today</span>
                <span className="facemeta">
                  {detail.selfieUrl ? "taken during verification" : "not uploaded yet"}
                </span>
              </figcaption>
            </figure>
            <figure className="face">
              <Portrait
                seed={detail.id}
                variant="aadhaar"
                src={detail.aadhaarPhotoUrl}
              />
              <figcaption>
                <span className="facelabel">Aadhaar photo</span>
                <span className="facemeta">
                  {detail.aadhaarPhotoUrl
                    ? "as held by UIDAI"
                    : "not returned by the gateway"}
                </span>
              </figcaption>
            </figure>
          </div>

          {/* No score without a face-match vendor, so no meter either. */}
          {score !== null ? (
          <div className="meter">
            <div className="meter-top">
              <span>Face match</span>
              <strong className="mono">
                {score.toFixed(2)} / pass mark {threshold}
              </strong>
            </div>
            <div className="track">
              <span
                className="fill"
                style={{
                  width: `${Math.round(score * 100)}%`,
                  background:
                    score >= threshold ? "var(--ok)" : "var(--warn)",
                }}
              />
              <span
                className="thr"
                style={{ left: `${Math.round(threshold * 100)}%` }}
              />
            </div>
            <div className="meter-foot">
              <span>0.00</span>
              <span>pass mark from settings — no release needed to change it</span>
              <span>1.00</span>
            </div>
          </div>
          ) : (
            <p className="footnote">
              There is no face-match score, because the verification gateway in
              use does not offer one. This comparison is the face check: look at
              the two images and decide. Aadhaar photographs are frequently a
              decade old and a few hundred pixels wide, so expect the Aadhaar
              side to look dated even when it is the same person.
            </p>
          )}

          <p className="footnote">
            A drawn placeholder means that image is genuinely absent — the fake
            gateway returns no photograph, and a case can reach review before a
            selfie is uploaded. Real images arrive as signed URLs that expire in
            seconds, and opening either one is written to the audit log.
          </p>
        </div>
      ) : null}

      {/* ---------------- why it is here ---------------- */}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Why this needs a person</h2>
        <ul className="reasons">
          {detail.reasons.map((reason) => (
            <li key={reason.code}>
              <code>{reason.code}</code>
              <span>
                {reason.detail}
                {reason.severity === "FLAG" ? (
                  <>
                    {" "}
                    <span className="pill n">does not block</span>
                  </>
                ) : null}
              </span>
            </li>
          ))}
          {detail.reasons.length === 0 ? (
            <li>
              <span>No reasons recorded.</span>
            </li>
          ) : null}
        </ul>
      </div>

      {/* ---------------- every check ---------------- */}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Every check, including the failures</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Result</th>
                <th>Score</th>
                <th>Attempt</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {detail.checks.map((check, index) => (
                <tr key={`${check.checkType}-${check.attemptNumber}-${index}`}>
                  <td>
                    <strong>
                      {CHECK_LABEL[check.checkType] ?? check.checkType}
                    </strong>
                  </td>
                  <td>
                    <span
                      className={
                        "pill " +
                        (check.status === "PASSED"
                          ? "g"
                          : check.status === "FAILED"
                            ? "b"
                            : "n")
                      }
                    >
                      {check.status}
                    </span>
                  </td>
                  <td className="mono">
                    {check.score === null ? "—" : check.score.toFixed(2)}
                  </td>
                  <td className="mono">{check.attemptNumber}</td>
                  <td style={{ fontSize: 13 }}>{check.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="footnote">
          Append-only, enforced by a database trigger. A failed attempt followed
          by a passing one leaves both rows, because that pattern is exactly
          what a fraud review looks for.
        </p>
      </div>

      {/* ---------------- documents ---------------- */}

      {detail.documents.length > 0 ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Documents</h2>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Virus scan</th>
                  <th>Fields read poorly</th>
                </tr>
              </thead>
              <tbody>
                {detail.documents.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      <strong>{doc.docType.replace(/_/g, " ")}</strong>
                    </td>
                    <td>
                      <span
                        className={
                          "pill " + (doc.scanStatus === "CLEAN" ? "g" : "n")
                        }
                      >
                        {doc.scanStatus}
                      </span>
                    </td>
                    <td className="mono">{doc.lowConfidenceFieldCount ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="footnote">
            No viewer yet. Opening a document means a signed URL that expires in
            seconds, and every view written to the audit log — neither of which
            is built, so showing a link that did neither would be worse than
            showing none.
          </p>
        </div>
      ) : null}

      {/* ---------------- actions ---------------- */}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Your decision</h2>

        {settled ? (
          <p className="lead">
            This case is already <strong>{detail.status}</strong>. The state
            machine will not let it be decided twice, so there is nothing to do
            here.
          </p>
        ) : !detail.actionable ? (
          <>
            <div className="alert" role="status">
              A {detail.caseType.toLowerCase().replace("_", " ")} case is not
              yours to decide. You are {roles.join(", ") || "not staff"}.
            </div>
            <p className="footnote">
              The button is absent and the API would refuse it anyway. Hiding a
              control is a courtesy; the block is <code>canReviewCase()</code>{" "}
              running server-side.
            </p>
          </>
        ) : (
          <ReviewActions recordId={detail.id} />
        )}
      </div>

      {/* ---------------- timeline ---------------- */}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>What happened, in order</h2>
        <ul className="tl">
          {detail.timeline.map((entry, index) => (
            <li key={index}>
              <span>
                <span className="tw">
                  <strong>{ACTION_LABEL[entry.action] ?? entry.action}</strong>
                  {entry.reasonCode ? ` · ${entry.reasonCode}` : ""}
                </span>
                {entry.note ? <span className="tnote">{entry.note}</span> : null}
                <span className="tm">
                  {entry.actorType} · {new Date(entry.createdAt).toISOString()}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="footnote">
          From <span className="mono">audit_log</span>, which is append-only.
          Every decision carries who made it and why.
        </p>
      </div>
    </>
  );
}
