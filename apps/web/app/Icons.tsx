/**
 * The handful of line icons the flow uses.
 *
 * Inline SVG rather than emoji or text glyphs. The padlock was the platform's
 * colour emoji — a yellow cartoon beside grey 11px type — and the "requires"
 * marker was ⌦, the erase-to-the-right key, which says "delete" to anyone who
 * recognises it. These draw in `currentColor` at one stroke weight, so they
 * take the colour of the text they sit in, in either theme.
 *
 * Decorative: the sentence beside each one says the same thing.
 */

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="icon"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function LockIcon() {
  return (
    <Svg>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  );
}

/** A document with a fold: what the option will ask you for. */
export function DocumentIcon() {
  return (
    <Svg>
      <path d="M4 1.75h5l3 3v9.5H4z" />
      <path d="M9 1.75v3h3M6 8.5h4M6 11h4" />
    </Svg>
  );
}
