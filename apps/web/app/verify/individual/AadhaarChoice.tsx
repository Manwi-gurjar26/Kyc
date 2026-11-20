"use client";

import { useState } from "react";
import { AadhaarNumberStep } from "./AadhaarNumberStep";
import { HostedAadhaarStep } from "./HostedAadhaarStep";

/**
 * Two ways to prove an Aadhaar, chosen by the person.
 *
 * DigiLocker first and pre-selected: it is the route that works on live keys,
 * and on it our site never sees the number. The number route is the one many
 * people expect — type it, get an OTP — so it is offered beside it rather
 * than hidden.
 *
 * Toggle buttons on [aria-pressed], the same pattern as the KYC type cards and
 * the theme switch, so the look and what a screen reader announces come from
 * one attribute. (A role="radio" group would also owe arrow-key movement.)
 */

type Route = "digilocker" | "number";

const ROUTES: { value: Route; label: string; note: string }[] = [
  { value: "digilocker", label: "DigiLocker", note: "Recommended" },
  { value: "number", label: "Aadhaar number", note: "OTP to your mobile" },
];

export function AadhaarChoice() {
  const [route, setRoute] = useState<Route>("digilocker");

  return (
    <>
      <div className="routepick" role="group" aria-label="How to verify your Aadhaar">
        {ROUTES.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={route === option.value}
            className="routeopt"
            onClick={() => setRoute(option.value)}
          >
            <span className="routeopt-label">{option.label}</span>
            <span className="routeopt-note">{option.note}</span>
          </button>
        ))}
      </div>

      {route === "digilocker" ? (
        <HostedAadhaarStep />
      ) : (
        <AadhaarNumberStep onUseDigiLocker={() => setRoute("digilocker")} />
      )}
    </>
  );
}
