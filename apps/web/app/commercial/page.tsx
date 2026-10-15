import { api, currentUserId } from "../../lib/api";
import type { KybExample, OrganisationView } from "../../lib/kybTypes";
import { currentOrgId } from "./actions";
import { ConsentGate } from "./ConsentGate";
import { KybFlow } from "./KybFlow";

/**
 * The Commercial User path.
 *
 * Two independent questions, and the page is honest about both: is the
 * business real and in good standing, and is the person signing allowed to
 * bind it. A perfectly sound company whose signatory has not verified
 * themselves is not a verified business, and the screen says so rather than
 * leaving somebody guessing which half is stuck.
 *
 * Which steps exist comes from the API, never from this file. A
 * proprietorship has no company register, and a second definition of the flow
 * in the browser would eventually disagree with the one that decides.
 */
export default async function CommercialPage() {
  const userId = await currentUserId();

  if (!userId) {
    return (
      <div className="card">
        <p className="eyebrow">Commercial User · PPA</p>
        <h1>Pick an identity first</h1>
        <p className="lead">
          A business check attaches you to the business, and pulls your own
          Aadhaar, PAN and selfie in behind it. So we need to know who you are.
        </p>
        <a className="btn" href="/">
          Go back
        </a>
      </div>
    );
  }

  const orgId = await currentOrgId();

  let organisation: OrganisationView | null = null;
  if (orgId) {
    organisation = await api<OrganisationView>(
      `/v1/kyb/organisations/${orgId}`,
    ).catch(() => null);
  }

  /**
   * Example identifiers, computed by the API from the provider's own
   * derivation. A GSTIN carries a mod-36 check digit and a CIN has to produce
   * a company name that agrees with the GST legal name, so a hand-typed
   * example is almost always rejected — and the first ten minutes go on
   * fighting a checksum instead of looking at the flow.
   */
  const examples = await api<{ examples: KybExample[] }>(
    "/v1/dev/kyc-sessions/kyb-examples",
    { method: "POST", authenticated: false },
  )
    .then((r) => r.examples)
    .catch(() => []);

  /**
   * Asked, not inferred. An earlier version fired a throwaway lookup and read
   * the error code, which was both a pointless side effect and wrong —
   * validation runs before the consent check, so the probe was rejected for
   * the wrong reason.
   */
  const { purposes } = await api<{ purposes: string[] }>("/v1/kyc/consents");
  const needsConsent = !purposes.includes("KYB_VERIFICATION");

  return (
    <>
      <div className="card">
        <p className="eyebrow">Commercial User · before the PPA</p>
        <h1>Verify your business</h1>
        <p className="lead">
          Two things have to check out before a power purchase agreement can be
          signed: that the business is real and in good standing, and that the
          person signing is allowed to bind it for twenty-five years.
        </p>
      </div>

      {needsConsent ? (
        <ConsentGate />
      ) : (
        <KybFlow organisation={organisation} examples={examples} />
      )}

      <p className="footnote">
        No business is really being verified. GST, MCA and PAN lookups run
        against the fake adapter, which derives its answers from the
        identifiers themselves — a GSTIN genuinely contains the business PAN at
        characters 3 to 12, and that PAN&rsquo;s 4th character genuinely says
        whether this is a company, a firm or a proprietorship. Signzy or IDfy
        replaces it behind the same interface.
      </p>
    </>
  );
}
