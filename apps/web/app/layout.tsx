import type { Metadata } from "next";
import "./globals.css";
import { currentUserId, devEnvironment, type DevEnvironment } from "../lib/api";
import { Nav } from "./Nav";
import { THEME_STORAGE_KEY, ThemeToggle } from "./ThemeToggle";

export const metadata: Metadata = {
  title: "KiloWattX — Verification",
  description:
    "Identity verification for investors, land owners and commercial users.",
};

/*
 * Applies the saved theme before the first paint.
 *
 * It has to be inline and synchronous. Anything that waits for React — or even
 * for a separate script file to be fetched — paints the default theme first,
 * so a person who chose dark gets a white flash on every navigation. That
 * flash is worse on this app than most: the pages are mostly white cards, so
 * it is a full-screen one.
 *
 * Wrapped in try/catch because reading localStorage throws outright in a
 * private window with site data blocked, and an exception here would take the
 * whole document with it. Failing to the media query is the correct fallback.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

/**
 * The shell.
 *
 * Two rows rather than one. Brand, environment and identity answer "where am
 * I and who am I"; the navigation answers "where can I go". They were in one
 * wrapping flex row, which at phone width collapsed into a ragged block three
 * deep and pushed the page into a horizontal scroll.
 *
 * The environment chip is not decoration. Anyone looking at a screen here
 * should be able to tell at a glance whether a real identity is being checked.
 * It was hardcoded to the fake vendor, and kept saying "nothing is really
 * verified" after the API moved to DigiLocker on a live key — so it now asks
 * the API, which is the only thing that knows.
 */
function envChip(env: DevEnvironment | null): { label: string; className: string } {
  if (!env) {
    return { label: "Vendor unknown · API not answering", className: "chip-env chip-env-unknown" };
  }

  if (env.kycProvider === "fake") {
    return { label: "Fake vendor · nothing is really verified", className: "chip-env" };
  }

  const vendor = env.kycProvider === "digilocker" ? "DigiLocker" : env.kycProvider;
  return env.vendorEnvironment === "live"
    ? { label: `${vendor} · live · real identities`, className: "chip-env chip-env-live" }
    : { label: `${vendor} · vendor test host`, className: "chip-env" };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [userId, env] = await Promise.all([currentUserId(), devEnvironment()]);
  const chip = envChip(env);

  return (
    /*
     * suppressHydrationWarning, for this element only: the script above adds
     * `data-theme` to <html> before React hydrates, so the markup React
     * rendered on the server and the DOM it finds differ by that one
     * attribute. It is the intended behaviour, not a bug to be warned about.
     */
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Devanagari:wght@400;600&display=swap"
        />
      </head>
      <body>
        {/*
          Every page carries six navigation links before its content. A keyboard
          or screen-reader user should not have to walk past them each time.
        */}
        <a className="skip" href="#main">
          Skip to content
        </a>

        <header className="topbar">
          <div className="topbar-in">
            <div className="topbar-id">
              <span className="brand">KiloWattX</span>
              <span className={chip.className}>{chip.label}</span>
              {userId ? (
                <span className="whoami" title="The selected development identity">
                  {userId.slice(0, 8)}…
                </span>
              ) : (
                <span className="whoami whoami-none">no identity</span>
              )}

              <ThemeToggle />
            </div>

            <Nav />
          </div>
        </header>

        <main className="shell" id="main">
          {children}
        </main>
      </body>
    </html>
  );
}
