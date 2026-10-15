/**
 * Asserts the two dark palettes in globals.css are the same palette.
 *
 * There are two, and there have to be. The media query is what makes the right
 * theme appear on first paint and with JavaScript disabled; the
 * `[data-theme="dark"]` attribute is the only thing that can override the
 * operating system in either direction. CSS gives no way to share one
 * declaration block between a media query and a plain selector, so the values
 * are written twice.
 *
 * Duplication you cannot verify is the actual problem, not duplication. Two
 * palettes that drifted apart would mean a toggled-dark page rendering in
 * subtly different colours from an OS-dark one — and nobody would catch it,
 * because nobody looks at both. So this runs as part of `typecheck`: edit one
 * block and the build tells you to edit the other.
 *
 * It also checks that every token in the light palette has a dark value. A
 * token with no dark counterpart silently keeps its light value, which is how
 * you end up with one near-black label on a near-black card.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "globals.css");
const css = readFileSync(CSS_PATH, "utf8");

/** Strips comments and blank lines, so formatting is not what is compared. */
function declarations(block) {
  return block
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("--"))
    .sort();
}

function must(pattern, what) {
  const match = pattern.exec(css);
  if (!match) {
    console.error(`check-theme-parity: could not find ${what} in app/globals.css.`);
    console.error("  If the block was renamed or restructured, update this check too —");
    console.error("  a check that silently stops checking is worse than no check.");
    process.exit(1);
  }
  return match[1];
}

const mediaDark = must(
  /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}\s*\}/,
  'the media-query dark palette',
);

const forcedDark = must(
  /:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/,
  'the [data-theme="dark"] palette',
);

const lightPalette = must(/:root \{([\s\S]*?)\n\}/, "the light palette");

/* ---- 1. the two dark palettes must agree ---- */

const a = declarations(mediaDark);
const b = declarations(forcedDark);

const problems = [];

for (const decl of a) {
  if (!b.includes(decl)) problems.push(`  only in the media query:        ${decl}`);
}
for (const decl of b) {
  if (!a.includes(decl)) problems.push(`  only in [data-theme="dark"]:    ${decl}`);
}

/* ---- 2. every light token needs a dark value ---- */

const nameOf = (decl) => decl.slice(0, decl.indexOf(":")).trim();
const darkNames = new Set(b.map(nameOf));

for (const decl of declarations(lightPalette)) {
  const name = nameOf(decl);
  /** Not a colour, so it has no business changing with the theme. */
  if (name === "--display" || name === "--body" || name === "--mono") continue;
  if (!darkNames.has(name)) {
    problems.push(`  no dark value, inherits light:  ${name}`);
  }
}

if (problems.length > 0) {
  console.error("check-theme-parity: the dark palettes do not match.\n");
  console.error(problems.join("\n"));
  console.error("\nBoth blocks describe the same theme. Make them say the same thing.");
  process.exit(1);
}

console.log(
  `check-theme-parity: ok — ${a.length} dark declarations, identical in both blocks.`,
);
