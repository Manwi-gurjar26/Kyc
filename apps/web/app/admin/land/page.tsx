import { ApiCallError, api, currentStaffRoles, currentUserId } from "../../../lib/api";
import type { ParcelView, QueuedDocumentView } from "../../../lib/documentTypes";
import { RolePicker } from "../RolePicker";
import { ConsentActions, DocumentActions } from "./LandActions";

/**
 * Legal's land queue.
 *
 * Two lists, because there are two decisions and conflating them is the
 * mistake this page exists to prevent:
 *
 *   Documents — is this scan legible and is it the document we asked for?
 *   Plots     — may this land be leased?
 *
 * A perfect Jamabandi can sit above a plot that cannot be leased, because the
 * record names four siblings or because the neighbour registered the same
 * khasra number last month. Showing them as one list would invite a reviewer
 * to answer the first question and believe they had answered the second.
 */

export const metadata = {
  title: "Land review · KiloWattX",
};

const DOC_LABEL: Record<string, string> = {
  JAMABANDI: "Jamabandi",
  KHASRA_KHATAUNI: "Khasra / Khatauni",
  MUTATION_RECORD: "Mutation record",
  SALE_DEED: "Sale deed",
  BOARD_RESOLUTION: "Board resolution",
  AUTHORISATION_LETTER: "Authorisation letter",
  PARTNERSHIP_DEED: "Partnership deed",
  GST_CERTIFICATE: "GST certificate",
  UDYAM_CERTIFICATE: "Udyam certificate",
  SELFIE: "Selfie",
  OTHER: "Other",
};

