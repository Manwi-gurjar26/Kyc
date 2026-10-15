"use client";

import { useEffect, useState } from "react";

/**
 * Light / dark / follow-the-system.
 *
 * Three choices rather than a two-state switch, because "use whatever the
 * machine is set to" is a real preference and the commonest one. A plain
 * on/off toggle throws it away the first time it is touched, with no way back
 * short of clearing site data.
 *
 * The attribute this writes is read by two CSS blocks: `[data-theme="light"]`
 * cancels the dark media query, and `[data-theme="dark"]` forces dark on a
 * light machine. `system` removes the attribute altogether and hands the
 * decision back to the media query — it does not resolve the preference and
 * write the answer, so a laptop that switches theme at sunset still follows
 * along with the page already open.
 */

export const THEME_STORAGE_KEY = "kwx-theme";

type Choice = "system" | "light" | "dark";

const CHOICES: { value: Choice; label: string; title: string }[] = [
  { value: "system", label: "Auto", title: "Follow this device's setting" },
  { value: "light", label: "Light", title: "Always light" },
  { value: "dark", label: "Dark", title: "Always dark" },
];

/**
 * The same three lines the inline script in the document head runs.
 *
 * Kept deliberately small and dependency-free: it is duplicated there as a
 * string, because it has to run before the first paint and anything imported
 * cannot.
 */
export function applyTheme(choice: Choice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

function stored(): Choice {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    /** Private windows and blocked site data throw rather than return null. */
    return "system";
  }
}

export function ThemeToggle() {
  /**
   * Null until mounted, so the server and the first client render agree.
   *
   * The server cannot know what is in localStorage, so rendering a pressed
   * button during SSR would be a hydration mismatch. The theme itself is
   * already correct by this point — the inline script in the head set the
   * attribute before anything painted — so what is briefly unresolved is only
   * which of the three buttons is marked, not the colours of the page.
   */
  const [choice, setChoice] = useState<Choice | null>(null);

  useEffect(() => {
    setChoice(stored());
  }, []);

  function pick(next: Choice) {
    setChoice(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /** The choice still applies to this page; it just will not be remembered. */
    }
  }

  return (
    <div className="themetoggle" role="group" aria-label="Colour theme">
      {CHOICES.map((item) => (
        <button
          key={item.value}
          type="button"
          className="themebtn"
          title={item.title}
          aria-pressed={choice === item.value}
          onClick={() => pick(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
