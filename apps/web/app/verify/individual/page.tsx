import { StepBar } from "../../StepBar";
import { IndividualForm } from "./IndividualForm";

export const metadata = {
  title: "Individual verification · KiloWattX",
};

export default function IndividualPage() {
  return (
    <div className="flow">
      <StepBar step={2} back="/" />

      <p className="stepnote">Step 2 of 4 · KYC</p>
      <h1>Individual verification</h1>
      <p className="flowlead">
        Aadhaar OTP through the government gateway, then a PAN name match.
      </p>

      <IndividualForm />
    </div>
  );
}
