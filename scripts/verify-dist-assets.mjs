/**
 * verify:assets — every asset the built CSS/HTML asks for must actually be in dist/.
 *
 * WHY THIS EXISTS
 *   The landing page shipped with a hero backdrop referenced as `url("/ghatsila.jpg")` and no
 *   such file in the repository. Every stage of the pipeline reported success:
 *
 *     1. `vite build` printed a WARNING and exited 0 — a root-absolute url() is passed through
 *        untouched by design, because Vite cannot know whether the path will exist at runtime.
 *     2. CI's "Build output must exist" checked dist/index.html and dist/assets/*.js. Both were
 *        there, so CI was green.
 *     3. `rsync -a --delete dist/ /var/www/gts/` faithfully published a dist with no image.
 *     4. nginx's SPA fallback — `try_files $uri $uri/ /index.html` — has no file to serve, so it
 *        returns **index.html with HTTP 200 and Content-Type: text/html**. Not a 404.
 *
 *   Step 4 is why this was so hard to see: the browser gets HTTP 200, cannot decode HTML as an
 *   image, and `background-image` silently paints nothing. There is no console error and no failed
 *   request. A missing production asset looked exactly like a CSS bug.
 *
 *   So the check belongs at BUILD time, where the answer is knowable and cheap.
 *
 * WHAT IT PROVES
 *   1. dist/ exists and contains index.html.
 *   2. Every asset referenced by a root-absolute or relative `url(...)` in the built CSS, and by
 *      href/src/srcset in the built HTML, resolves to a real, NON-EMPTY file inside dist/.
 *   3. Everything in public/ was copied into dist/ with an identical byte length — which catches a
 *      broken `publicDir`, a partial copy, and a truncated asset.
 *
 *   Requirements are DERIVED FROM THE BUILD OUTPUT, not from a hand-maintained list. Add
 *   `url("/anything.png")` to the CSS tomorrow and it is covered with no change here; a list would
 *   have to be remembered, which is the failure mode this replaces.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not check remote URLs, data: URIs or `url(#svg-filter)` fragments — none of those are
 *   files this build is responsible for shipping. It does not fetch anything.
 *
 * USAGE
 *   node scripts/verify-dist-assets.mjs     exit 0 = every referenced asset is present
 *                                           exit 1 = something is missing, with the fix printed
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const PUBLIC = join(ROOT, "public");

const problems = [];
const verified = [];

const fail = (msg) => problems.push(msg);
const rel = (abs) => relative(ROOT, abs).split(sep).join("/");
const kb = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Every file under `dir`, as paths relative to `dir` with forward slashes. */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

// ── 1. the build produced something at all ───────────────────────────────────────────────────

if (!existsSync(DIST)) {
  console.error(`\nverify:assets FAILED — there is no dist/ directory.\n`);
  console.error(`  Run the build first:  npm run build\n`);
  process.exit(1);
}
if (!existsSync(join(DIST, "index.html"))) {
  fail(`dist/ exists but has no index.html — the build did not emit an entry point.`);
}

// ── 2. resolve every asset reference found in the built output ────────────────────────────────

/**
 * A reference is only this build's responsibility when it names a file we are shipping.
 * Remote, inline and fragment references are somebody else's problem by definition.
 */
function isCheckable(url) {
  if (!url) return false;
  if (url.startsWith("#")) return false;                 // url(#svg-filter-id)
  if (url.startsWith("data:")) return false;             // inlined by the bundler
  if (url.startsWith("//")) return false;                // protocol-relative → remote
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return false; // http:, https:, mailto:, blob:
  return true;
}

/** Strip the query/fragment a cache-buster or an SVG fragment adds, then percent-decode. */
function toFsPath(url) {
  const clean = url.split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean; // a malformed escape is reported by the existence check below
  }
}

/**
 * Record one reference. `fromFile` is the built file that contains it, needed because a
 * relative url() resolves against its own stylesheet's directory, not against dist/.
 */
const seen = new Map(); // fsPath inside dist -> Set of referrers
function reference(rawUrl, fromFile) {
  if (!isCheckable(rawUrl)) return;
  const p = toFsPath(rawUrl);
  if (!p) return;
  const abs = p.startsWith("/")
    ? join(DIST, p)                                    // root-absolute → dist root
    : resolve(dirname(fromFile), p);                   // relative → alongside its stylesheet
  if (!seen.has(abs)) seen.set(abs, new Set());
  seen.get(abs).add(`${rel(fromFile)}  →  ${rawUrl}`);
}

