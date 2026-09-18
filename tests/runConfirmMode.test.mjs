/**
 * THE RUN DIALOG'S SAFETY CLAIM MUST COME FROM THE EXECUTION MODE, NOT FROM A SOCKET.
 *
 * `Box.tsx` holds two unrelated booleans that can both be read as "live":
 *
 *   headerMode.live   the engine is in a live EXECUTION MODE — real broker orders are possible
 *   live              the SSE stream is currently CONNECTED (BoxHeader's own prop doc: "Presentation
 *                     only — NOT evidence of tradability")
 *
 * `RunConfirm` was declared `live: boolean` and handed the SECOND one, so the headline of the
 * confirmation dialog for the button that starts automated entry tracked the stream socket:
 *
 *   stream connected + paper engine → "LIVE mode — qualifying boxes are entered with REAL orders"
 *   stream dropped   + LIVE engine  → "Paper simulation — no order reaches any broker"
 *
 * The first is a false alarm and was how the defect was noticed. The second is the dangerous one: a
 * genuinely live deployment whose stream had briefly dropped would promise an operator that nothing
 * reaches the broker, in the dialog they read immediately before arming automated entry. A safety
 * reassurance derived from a socket is not a safety property.
 *
 * Two layers of proof: the pure label function's new `known` flag, and source assertions that the
 * wiring cannot silently regress to the stream variable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { modeLabel } from "../src/lib/honestLabels.ts";

/** Source with comments stripped — this file's own prose quotes the strings being forbidden. */
function code(relPath) {
  return readFileSync(new URL(relPath, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/* ═════════════════ 1. `known` distinguishes paper from unreported ═════════════════ */

test("a CONFIRMED paper mode is known and not live", () => {
  for (const mode of ["paper_touch", "paper_latency", "paper_legging"]) {
    const m = modeLabel(mode);
    assert.equal(m.live, false, `${mode} must not be called live`);
    assert.equal(m.known, true, `${mode} was reported by the backend, so it is known`);
  }
});

test("live is known AND live", () => {
  const m = modeLabel("live");
  assert.equal(m.live, true);
  assert.equal(m.known, true);
});

test("an UNREPORTED mode is NOT known — the flag that stops it rendering as paper", () => {
  for (const missing of [undefined, null, "", "   "]) {
    const m = modeLabel(missing);
    // `live: false` alone is ambiguous: it is ALSO what an unreported mode yields. That ambiguity is
    // exactly what let a positive safety claim be made about a mode nobody had confirmed.
    assert.equal(m.live, false);
    assert.equal(m.known, false, "an unreported mode must never be indistinguishable from paper");
  }
});

test("only a known, non-live mode may earn a no-orders promise", () => {
  const promises = (m) => m.known && !m.live;
  assert.equal(promises(modeLabel("paper_legging")), true);
  assert.equal(promises(modeLabel("live")), false);
  assert.equal(promises(modeLabel(undefined)), false, "unknown must not promise anything");
});

/* ═════════════════ 2. the wiring cannot regress to the stream variable ═════════════════ */

test("Box.tsx passes the EXECUTION MODE into RunConfirm, never the SSE connection", () => {
  const box = code("../src/Box.tsx");
  const call = box.slice(box.indexOf("<RunConfirm"));
  const props = call.slice(0, call.indexOf("/>"));

  assert.match(props, /mode=\{headerMode\}/, "the dialog must be given the backend-derived mode label");
  assert.doesNotMatch(
    props,
    /live=\{live\}/,
    "regression: `live` in Box.tsx is the SSE connection, so this inverted the dialog's safety claim",
  );
  // `live` is still legitimately passed to the HEADER, where it means "stream connected" and is
  // documented as not being evidence of tradability. So its presence in the file is fine; what must
  // never recur is routing it into a safety claim.
  assert.match(box, /<BoxHeader[\s\S]*?live=\{live\}/, "the header still receives the stream state");
});

test("RunConfirm takes a ModeLabel and no longer accepts a bare boolean", () => {
  const rc = code("../src/components/box/RunConfirm.tsx");
  assert.match(rc, /mode:\s*ModeLabel/, "the prop must be the whole label, so `known` is available");
  assert.doesNotMatch(rc, /^\s*live:\s*boolean/m, "regression: the ambiguous boolean prop is back");
});

test("the no-orders promise in RunConfirm is gated on the mode being KNOWN", () => {
  const rc = code("../src/components/box/RunConfirm.tsx");
  const promise = "no order reaches any broker";
  assert.ok(rc.includes(promise), "the paper reassurance should still exist for a confirmed paper mode");

  // The promise must sit on the `mode.known` branch. Asserting the branch structure rather than the
  // rendered string keeps this honest without a DOM: the claim is reachable only when known is true.
  const claimRegion = rc.slice(rc.indexOf("mode.live"), rc.indexOf(promise) + promise.length);
  assert.match(
    claimRegion,
    /mode\.known/,
    "the paper promise must be reachable only when the backend actually reported the mode",
  );
  assert.match(rc, /UNKNOWN/, "an unreported mode must render as unknown, not as paper");
});
