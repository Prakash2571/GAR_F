/**
 * THE CONFIGURATION COMPONENTS' WIRING, pinned by source assertions.
 *
 * `--experimental-strip-types` does not transform JSX, so these `.tsx` files cannot be rendered here.
 * The decisions they make are all in `src/lib/operatorConfig.ts` and are unit-tested directly in
 * `tests/operatorConfig.test.mjs`. What remains, and what this file covers, is that the components
 * actually USE those decisions — and, more importantly, that they do not quietly acquire the
 * capabilities they are specified not to have.
 *
 * Each assertion below corresponds to a way this surface could become unsafe without any logic being
 * wrong: a slider on a monetary cap, an editable deployment gate, a locally-derived paper/live label, a
 * hand-rolled busy flag instead of the shared single-flight guard, or a confirmation dialog that writes
 * its own prose instead of the tested sentences.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL("../src", import.meta.url)));
const CFG_DIR = join(SRC, "components", "box", "configuration");

/** Source with comments stripped — this file's own prose, and the components', quote what they forbid. */
function code(path) {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const PANEL = code(join(CFG_DIR, "ConfigurationPanel.tsx"));
const ROW = code(join(CFG_DIR, "SettingRow.tsx"));
const MODAL = code(join(CFG_DIR, "DangerousChangeModal.tsx"));
const FACTS = code(join(CFG_DIR, "DeploymentFacts.tsx"));
const CONTROLBOX = code(join(SRC, "components", "box", "ControlBox.tsx"));

/* ═════════════════ 1. Single-flight uses the SHARED guard ═════════════════ */

test("the panel single-flights writes through the shared ControlRequests helper", () => {
  assert.match(PANEL, /from "\.\.\/\.\.\/\.\.\/lib\/statusIntegrity\.ts"/);
  assert.match(PANEL, /ControlRequests/);
  assert.match(PANEL, /runOnce\(\s*requests\.current,\s*"configuration"/);
});

test("the guard instance is held in a ref, so a re-render cannot reset it mid-flight", () => {
  assert.match(PANEL, /useRef\(new ControlRequests\(\)\)/);
});

test("the panel does not hand-roll a submitting guard in place of runOnce", () => {
  // A local boolean would not survive a re-render and would not be shared across controls, which is
  // exactly how a double-submit gets back in.
  assert.equal(/const \[submitting/.test(PANEL), false);
  assert.equal(/inFlight\s*=\s*(true|false)/.test(PANEL), false);
});

/* ═════════════════ 2. Staleness blocks writes ═════════════════ */

test("the panel consults canSubmit before sending, and marks a failed refresh stale", () => {
  assert.match(PANEL, /canSubmit\(state\)/);
  assert.match(PANEL, /onConfigFailed/);
  assert.match(PANEL, /onConfigLoaded/);
});

test("a stale view disables every control rather than looking current", () => {
  assert.match(PANEL, /const readOnly = stale \|\| busy/);
  assert.match(PANEL, /disabled=\{readOnly\}/);
});

test("the version echoed on a PATCH comes from editingVersion, not from a local counter", () => {
  assert.match(PANEL, /editingVersion\(state\)/);
  assert.match(PANEL, /patchOperatorConfig\(\{\s*version/);
});

test("a stale-version refusal triggers a re-read instead of a blind retry", () => {
  assert.match(PANEL, /reason === "stale_version"/);
  assert.match(PANEL, /void refresh\(\)/);
});

/* ═════════════════ 3. Confirmation comes from the tested helper ═════════════════ */

test("the panel decides on confirmation with needsConfirmation and describeChange", () => {
  assert.match(PANEL, /needsConfirmation\(setting, current, next\)/);
  assert.match(PANEL, /describeChange\(setting, current, next\)/);
});

test("the modal renders the summary's fields and writes no prose of its own", () => {
  for (const field of ["oldLabel", "newLabel", "effect", "when"]) {
    assert.match(MODAL, new RegExp(`summary\\.${field}`), `the modal ignores summary.${field}`);
  }
  // The forbidden generic prompt, in any casing.
  assert.equal(/are you sure/i.test(MODAL), false, "the modal contains a generic confirmation prompt");
});

test("a risk-increasing confirmation is visually distinct and differently worded", () => {
  assert.match(MODAL, /summary\.riskIncreasing/);
  assert.match(MODAL, /"danger"/);
  assert.match(MODAL, /Apply anyway/);
});

test("the modal cannot be dismissed by accident while a write is in flight", () => {
  assert.match(MODAL, /dismissible=\{!busy\}/);
});

/* ═════════════════ 4. No slider on a risk or monetary value ═════════════════ */

test("no configuration component renders a range input", () => {
  for (const [name, src] of [["SettingRow", ROW], ["ConfigurationPanel", PANEL], ["DeploymentFacts", FACTS]]) {
    assert.equal(/type="range"/.test(src), false, `${name} renders a slider`);
    assert.equal(/<input[^>]*range/.test(src), false, `${name} renders a slider`);
  }
});

test("the row chooses its control through controlKind, which has no slider case", () => {
  assert.match(ROW, /controlKind\(setting\)/);
  const lib = code(join(SRC, "lib", "operatorConfig.ts"));
  assert.equal(/"slider"/.test(lib), false, "controlKind gained a slider kind");
});

test("a numeric field is committed deliberately, not on every keystroke", () => {
  // Submitting per keystroke would fire a risk-limit write for every intermediate value typed —
  // "15" on the way to "150000" is a real, much tighter limit that would be applied and audited.
  //
  // Scoped to the NUMERIC input specifically. A <select> committing on change is correct and
  // deliberate: choosing an enum value is a single discrete act, not a sequence of partial states, so
  // there is no intermediate value to submit by mistake.
  assert.match(ROW, /commitNumeric/);

  const numberInput = /<input[\s\S]*?type="number"[\s\S]*?\/>/.exec(ROW);
  assert.notEqual(numberInput, null, "the numeric input is no longer where this test expects it");
  assert.match(numberInput[0], /onChange=\{\(e\) => setDraft\(e\.target\.value\)\}/);
  assert.equal(
    /onRequestChange/.test(numberInput[0]),
    false,
    "the numeric input submits on every keystroke",
  );

  // It is committed on an explicit act: Enter, or the Apply button.
  assert.match(ROW, /e\.key === "Enter"/);
  assert.match(ROW, /onClick=\{commitNumeric\}/);
});

/* ═════════════════ 5. The three values are all rendered ═════════════════ */

test("the row renders effective, default and source, and the clamp when there is one", () => {
  assert.match(ROW, /effective_value/);
  assert.match(ROW, /default_value/);
  assert.match(ROW, /sourceLabel\(setting\.source\)/);
  assert.match(ROW, /clamped_by_deployment/);
  assert.match(ROW, /configured_value/);
  assert.match(ROW, /deployment_bound/);
});

test("the armed session's frozen value is rendered only when one exists", () => {
  assert.match(ROW, /session_snapshot_value !== null/);
  assert.match(ROW, /Armed session is using/);
});

test("the row starts editing from the effective value", () => {
  assert.match(ROW, /startingValue\(setting\)/);
});

test("the row renders the backend's blockers rather than inventing a reason", () => {
  assert.match(ROW, /setting\.blockers/);
  assert.match(ROW, /\{b\.message\}/);
});

test("the env var is tucked into a details block, not used as the label", () => {
  assert.match(ROW, /<details/);
  assert.match(ROW, /setting\.env_var/);
  assert.match(ROW, /\{setting\.label\}/);
  // The label must be the human one.
  assert.equal(/htmlFor=\{`cfg-\$\{setting\.env_var\}`\}/.test(ROW), false);
});

/* ═════════════════ 6. Deployment facts are structurally read-only ═════════════════ */

test("the deployment tab has no input, no onChange and no mutation call", () => {
  // Read-only-ness is a property of the code here, not a `disabled` attribute somebody could remove.
  assert.equal(/<input/.test(FACTS), false, "DeploymentFacts renders an input");
  assert.equal(/<select/.test(FACTS), false, "DeploymentFacts renders a select");
  assert.equal(/onChange/.test(FACTS), false, "DeploymentFacts has an onChange");
  assert.equal(/onClick/.test(FACTS), false, "DeploymentFacts has an onClick");
  assert.equal(/patchOperatorConfig/.test(FACTS), false, "DeploymentFacts can mutate");
  assert.equal(/onRequestChange/.test(FACTS), false);
});

test("the deployment tab displays every live gate so the ceiling is visible", () => {
  for (const gate of [
    "execution_mode",
    "live_trading_enabled",
    "zerodha_live_trading_enabled",
    "dhan_live_trading_enabled",
    "live_capable",
  ]) {
    assert.match(FACTS, new RegExp(`d\\.${gate}`), `the deployment tab hides ${gate}`);
  }
});

/* ═════════════════ 7. Paper/live stays backend-authoritative ═════════════════ */

test("liveness is read from the payload, never derived from a stream or socket", () => {
  for (const [name, src] of [["ConfigurationPanel", PANEL], ["DeploymentFacts", FACTS]]) {
    assert.match(src, /live_capable/, `${name} does not read the backend's verdict`);
    // The specific historical defect: a safety claim computed from a stream's connection state.
    assert.equal(/connected\s*\?\s*"LIVE"/.test(src), false, `${name} derives liveness from a socket`);
    assert.equal(/sse|eventSource/i.test(src), false, `${name} consults a stream for liveness`);
  }
});

/* ═════════════════ 8. Secrets are never referenced ═════════════════ */

test("no configuration component references a credential", () => {
  const FORBIDDEN = [
    "SITE_ACCESS_SECRET",
    "BROKER_TOKEN_ENCRYPTION_KEY",
    "KITE_API_SECRET",
    "DHAN_API_SECRET",
    "TOKEN_EXPOSURE_KEY",
    "DATABASE_URL",
    "MONGODB_URI",
  ];
  for (const [name, src] of [
    ["ConfigurationPanel", PANEL],
    ["SettingRow", ROW],
    ["DangerousChangeModal", MODAL],
    ["DeploymentFacts", FACTS],
  ]) {
    for (const secret of FORBIDDEN) {
      assert.equal(src.includes(secret), false, `${name} references ${secret}`);
    }
  }
});

/* ═════════════════ 9. ControlBox stays a pure container ═════════════════ */

test("ControlBox renders the configuration panel as its own tab", () => {
  assert.match(CONTROLBOX, /ConfigurationPanel/);
  assert.match(CONTROLBOX, /tab === "configuration"/);
  assert.match(CONTROLBOX, /id: "configuration"/);
});

test("ControlBox passes the panel no configuration data and no mutation state", () => {
  // The container's own header comment states the rule: hoisting a panel's busy/error state here would
  // mean reimplementing it, which is how a double-submit gets introduced.
  assert.match(CONTROLBOX, /<ConfigurationPanel canTrade=\{canTrade\} \/>/);
  assert.equal(/patchOperatorConfig/.test(CONTROLBOX), false, "ControlBox mutates configuration itself");
  assert.equal(/fetchOperatorConfig/.test(CONTROLBOX), false, "ControlBox fetches configuration itself");
});

test("the four original control tabs are unchanged and still first", () => {
  // The configuration tab is additive; an operator's muscle memory for the existing tabs must survive.
  const order = [...CONTROLBOX.matchAll(/\{ id: "(\w+)", label:/g)].map((m) => m[1]);
  assert.deepEqual(order, ["execution", "session", "universe", "risk", "configuration"]);
});

test("the existing panels are still rendered", () => {
  for (const panel of [
    "BoxExecutionControl",
    "BoxSessionControl",
    "BoxRiskControl",
    "BoxGates",
    "BoxExclusions",
    "UniversePicker",
  ]) {
    assert.match(CONTROLBOX, new RegExp(panel), `ControlBox no longer renders ${panel}`);
  }
});

/* ═════════════════ 10. The panel does not become a second Box.tsx ═════════════════ */

test("each configuration component stays small enough to review", () => {
  const LIMIT = 24_000;
  for (const [name, path] of [
    ["ConfigurationPanel.tsx", join(CFG_DIR, "ConfigurationPanel.tsx")],
    ["SettingRow.tsx", join(CFG_DIR, "SettingRow.tsx")],
    ["DangerousChangeModal.tsx", join(CFG_DIR, "DangerousChangeModal.tsx")],
    ["DeploymentFacts.tsx", join(CFG_DIR, "DeploymentFacts.tsx")],
  ]) {
    const size = readFileSync(path, "utf8").length;
    assert.ok(size < LIMIT, `${name} is ${size} bytes — split it rather than growing it`);
  }
});

test("Box.tsx did not absorb the configuration form", () => {
  const box = readFileSync(join(SRC, "Box.tsx"), "utf8");
  assert.equal(/patchOperatorConfig/.test(box), false, "Box.tsx mutates configuration directly");
  assert.equal(/OperatorConfigSetting/.test(box), false, "Box.tsx reimplements a setting row");
});
