/**
 * ZERO LEGACY BRANDING IN THE APPLICATION.
 *
 * The project is GTS Algo Research; the workspace is GTS Box. No earlier product name may
 * appear anywhere a user, an operator or a browser tab can see it.
 *
 * WHAT THIS SCANS: every file under src/ plus index.html — i.e. everything that becomes the
 * shipped bundle or the served document.
 *
 * WHAT IS DELIBERATELY EXEMPT, and why each one is safe:
 *
 *   • `contract/protocol.json` and the file generated from it are the BACKEND-OWNED wire
 *     contract, vendored verbatim and pinned by digest. The frontend must not edit them; a
 *     rename there is a coordinated backend change, not a frontend one.
 *   • `src/lib/boxSounds.ts` holds one localStorage key that predates the rebrand. It is a
 *     client-side sound on/off preference, invisible in the UI, and it is pinned by both a
 *     unit test and the CI bundle allow-list. Renaming it would silently reset a user
 *     preference for no user-visible benefit, so it stays and is documented instead.
 *
 * Anything else is a genuine leak and fails here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SRC = join(ROOT, "src");

/** Every legacy product name, in every casing the codebase has used. */
const LEGACY_BRANDING = /StrikeEdge|Strikedge|strikedge|STRIKEDGE|CalSpread|Calspread|calspread|Cal[ _]Spread|cal_spread/;

/**
 * Files exempt from the sweep, each for a reason stated in the header above.
 * Paths are repo-relative and matched exactly.
 */
const EXEMPT = new Set([
  // Backend-owned, digest-pinned wire contract. Vendored verbatim; never edited here.
  "src/api/contract.generated.ts",
  // One legacy localStorage key for a sound preference. Test- and CI-pinned; see header.
  "src/lib/boxSounds.ts",
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Every shipped source file, plus the served document. */
function shippedFiles() {
  return [...walk(SRC), join(ROOT, "index.html")].map((f) => ({
    path: relative(ROOT, f),
    text: readFileSync(f, "utf8"),
  }));
}

test("no legacy branding anywhere in src/ or index.html", () => {
  const offenders = [];
  for (const file of shippedFiles()) {
    if (EXEMPT.has(file.path)) continue;
    // Skip the temporary offline-typecheck stub if one is present locally; it is never
    // committed and is not part of the shipped bundle.
    if (file.path.includes("__offline-stubs")) continue;
    for (const [index, line] of file.text.split("\n").entries()) {
      if (LEGACY_BRANDING.test(line)) {
        offenders.push(`${file.path}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `legacy branding found in shipped source:\n${offenders.join("\n")}`,
  );
});

test("the exemptions still exist and still contain exactly what they are exempt for", () => {
  // An exemption that no longer applies is dead risk: it would silently excuse a NEW leak in
  // that file. So each one must still be justified.
  const generated = readFileSync(join(ROOT, "src", "api", "contract.generated.ts"), "utf8");
  assert.match(
    generated,
    /AUTO-GENERATED FROM THE VENDORED BACKEND CONTRACT/,
    "the generated contract module is exempt only because it is generated, not hand-written",
  );

  const sounds = readFileSync(join(ROOT, "src", "lib", "boxSounds.ts"), "utf8");
  const legacyLines = sounds
    .split("\n")
    .filter((line) => LEGACY_BRANDING.test(line))
    .map((line) => line.trim());
  assert.ok(legacyLines.length > 0, "the exemption is stale — remove it from EXEMPT");
  for (const line of legacyLines) {
    assert.match(
      line,
      /BOX_SOUND_STORAGE_KEY|localStorage key|preference/i,
      `boxSounds.ts is exempt ONLY for its storage key, but found: ${line}`,
    );
  }
});

test("the product names ARE present where they belong", () => {
  // The inverse check: proving old branding is absent is worthless if the new branding never
  // arrived either.
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  assert.match(html, /<title>GTS Algo Research<\/title>/);
  assert.match(html, /Algorithmic trading research and execution systems from Ghatsila\./);

  const wordmark = readFileSync(
    join(SRC, "components", "brand", "GTSWordmark.tsx"),
    "utf8",
  );
  assert.match(wordmark, /Algo Research/, "the public wordmark");
  assert.match(wordmark, /GTS Box/, "the workspace wordmark");
});

test("the package is named for the project", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "gts-algo-research-frontend");
  assert.doesNotMatch(JSON.stringify(pkg), LEGACY_BRANDING);
});
