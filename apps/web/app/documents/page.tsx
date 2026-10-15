import Link from "next/link";
import { currentUserId } from "../../lib/api";
import { listParcels } from "./actions";
import { ParcelList } from "./ParcelList";
import { UploadPanel } from "./UploadPanel";

/**
 * Land documents.
 *
 * The step between "we know who you are" and "we can sign a lease with you":
 * the land records that say the person we verified is the person who owns the
 * plot. Everything a reviewer eventually decides starts with a file uploaded
 * here.
 */
export const metadata = {
  title: "Land documents · KiloWattX",
};

export default async function DocumentsPage() {
  const userId = await currentUserId();

  if (!userId) {
    return (
      <main className="shell">
        <p className="eyebrow">Land documents</p>
        <h1>Pick an identity first</h1>
        <p className="lead">
          Documents belong to a person. Choose who you are and come back.
        </p>
        <Link className="btn" href="/">
          Choose an identity
        </Link>
      </main>
    );
  }

  /**
   * Read after the identity check, not before: an anonymous visitor would get
   * a 401 from the API and the page would show an error where it should be
   * showing a sign-in prompt.
   */
  const parcels = await listParcels();

  return (
    <main className="shell">
      <p className="eyebrow">Step 3 · Land documents</p>
      <h1>Upload your land records</h1>
      <p className="lead">
        A Jamabandi or Khasra&nbsp;Khatauni showing the plot, plus the sale deed
        if the land changed hands recently. We read what we can off the scan so
        you only check it rather than type it.
      </p>

      <div className="notice">
        <div className="notice-head">What happens to the file</div>
        <ul>
          <li>
            It uploads <strong>straight to private storage</strong> — it never
            passes through the application server.
          </li>
          <li>
            It is <strong>scanned for malware</strong> before anything else
            touches it. A file that fails cannot be opened by anyone, including
            our own reviewers.
          </li>
          <li>
            We read the khasra number, owner name and area, and tell you how
            confident we are in each. Anything we could not read clearly goes
            to a person.
          </li>
          <li>
            Every time it is opened — by you or by us — that is{" "}
            <strong>written to an audit log</strong> with who opened it and
            when. Links expire after a minute.
          </li>
        </ul>
      </div>

      <UploadPanel />

      {parcels.error ? (
        <div className="alert" role="alert">
          We could not load your plots: {parcels.error.message}
        </div>
      ) : (
        <ParcelList parcels={parcels.parcels ?? []} />
      )}

      <p className="footnote">
        Kept for seven years, per the retention policy, then disposed of. You
        can ask us to delete your account at any time; documents a tax or land
        record requires us to keep will say so.
      </p>
    </main>
  );
}
