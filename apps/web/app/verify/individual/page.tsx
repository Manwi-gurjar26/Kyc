import { StepBar } from "../../StepBar";
import { IndividualForm } from "./IndividualForm";
import { HostedAadhaarStep } from "./HostedAadhaarStep";
import { api, type KycStatusView } from "../../../lib/api";

export const metadata = {
  title: "Individual verification · KiloWattX",
};

/**
 * Two Aadhaar routes now exist, and the first screen differs entirely.
 *
 * Which one is a property of the deployment, not of the person, so the server
 * is asked rather than guessed at — and asked through the status endpoint,
 * which already knows. Rendering an Aadhaar number field for a gateway that
 * must never receive one is the wrong way to be wrong, so an unreachable API
 * falls back to the hosted step: it asks for nothing.
 */
export default async function IndividualPage() {
  let route: "OTP" | "HOSTED" = "HOSTED";
  try {
    const status = await api<KycStatusView>("/v1/kyc/me");
    route = status.aadhaarRoute;
  } catch {
    /* No session yet, or the API is down. The hosted step collects nothing
       and explains itself, which is the safe thing to show either way. */
  }

  return (
    <div className="flow">
      <StepBar step={2} back="/" />

      <p className="stepnote">Step 2 of 4 · KYC</p>
      <h1>Individual verification</h1>
      <p className="flowlead">
        {route === "HOSTED"
          ? "Your Aadhaar through DigiLocker, then a PAN name match."
          : "Aadhaar OTP through the government gateway, then a PAN name match."}
      </p>

      {route === "HOSTED" ? <HostedAadhaarStep /> : <IndividualForm />}
    </div>
  );
}
