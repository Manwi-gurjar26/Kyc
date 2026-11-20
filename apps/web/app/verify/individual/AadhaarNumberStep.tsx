"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { isValidAadhaarNumber } from "@kilowattx/validation";
import { confirmAadhaarOtp, sendAadhaarOtp } from "../actions";

/**
 * The Aadhaar step, by number: twelve digits, an OTP to the mobile registered
 * with UIDAI, and the six digits back.
 *
 * The number is checked here with the same Verhoeff checksum the API uses, so
 * a mistyped digit is caught before it costs a gateway call, and the person
 * hears about it at the field rather than after a round trip.
 *
 * On success the page is refreshed rather than advanced locally. Which step
 * comes next is the server's to say (`remainingSteps`), the same as when
 * somebody comes back from DigiLocker, so both routes land on the same PAN and
 * selfie screen by the same path.
 *
 * Today this route fails on live keys — UIDAI deprecated OKYC and the gateway
 * answers 503 — so a failure to send says so plainly and offers DigiLocker.
 */

type Stage = "number" | "otp";

/** Groups as the card prints it: 0000 0000 0000. */
function group(value: string): string {
  return value.replace(/\D/g, "").slice(0, 12).replace(/(\d{4})(?=\d)/g, "$1 ");
}

export function AadhaarNumberStep({ onUseDigiLocker }: { onUseDigiLocker: () => void }) {
  const router = useRouter();
  const [aadhaar, setAadhaar] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState<Stage>("number");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; offerDigiLocker: boolean } | null>(
    null,
  );
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const digits = aadhaar.replace(/\D/g, "");
  const complete = digits.length === 12;
  const valid = complete && isValidAadhaarNumber(digits);

  function requestOtp() {
    setError(null);
    start(async () => {
      const result = await sendAadhaarOtp(digits);
      if (result.error) {
        /**
         * The gateway being unable to send is the expected failure on live
         * keys, and the fix is the other route — not retrying the same one.
         */
        /**
         * Three cases, told apart by code:
         *  - AADHAAR_UNAVAILABLE: this route is down; say so, offer DigiLocker.
         *  - AADHAAR_CHECK_FAILED: the gateway judged the request and said
         *    why. Its message is written for the person ("invalid Aadhaar",
         *    "too many attempts"), so it is shown as-is — this used to be
         *    replaced by the generic line, which hid the only real detail.
         *  - anything else (VERIFICATION_UNAVAILABLE: our account cannot call
         *    the gateway at all): no DigiLocker offer, since it shares that
         *    account and would fail the same way.
         */
        const unavailable = result.error.code === "AADHAAR_UNAVAILABLE";
        const refused = result.error.code === "AADHAAR_CHECK_FAILED";
        setError({
          message: unavailable
            ? "We couldn't send an OTP for this number right now. Verifying through DigiLocker works instead."
            : result.error.message,
          offerDigiLocker: unavailable || refused,
        });
        return;
      }
      setSentTo(result.sentTo ?? null);
      setStage("otp");
    });
  }

  function submitOtp() {
    setError(null);
    start(async () => {
      const result = await confirmAadhaarOtp(otp);
      if (result.error) {
        setError({ message: result.error.message, offerDigiLocker: false });
        return;
      }
      setDone(
        result.nameOnRecord
          ? `Aadhaar verified for ${result.nameOnRecord}`
          : "Aadhaar verified",
      );
      router.refresh();
    });
  }

  function changeNumber() {
    setStage("number");
    setOtp("");
    setSentTo(null);
    setError(null);
  }

  return (
    <div className="frow">
      <div className="frow-top">
        <label htmlFor="aadhaar">Aadhaar number</label>
        <span className="tag">OTP to your mobile</span>
      </div>

      <div className="frow-in">
        <input
          id="aadhaar"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="0000 0000 0000"
          aria-describedby="aadhaar-hint"
          aria-invalid={complete && !valid}
          value={aadhaar}
          disabled={stage !== "number" || pending}
          onChange={(event) => setAadhaar(group(event.target.value))}
        />
        {stage === "number" ? (
          <button
            type="button"
            className="inlinebtn"
            disabled={!valid || pending}
            onClick={requestOtp}
          >
            {pending ? "Sending…" : "Get OTP →"}
          </button>
        ) : (
          <button type="button" className="inlinebtn ghostbtn" onClick={changeNumber}>
            Change
          </button>
        )}
      </div>

      <p className="hint" id="aadhaar-hint">
        {complete && !valid
          ? "That isn't a valid Aadhaar number. Check the digits against your card."
          : "We never store the full number, only the last four digits."}
      </p>

      {stage === "otp" ? (
        <>
          <p className="otpnote" role="status">
            {sentTo ? `OTP sent to ${sentTo}.` : "OTP sent to the mobile registered with UIDAI."}
          </p>
          <div className="frow-in">
            <input
              id="otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit OTP"
              aria-label="Aadhaar OTP"
              value={otp}
              disabled={pending || done !== null}
              onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <button
              type="button"
              className="inlinebtn"
              disabled={otp.length !== 6 || pending || done !== null}
              onClick={submitOtp}
            >
              {pending ? "Checking…" : "Verify →"}
            </button>
          </div>
        </>
      ) : null}

      {done ? (
        <div className="okchip" role="status">
          <span aria-hidden="true">✓</span>
          <span>
            {done} · ⋯{digits.slice(-4)}
          </span>
          <span className="src">UIDAI</span>
        </div>
      ) : null}

      {error ? (
        <div className="alert" role="alert" style={{ marginTop: 10 }}>
          {error.message}
          {error.offerDigiLocker ? (
            <>
              {" "}
              <button type="button" className="linkbtn" onClick={onUseDigiLocker}>
                Use DigiLocker instead
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
