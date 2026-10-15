import { ApiCallError, api, currentStaffRoles, currentUserId } from "../../lib/api";
import type { QueueResponse } from "../../lib/adminTypes";
import { RolePicker } from "./RolePicker";

/**
 * The manual review queue.
 *
 * Oldest first, because the number that matters is how long somebody has been
 * waiting on a decision about their own identity. A queue sorted by anything
 * else lets the awkward cases sink to the bottom and stay there.
 */

const CASE_TYPE_LABEL: Record<string, string> = {
  PERSONAL: "Personal",
  KYB: "Business",
  LAND_DOCUMENTS: "Land papers",
};

const REASON_LABEL: Record<string, string> = {
  FACE_MATCH_LOW: "Low face match",
  LIVENESS_FAILED: "Liveness failed",
  PAN_NAME_MISMATCH: "PAN name mismatch",
  PAN_DOB_MISMATCH: "PAN date of birth mismatch",
  PAN_ALREADY_USED: "Duplicate PAN",
  AADHAAR_NOT_VERIFIED: "Aadhaar not returned",
  DOCUMENT_LOW_CONFIDENCE: "Document hard to read",
  SIGNATORY_NOT_VERIFIED: "Signatory not verified",
  DEVICE_UNTRUSTED: "Device not trusted",
};

export default async function AdminQueue() {
  const userId = await currentUserId();
  const roles = await currentStaffRoles();

  if (!userId) {
    return (
      <div className="card">
        <h1>Pick an identity first</h1>
        <p className="lead">
          The review queue needs to know who is reviewing, because every
          decision is recorded against a name.
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
        <p className="eyebrow">Admin · review queue</p>
        <h1>Choose a staff role</h1>
        <p className="lead">
          Which cases you can act on depends on your role. Support and
          compliance clear personal cases; only Legal decides a board
          resolution or a sale deed.
        </p>
        <RolePicker current={roles} />
      </div>
    );
  }

  let queue: QueueResponse;
  try {
    queue = await api<QueueResponse>("/v1/admin/kyc/reviews");
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 404) {
      return (
        <div className="card">
          <h1>Not found</h1>
          <p className="lead">
            This identity has no staff role, so the queue does not exist for it.
          </p>
          <RolePicker current={roles} />
        </div>
      );
    }
    throw error;
  }

  return (
    <>
      <div className="card">
        <p className="eyebrow">Admin · review queue</p>
        <h1>
          {queue.health.open === 0
            ? "Nothing waiting"
            : `${queue.health.open} case${queue.health.open === 1 ? "" : "s"} waiting`}
        </h1>

        {queue.health.oldestHours !== null && queue.health.oldestHours >= 24 ? (
          <div className="alert" role="status">
            The oldest case has been waiting {Math.floor(queue.health.oldestHours / 24)}{" "}
            day(s). In production this is what the queue-age alert watches.
          </div>
        ) : null}

        <p className="lead">
          Reviewing as <strong>{roles.join(", ")}</strong>. The pass mark for a
          face match is currently{" "}
          <span className="mono">{queue.thresholds.faceMatch}</span>, held in the
          settings table so it can be retuned without a release.
        </p>

        <RolePicker current={roles} />
      </div>

      {queue.rows.length === 0 ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>The queue is empty</h2>
          <p className="lead">
            Run a verification that needs a human — the &ldquo;old Aadhaar
            photo&rdquo; or &ldquo;PAN name differs&rdquo; scenario will land
            here.
          </p>
          <a className="btn ghost" href="/">
            Start one
          </a>
        </div>
      ) : (
        <div className="card">
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Kind</th>
                  <th>Why it is here</th>
                  <th>Score</th>
                  <th>Waiting</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.subjectName ?? "Unnamed"}</strong>
                      <br />
                      <span className="submono">{row.level}</span>
                    </td>
                    <td>
                      <span className="pill n">
                        {CASE_TYPE_LABEL[row.caseType] ?? row.caseType}
                      </span>
                    </td>
                    <td>
                      {row.reasonCodes.map((code) => (
                        <div key={code}>
                          {REASON_LABEL[code] ?? code}
                          <br />
                          <span className="submono">{code}</span>
                        </div>
                      ))}
                    </td>
                    <td className="mono">
                      {row.faceMatchScore === null ? (
                        <span style={{ color: "var(--ink-3)" }}>—</span>
                      ) : (
                        row.faceMatchScore.toFixed(2)
                      )}
                    </td>
                    <td className="mono">
                      {row.waitingHours < 1 ? "<1h" : `${row.waitingHours}h`}
                    </td>
                    <td>
                      {row.actionable ? (
                        <a className="btn ghost small" href={`/admin/${row.id}`}>
                          Review →
                        </a>
                      ) : (
                        <span
                          className="pill r"
                          title="Your role cannot decide this kind of case"
                        >
                          Not yours
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="footnote">
            Cases outside your remit are listed but not actionable, rather than
            hidden. A reviewer who can see Legal&rsquo;s backlog without being
            able to touch it is more use than one for whom those cases do not
            exist — otherwise nobody notices a week-old pile.
          </p>
        </div>
      )}
    </>
  );
}
