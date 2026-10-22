import { StepBar } from "../../StepBar";
import { HostedAadhaarStep } from "./HostedAadhaarStep";
import { PanAndSelfieStep } from "./PanAndSelfieStep";
import { api, type KycStatusView } from "../../../lib/api";

export const metadata = {
  title: "Individual verification · KiloWattX",
};

/**
 * Individual verification, in whatever state the person left it.
 *
 * Driven by `remainingSteps` from the API rather than by a stage held in the
 * component, which is what makes it survive the round trip to DigiLocker:
 * somebody leaves for a government site, comes back minutes later on a new
 * page load, and the server is the only thing that still knows how far they
 * got. A local stage would have reset to the beginning and asked them to
 * share their Aadhaar again.
 *
 * It is the same signal the business flow renders from, for the same reason.
 */
export default async function IndividualPage() {
  let status: KycStatusView | null = null;
  try {
    status = await api<KycStatusView>("/v1/kyc/me");
  } catch {
    /* No session yet, or the API is unreachable. Falls through to the Aadhaar
       step, which collects nothing and explains itself. */
  }

  /**
   * Aadhaar outstanding, or nothing known at all, means start at the
   * beginning. The hosted step asks for nothing, so it is also the safe
   * thing to show when the server could not be asked.
   */
  const needsAadhaar = !status || status.remainingSteps.includes("AADHAAR");

  return (
    <div className="flow">
      <StepBar step={2} back="/" />

      <p className="stepnote">Step 2 of 4 · KYC</p>
      <h1>Individual verification</h1>
      <p className="flowlead">
        {needsAadhaar
          ? "Your Aadhaar through DigiLocker, then a PAN name match."
          : "Your PAN and a photograph, and you are done."}
      </p>

      {needsAadhaar ? <HostedAadhaarStep /> : <PanAndSelfieStep />}
    </div>
  );
}
