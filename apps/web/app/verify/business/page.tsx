import { StepBar } from "../../StepBar";
import { BusinessForm } from "./BusinessForm";

export const metadata = {
  title: "Business verification · KiloWattX",
};

export default function BusinessPage() {
  return (
    <div className="flow">
      <StepBar step={2} back="/" />

      <p className="stepnote">Step 2 of 4 · KYC</p>
      <h1>Business verification</h1>
      <p className="flowlead">
        For a private limited company, an LLP, a partnership or a
        proprietorship.
      </p>

      <BusinessForm />
    </div>
  );
}
