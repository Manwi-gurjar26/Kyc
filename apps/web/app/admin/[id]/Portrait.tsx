/**
 * Drawn portrait placeholders.
 *
 * Deliberately obviously drawn. The fake vendor returns scores but no
 * photographs, and generating something that looked like a real face would
 * make this screen lie about what it is showing a reviewer — on the one screen
 * where the whole point is looking carefully at evidence.
 *
 * The Aadhaar variant is rendered small, desaturated and grainy, because that
 * is the actual problem: UIDAI photographs are often a decade old and a few
 * hundred pixels wide, which is why a weak face match usually means an old
 * photo rather than a different person.
 */
export function Portrait({
  seed,
  variant,
  src,
}: {
  seed: string;
  variant: "selfie" | "aadhaar";
  /**
   * The real photograph, when there is one.
   *
   * Given a URL this renders the actual image, which is the whole point now:
   * no gateway this system can reach sells a face match, so a reviewer
   * comparing these two by eye IS the face check. The drawn placeholder below
   * stays for when there is nothing to show — the fake gateway returns no
   * photograph, and a case can reach review before a selfie is uploaded.
   */
  src?: string | null;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt={
          variant === "aadhaar"
            ? "The Aadhaar photograph held by UIDAI"
            : "The selfie taken during verification"
        }
        /**
         * The Aadhaar image keeps the aged treatment because the image really
         * is old and small — it is not decoration. Making a decade-old
         * passport photo look crisp invites a reviewer to read a difference
         * as a different person.
         */
        className={variant === "aadhaar" ? "portrait aged" : "portrait"}
      />
    );
  }

  /** Stable per case, so the same case always looks the same. */
  const hash = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 9973, 7);
  const skins = ["#C98E63", "#B9825C", "#D8A77B", "#A9714C"];
  const shirts = ["#44565E", "#5A4A42", "#3E5A4E", "#4A4458"];
  const skin = skins[hash % skins.length]!;
  const shirt = shirts[(hash >> 2) % shirts.length]!;
  const old = variant === "aadhaar";
  const filterId = `grain-${variant}-${hash}`;

  return (
    <svg
      viewBox="0 0 120 120"
      role="img"
      aria-label={
        old
          ? "Placeholder standing in for the Aadhaar photograph"
          : "Placeholder standing in for the selfie"
      }
      className={old ? "portrait aged" : "portrait"}
    >
      {old ? (
        <defs>
          <filter id={filterId}>
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" />
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.18" />
            </feComponentTransfer>
          </filter>
        </defs>
      ) : null}

      <rect width="120" height="120" fill={old ? "#CFD3CB" : "#DFE5E3"} />
      <path
        d="M18 120c0-21 19-31 42-31s42 10 42 31z"
        fill={shirt}
      />
      <ellipse cx="60" cy="56" rx="25" ry="29" fill={skin} />
      <path
        d="M35 50c0-19 11-27 25-27s25 8 25 27c-7-11-15-14-25-14s-18 3-25 14z"
        fill="#2B1F18"
      />
      <ellipse cx="51" cy="56" rx="2.6" ry="3.2" fill="#23201D" />
      <ellipse cx="69" cy="56" rx="2.6" ry="3.2" fill="#23201D" />
      <path
        d="M53 71q7 5 14 0"
        stroke="#8A5B42"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />

      {old ? (
        <>
          <rect width="120" height="120" filter={`url(#${filterId})`} opacity="0.9" />
          <rect width="120" height="120" fill="#8A8F86" opacity="0.14" />
        </>
      ) : null}
    </svg>
  );
}