function waitingFor(iso: string): string {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return "under an hour";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default async function LandQueue() {
  const userId = await currentUserId();
  const roles = await currentStaffRoles();

  if (!userId) {
    return (
      <div className="card">
        <h1>Pick an identity first</h1>
        <p className="lead">
          Every land decision is recorded against a name, so the queue needs to
          know who is reviewing.
        </p>
        <a className="btn" href="/">
          Go back
        </a>
      </div>
    );
  }

  if (roles.length === 0) {
    return (
      <div className="card">
        <p className="eyebrow">Admin · land</p>
        <h1>Choose a staff role</h1>
        <p className="lead">
          Land is Legal&rsquo;s. Compliance and support clear personal cases;
          only Legal decides a sale deed or whether co-owners have agreed.
        </p>
        <RolePicker current={roles} />
      </div>
    );
  }

  /**
   * The coarse guard is the API's. This page only knows whether the caller is
   * staff at all — which queue they belong to is decided there, with the case
   * in hand, and a 403 from either endpoint is rendered rather than hidden.
   */
  let documents: QueuedDocumentView[] = [];
  let parcels: ParcelView[] = [];
  let refusal: string | null = null;

  try {
    const [docs, plots] = await Promise.all([
      api<{ documents: QueuedDocumentView[] }>("/v1/admin/documents"),
      api<{ parcels: ParcelView[] }>("/v1/admin/land-parcels"),
    ]);
    documents = docs.documents;
    parcels = plots.parcels;
  } catch (error) {
    if (error instanceof ApiCallError && (error.status === 403 || error.status === 404)) {
      refusal = error.body.message;
    } else {
      throw error;
    }
  }

  if (refusal) {
    return (
      <div className="card">
        <p className="eyebrow">Admin · land</p>
        <h1>Not your queue</h1>
        <p className="lead">{refusal}</p>
        <RolePicker current={roles} />
      </div>
    );
  }

  /**
   * Mirrors canReviewCase(roles, 'LAND_DOCUMENTS') in packages/core.
   *
   * Duplicated here on purpose, and only to decide what to render. The API
   * runs the real check with the case in hand; this one going stale would
   * show a button that gets refused, never let a decision through.
   */
  const canAct = roles.includes("legal") || roles.includes("super_admin");

  return (
    <>
      <div className="card">
        <p className="eyebrow">Admin · land</p>
        <h1>
          {documents.length === 0 && parcels.length === 0
            ? "Nothing waiting"
            : `${documents.length} document${documents.length === 1 ? "" : "s"}, ${parcels.length} plot${parcels.length === 1 ? "" : "s"}`}
        </h1>
        <p className="lead">
          Reviewing as <strong>{roles.join(", ")}</strong>. Opening any document
          issues a link that expires in a minute and records the access against
          your name.
        </p>

        {!canAct && (
          <div className="alert" role="status">
            Land decisions are Legal&rsquo;s. You can read this queue and open
            the documents — every view is logged — but the decisions are not
            yours to record.
          </div>
        )}

        <RolePicker current={roles} />
      </div>

      {/* ---------------- documents ---------------- */}

      <div className="card">
        <p className="eyebrow">Documents</p>
        <h2 style={{ marginTop: 0 }}>Is the scan good enough?</h2>
        <p className="lead">
          Only documents a person needs to look at: two or more fields read
          below the confidence floor, or nothing read at all. A clean, legible
          upload never reaches this list.
        </p>

        {documents.length === 0 ? (
          <p className="submono">
            Nothing here. Upload a faded or blank scan from the customer side to
            see one.
          </p>
        ) : (
          documents.map((document) => (
            <div className="notice" key={document.id}>
              <div className="verdict">
                <strong>{DOC_LABEL[document.docType] ?? document.docType}</strong>
                <span className="pill">
                  {document.lowConfidenceFieldCount === 0
                    ? "nothing read"
                    : `${document.lowConfidenceFieldCount} fields unclear`}
                </span>
              </div>
              <p className="submono">
                Scan {document.scanStatus} · waiting {waitingFor(document.createdAt)}
              </p>
              <DocumentActions
                documentId={document.id}
                scanStatus={document.scanStatus}
                canAct={canAct}
              />
            </div>
          ))
        )}
      </div>

      {/* ---------------- parcels ---------------- */}

      <div className="card">
        <p className="eyebrow">Plots</p>
        <h2 style={{ marginTop: 0 }}>May this land be leased?</h2>
        <p className="lead">
          A different question from the one above. The paperwork can be
          flawless and the plot still unusable — because the record names other
          holders, or because somebody else registered the same khasra number
          first.
        </p>

        {parcels.length === 0 ? (
          <p className="submono">No plots waiting on a decision.</p>
        ) : (
          parcels.map((parcel) => (
            <Parcel key={parcel.id} parcel={parcel} canAct={canAct} />
          ))
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Parcel({
  parcel,
  canAct,
}: {
  parcel: ParcelView;
  canAct: boolean;
}) {
  const needsConsent = parcel.reasons.some(
    (r) => r.code === "LAND_CO_OWNER_CONSENT_REQUIRED",
  );

  return (
    <div className="notice">
      <div className="verdict">
        <strong>
          Khasra <span className="mono">{parcel.khasraNumber}</span>
          {parcel.village ? ` · ${parcel.village}` : ""}
          {parcel.district ? `, ${parcel.district}` : ""}
        </strong>
        <span className="pill">{parcel.verificationStatus}</span>
      </div>

      <div className="kv">
        <div className="kv-row">
          <span>Name on the record</span>
          <span>
            {parcel.ownerNameOnRecord ?? "—"}
            {parcel.ownerNameMatchScore !== null && (
              <span className="submono">
                {" "}
                {Math.round(Number(parcel.ownerNameMatchScore) * 100)}% against the
                verified name
              </span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span>Other holders</span>
          <span>
            {parcel.coOwnerNames.length === 0
              ? "none declared"
              : parcel.coOwnerNames.join(", ")}
          </span>
        </div>
        <div className="kv-row">
          <span>Documents approved</span>
          <span>{parcel.documentsApproved ? "yes" : "not yet"}</span>
        </div>
        <div className="kv-row">
          <span>Waiting</span>
          <span>{waitingFor(parcel.createdAt)}</span>
        </div>
      </div>

      {parcel.reasons.length > 0 && (
        <ul>
          {parcel.reasons.map((reason) => (
            <li key={reason.code}>
              <strong className="mono">{reason.code}</strong>
              {reason.severity === "FLAG" ? " (blocks nothing) " : " "}
              — {reason.detail}
            </li>
          ))}
        </ul>
      )}

      {needsConsent ? (
        <ConsentActions
          parcelId={parcel.id}
          coOwnerNames={parcel.coOwnerNames}
          canAct={canAct}
        />
      ) : (
        <p className="submono">
          Nothing to decide here directly — this plot clears when the reasons
          above are resolved. The verdict is worked out again each time
          anything underneath it changes.
        </p>
      )}
    </div>
  );
}
