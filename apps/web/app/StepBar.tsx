/**
 * The four-segment progress rail and the back arrow above every step.
 *
 * A server component: it takes a number and draws, so it costs no JavaScript
 * on a screen whose whole job is to be fast on a phone.
 */
export function StepBar({ step, back }: { step: 1 | 2 | 3 | 4; back?: string }) {
  return (
    <div className="flowtop">
      {back ? (
        <a className="backlink" href={back} aria-label="Go back">
          ←
        </a>
      ) : (
        /** Keeps the rail in the same place on the first screen. */
        <span className="backlink" aria-hidden="true" style={{ visibility: "hidden" }}>
          ←
        </span>
      )}

      <div
        className="steps"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={4}
        aria-valuenow={step}
        aria-label={`Step ${step} of 4`}
      >
        {[1, 2, 3, 4].map((n) => (
          <i key={n} className={n <= step ? "on" : undefined} />
        ))}
      </div>
    </div>
  );
}