// CSS: url(...) in any form — url(x) url('x') url("x"), including inside image-set().
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/g;
// HTML: href="…" / src="…" and every candidate in a srcset="…".
const ATTR_RE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const SRCSET_RE = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const builtFiles = walk(DIST);
for (const relPath of builtFiles) {
  if (!/\.(css|html)$/i.test(relPath)) continue;
  const abs = join(DIST, relPath);
  const text = readFileSync(abs, "utf8");

  for (const m of text.matchAll(URL_RE)) reference(m[1] ?? m[2] ?? m[3] ?? "", abs);

  if (relPath.toLowerCase().endsWith(".html")) {
    for (const m of text.matchAll(ATTR_RE)) reference(m[1] ?? m[2] ?? "", abs);
    for (const m of text.matchAll(SRCSET_RE)) {
      const list = m[1] ?? m[2] ?? "";
      // "a.jpg 1x, b.jpg 2x" → the URL is the first token of each comma-separated candidate.
      for (const candidate of list.split(",")) reference(candidate.trim().split(/\s+/)[0] ?? "", abs);
    }
  }
}

for (const [abs, referrers] of [...seen.entries()].sort()) {
  const where = [...referrers].join("\n        ");
  // An asset that escapes dist/ can never be served from the web root.
  if (!abs.startsWith(DIST + sep)) {
    fail(`reference escapes dist/: ${rel(abs)}\n        ${where}`);
    continue;
  }
  if (!existsSync(abs)) {
    const missing = posix.join("/", relative(DIST, abs).split(sep).join("/"));
    const inPublic = existsSync(join(PUBLIC, relative(DIST, abs)));
    let hint;
    if (inPublic) {
      hint =
        `public${missing} EXISTS but was not copied into dist/.\n` +
        `        That is a build problem, not a missing file — check vite.config.ts publicDir/base.`;
    } else {
      hint =
        `NOT IN THE REPOSITORY. Nothing copies it, so nginx's SPA fallback serves index.html\n` +
        `        for ${missing} with HTTP 200 and Content-Type: text/html, and the browser paints nothing.\n` +
        `        Add the real file at  public${missing}  and commit it.`;
    }
    fail(`MISSING ASSET  ${missing}\n        referenced by:\n        ${where}\n        ${hint}`);
    continue;
  }
  const size = statSync(abs).size;
  if (size === 0) {
    fail(`EMPTY ASSET  ${rel(abs)} is 0 bytes — a placeholder or a truncated copy.`);
    continue;
  }
  verified.push(`${posix.join("/", relative(DIST, abs).split(sep).join("/"))}  (${kb(size)})`);
}

// ── 3. public/ must have been copied into dist/ in full ──────────────────────────────────────
//
// Vite copies public/ verbatim. Proving it happened, byte length included, turns a silently
// misconfigured publicDir or a half-finished copy into a build failure.

for (const relPath of walk(PUBLIC)) {
  const src = join(PUBLIC, relPath);
  const dst = join(DIST, relPath);
  if (!existsSync(dst)) {
    fail(`public/${relPath} was NOT copied into dist/ — check vite.config.ts publicDir.`);
    continue;
  }
  const a = statSync(src).size;
  const b = statSync(dst).size;
  if (a !== b) fail(`public/${relPath} is ${kb(a)} but dist/${relPath} is ${kb(b)} — the copy is incomplete.`);
}

// ── report ───────────────────────────────────────────────────────────────────────────────────

if (verified.length > 0) {
  console.log(`verify:assets — ${verified.length} referenced asset(s) present in dist/:`);
  for (const v of verified.sort()) console.log(`  ✓ ${v}`);
}

if (problems.length > 0) {
  console.error(`\nverify:assets FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  console.error(
    `A referenced asset that is not in dist/ does NOT 404 in production: the SPA fallback\n` +
      `answers with index.html and HTTP 200, so the page loads and the asset silently does not.\n` +
      `That is why this fails the build instead of waiting to be noticed on the live site.\n`,
  );
  process.exit(1);
}

console.log(`verify:assets OK — dist/ is complete.`);
