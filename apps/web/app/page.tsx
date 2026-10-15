import { ChooseKycType } from "./ChooseKycType";
import { StepBar } from "./StepBar";

/**
 * Where somebody arriving to be verified starts.
 *
 * There is no identity to pick here any more. A visitor from outside has no
 * business choosing a row from a list of existing users — that list was
 * development scaffolding standing in for sign-in, and it had no place on the
 * path a real person walks. A session is created for them on Continue, and
 * Better Auth replaces that with a real phone-OTP sign-in without this screen
 * changing.
 */
export const metadata = {
  title: "Choose KYC type · KiloWattX",
};

export default function Home() {
  return (
    <div className="flow">
      <StepBar step={1} />

      <p className="stepnote">Step 1 of 4 · KYC</p>
      <h1>Choose KYC type</h1>
      <p className="flowlead">
        Select your entity to load the required identity fields.
      </p>

      <ChooseKycType />
    </div>
  );
}
