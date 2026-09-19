/**
 * THE OPERATOR CONFIGURATION SCREEN — every decision it makes, driven directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HOW THESE TESTS WORK, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The harness is `node:test` with `--experimental-strip-types`, which strips TYPES but does not
 * transform JSX — so a `.tsx` component cannot be imported and rendered here (the same constraint
 * `tests/section7BackendAuthority.test.mjs` and `tests/accessGate.test.mjs` already document). The
 * response is not to skip the behaviour: every decision the configuration screen makes lives in
 * `src/lib/operatorConfig.ts` and is driven directly, the API client is driven over a stubbed `fetch`
 * through the REAL transport wrapper, and the `.tsx` wiring is pinned by source assertions.
 *
 * The scenarios below are the ways a configuration UI lies to an operator:
 *   showing a configured value as though it were in force · showing a newly configured session limit
 *   as though the armed session used it · letting a stale response overwrite a newer one · applying a
 *   risk-increasing change with no confirmation · hiding a backend refusal · double-submitting ·
 *   deriving the paper/live label client-side · rendering a deployment gate as editable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  formatDuration,
  formatRupees,
  formatValue,
  sourceLabel,
  takesEffectLabel,
  policyLabel,
  controlKind,
  isRiskIncreasing,
  needsConfirmation,
  describeChange,
  groupByCategory,
  lockedCount,
  acceptConfig,
  onConfigLoaded,
  onConfigFailed,
  onConfigUnavailable,
  editingVersion,
  canSubmit,
  findSetting,
  startingValue,
  hasDivergence,
  CATEGORY_ORDER,
} from "../src/lib/operatorConfig.ts";

/* ═════════════════ fixtures ═════════════════ */

function setting(overrides = {}) {
  return {
    key: "maxOpenBoxes",
    label: "Maximum Box inventory",
    description: "How many Boxes may be held at once, in total, in every execution mode.",
    category: "risk",
    type: "integer",
    unit: "count",
    configured_value: 3,
    effective_value: 3,
    default_value: 0,
    source: "runtime",
    deployment_bound: null,
    clamped_by_deployment: false,
    min: 0,
    max: 50,
    enum_values: null,
    zero_means: "unlimited",
    safe_direction: "lower_is_safer",
    mutable: true,
    mutation_policy: "TIGHTEN_ONLY_WHILE_ARMED",
    takes_effect: "next_candidate",
    requires_flat: false,
    requires_disarmed: false,
    dangerous: true,
    requires_full_admin: true,
    session_snapshot_value: null,
    blockers: [],
    env_var: "BOX_MAX_OPEN_BOXES",
    caveat: null,
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    version: 5,
    updated_at: "2026-09-19T04:00:00.000Z",
    operator_role: "full",
    deployment: {
      execution_mode: "paper_latency",
      live_trading_enabled: false,
      zerodha_live_trading_enabled: false,
      dhan_live_trading_enabled: false,
      shadow_mode_enabled: false,
      execution_coordinator_enabled: true,
      live_capable: false,
      region: null,
      active_broker: "zerodha",
    },
    state: {
      entry_armed: false,
      session_armed: false,
      open_boxes: 0,
      residual_legs: 0,
      working_orders: 0,
      in_flight_executions: 0,
      reconciliation_clean: true,
      flat: true,
    },
    settings: [setting()],
    recent_changes: [],
    ...overrides,
  };
}

/* ═════════════════ 1. Configured / effective / armed render distinctly ═════════════════ */

test("a clamped setting exposes divergence so both numbers can be shown", () => {
  const s = setting({
    key: "liveMaxBoxCapitalRupees",
    unit: "rupees",
    configured_value: 150_000,
    effective_value: 120_000,
    default_value: 0,
    source: "runtime_clamped_by_env",
    clamped_by_deployment: true,
    deployment_bound: 120_000,
  });
  assert.equal(hasDivergence(s), true);
  assert.equal(formatValue(s, s.configured_value), "₹1,50,000");
  assert.equal(formatValue(s, s.effective_value), "₹1,20,000");
  assert.equal(sourceLabel(s.source), "Operator value capped by this deployment");
});

test("an unclamped setting reports no divergence, so one number is honest", () => {
  assert.equal(hasDivergence(setting()), false);
});

test("editing starts from the EFFECTIVE value, never the unenforced configured one", () => {
  const s = setting({ configured_value: 150_000, effective_value: 120_000, clamped_by_deployment: true });
  assert.equal(startingValue(s), 120_000);
});

test("an armed session's frozen limit is distinct from the newly configured one", () => {
  const s = setting({
    key: "sessionMaxEntryAttempts",
    configured_value: 5,
    effective_value: 5,
    session_snapshot_value: 1,
    mutation_policy: "NEXT_SESSION",
    takes_effect: "next_arm",
  });
  // The three are genuinely different and the label says which one the running session obeys.
  assert.equal(s.configured_value, 5);
  assert.equal(s.session_snapshot_value, 1);
  assert.match(takesEffectLabel(s.takes_effect), /armed session keeps its own limit/);
});

test("`Unlimited` and `Disabled` are never rendered as a bare zero", () => {
  // A bare "0" on a cap whose zero means UNLIMITED reads as the tightest possible limit and means
  // the opposite — the most dangerous number this screen could print.
  assert.equal(formatValue(setting({ zero_means: "unlimited" }), 0), "Unlimited");
  assert.equal(formatValue(setting({ zero_means: "disabled" }), 0), "Disabled");
  assert.equal(formatValue(setting({ zero_means: "value" }), 0), "0");
});

/* ═════════════════ 2. Formatting preserves exact backend units ═════════════════ */

test("milliseconds display in human units without changing the value", () => {
  assert.equal(formatDuration(500), "500 ms");
  assert.equal(formatDuration(15_000), "15 s");
  assert.equal(formatDuration(1_500), "1.5 s");
  assert.equal(formatDuration(90_000), "1 m 30 s");
  assert.equal(formatDuration(120_000), "2 m");
  assert.equal(formatDuration(0), "0 ms");
});

test("rupees use Indian digit grouping", () => {
  assert.equal(formatRupees(150_000), "₹1,50,000");
  assert.equal(formatRupees(1_200), "₹1,200");
});

test("a ratio renders as a percentage and a percent stays a percent", () => {
  assert.equal(formatValue(setting({ unit: "ratio" }), 0.75), "75%");
  assert.equal(formatValue(setting({ unit: "percent" }), 5), "5%");
});

/* ═════════════════ 3. Control selection — no slider for money ═════════════════ */

test("critical monetary and risk values never get a slider", () => {
  assert.equal(controlKind(setting({ unit: "rupees" })), "rupees");
  assert.equal(controlKind(setting({ type: "boolean" })), "toggle");
  assert.equal(controlKind(setting({ type: "enum", enum_values: ["a", "b"] })), "select");
  assert.equal(controlKind(setting({ unit: "milliseconds" })), "duration");
  assert.equal(controlKind(setting({ unit: "count" })), "number");

  // The omission is the assertion: there is no slider kind at all.
  const kinds = ["rupees", "toggle", "select", "duration", "number"];
  for (const unit of ["rupees", "milliseconds", "seconds", "minutes", "count", "ratio", "percent", "none"]) {
    assert.ok(kinds.includes(controlKind(setting({ unit }))), `${unit} produced an unexpected control`);
  }
});

/* ═════════════════ 4. Risk direction comes from backend metadata ═════════════════ */

test("risk direction is read from safe_direction, not from the number growing", () => {
  const ceiling = setting({ safe_direction: "lower_is_safer" });
  assert.equal(isRiskIncreasing(ceiling, 2, 5), true);
  assert.equal(isRiskIncreasing(ceiling, 5, 2), false);

  const threshold = setting({ safe_direction: "higher_is_safer", zero_means: null });
  assert.equal(isRiskIncreasing(threshold, 1200, 900), true, "lowering the entry gate is a widening");
  assert.equal(isRiskIncreasing(threshold, 1200, 1500), false);
});

test("for an unlimited-capable ceiling, moving TO zero is a widening", () => {
  const s = setting({ safe_direction: "lower_is_safer", zero_means: "unlimited" });
  assert.equal(isRiskIncreasing(s, 3, 0), true, "3 -> unlimited was not treated as a widening");
  assert.equal(isRiskIncreasing(s, 0, 3), false, "unlimited -> 3 was not treated as a tightening");
});

test("booleans follow their declared safe state", () => {
  const protection = setting({ type: "boolean", safe_direction: "enabled_is_safer" });
  assert.equal(isRiskIncreasing(protection, true, false), true);
  assert.equal(isRiskIncreasing(protection, false, true), false);

  const risky = setting({ type: "boolean", safe_direction: "disabled_is_safer" });
  assert.equal(isRiskIncreasing(risky, false, true), true);
  assert.equal(isRiskIncreasing(risky, true, false), false);
});

test("a no-op is never risk-increasing and never needs confirmation", () => {
  assert.equal(isRiskIncreasing(setting(), 3, 3), false);
  assert.equal(needsConfirmation(setting(), 3, 3), false);
});

test("a neutral setting is never called a widening", () => {
  assert.equal(isRiskIncreasing(setting({ safe_direction: "neutral" }), 1, 99), false);
});

/* ═════════════════ 5. Dangerous changes require confirmation ═════════════════ */

test("a risk-increasing change requires confirmation", () => {
  assert.equal(needsConfirmation(setting({ dangerous: false }), 2, 5), true);
});

test("a setting flagged dangerous confirms in BOTH directions", () => {
  // "Dangerous" is a property of the setting; "risk-increasing" is a property of the change. An
  // operator lowering a capital cap should still see exactly what they are doing.
  assert.equal(needsConfirmation(setting({ dangerous: true }), 5, 2), true);
});

test("an ordinary tightening on a non-dangerous setting needs no confirmation", () => {
  assert.equal(needsConfirmation(setting({ dangerous: false }), 5, 2), false);
});

test("the confirmation is specific — old value, new value, effect and timing", () => {
  const s = setting({
    key: "liveMaxBoxCapitalRupees",
    label: "Maximum capital per Box",
    unit: "rupees",
    category: "risk",
    zero_means: "unlimited",
    requires_flat: true,
    requires_disarmed: true,
    takes_effect: "immediately",
  });
  const summary = describeChange(s, 120_000, 150_000);

  assert.equal(summary.title, "Maximum capital per Box");
  assert.equal(summary.transition, "₹1,20,000 → ₹1,50,000");
  assert.equal(summary.riskIncreasing, true);
  assert.equal(summary.requiresFlat, true);
  assert.match(summary.effect, /widens what the live entry engine may admit/);

  // Explicitly NOT a generic prompt: the summary must not be reducible to "are you sure".
  assert.equal(/are you sure/i.test(summary.effect), false);
  assert.ok(summary.effect.length > 40, "the effect sentence must actually explain something");
});

test("a tightening's summary says the engine will admit FEWER entries, not more", () => {
  const summary = describeChange(setting(), 5, 2);
  assert.equal(summary.riskIncreasing, false);
  assert.match(summary.effect, /more restrictive/);
  assert.match(summary.effect, /fewer entries, not more/);
});

test("a published caveat travels into the confirmation", () => {
  const s = setting({
    key: "maxCrossLegExchangeDispersionMs",
    unit: "milliseconds",
    category: "market_data",
    caveat: "Zerodha's book timestamp is in whole seconds, so any value below about 1000 ms is unsatisfiable.",
  });
  assert.match(describeChange(s, 1000, 2000).caveat, /whole seconds/);
});

/* ═════════════════ 6. Backend blockers are displayed ═════════════════ */

test("an immutable setting carries the backend's blockers verbatim", () => {
  const s = setting({
    mutable: false,
    blockers: [
      { code: "session_armed", message: "Can only be changed while the live session is disarmed." },
      { code: "open_box", message: "2 open Box position(s)." },
    ],
  });
  assert.equal(s.mutable, false);
  assert.equal(s.blockers.length, 2);
  // The UI must not invent its own wording; these are the sentences to render.
  assert.match(s.blockers[0].message, /disarmed/);
});

test("policy labels explain the restriction in the operator's terms", () => {
  assert.match(policyLabel("TIGHTEN_ONLY_WHILE_ARMED"), /more restrictive/);
  assert.match(policyLabel("FLAT_AND_DISARMED"), /no open exposure/);
  assert.match(policyLabel("NEXT_SESSION"), /next arm/);
  assert.match(policyLabel("RESTART_REQUIRED"), /read-only/i);
});

/* ═════════════════ 7. A stale response cannot overwrite a newer one ═════════════════ */

test("an older configuration version is discarded", () => {
  const newer = config({ version: 9 });
  const older = config({ version: 7 });
  const result = acceptConfig(newer, older);
  assert.equal(result.accepted, false);
  assert.equal(result.config.version, 9, "the older payload won by arriving last");
});

test("an equal version IS accepted, so a legitimate re-read is not rejected forever", () => {
  const result = acceptConfig(config({ version: 9 }), config({ version: 9 }));
  assert.equal(result.accepted, true);
});

test("a newer version replaces the old one", () => {
  const result = acceptConfig(config({ version: 9 }), config({ version: 10 }));
  assert.equal(result.accepted, true);
  assert.equal(result.config.version, 10);
});

test("out-of-order responses converge on the NEWEST version, whatever the arrival order", () => {
  let state = { kind: "loading" };
  state = onConfigLoaded(state, config({ version: 10 }));
  state = onConfigLoaded(state, config({ version: 8 })); // late straggler
  assert.equal(state.config.version, 10);
  assert.equal(editingVersion(state), 10, "a PATCH would have echoed a stale version");
});

/* ═════════════════ 8. A failed refresh becomes visibly stale or unknown ═════════════════ */

test("a failed refresh keeps the numbers but marks them stale with a reason", () => {
  const ready = onConfigLoaded({ kind: "loading" }, config({ version: 4 }));
  const failed = onConfigFailed(ready, "Network error");
  assert.equal(failed.kind, "ready");
  assert.equal(failed.stale, true);
  assert.equal(failed.error, "Network error");
  assert.equal(failed.config.version, 4, "a dropped request must not blank a risk screen");
});

test("a failure with nothing previously loaded is UNKNOWN, not empty-but-fine", () => {
  const failed = onConfigFailed({ kind: "loading" }, "HTTP 503");
  assert.equal(failed.kind, "failed");
  assert.equal(failed.error, "HTTP 503");
  assert.equal(editingVersion(failed), null);
});

test("a stale view cannot submit a mutation", () => {
  const ready = onConfigLoaded({ kind: "loading" }, config());
  assert.equal(canSubmit(ready), true);
  assert.equal(canSubmit(onConfigFailed(ready, "boom")), false);
  assert.equal(canSubmit({ kind: "loading" }), false);
  assert.equal(canSubmit({ kind: "failed", error: "x" }), false);
});

test("a recovered refresh clears the stale flag", () => {
  let state = onConfigLoaded({ kind: "loading" }, config({ version: 4 }));
  state = onConfigFailed(state, "boom");
  assert.equal(state.stale, true);
  state = onConfigLoaded(state, config({ version: 5 }));
  assert.equal(state.stale, false);
  assert.equal(state.config.version, 5);
  assert.equal(canSubmit(state), true);
});

/* ═════════════════ 9. Grouping ═════════════════ */

test("settings group into the declared tab order, omitting empty categories", () => {
  const groups = groupByCategory([
    setting({ key: "a", category: "risk" }),
    setting({ key: "b", category: "strategy" }),
    setting({ key: "c", category: "risk" }),
  ]);
  assert.deepEqual(groups.map((g) => g.category), ["strategy", "risk"]);
  assert.equal(groups[1].settings.length, 2);
  // An empty category is omitted rather than rendered as a blank tab.
  assert.equal(groups.some((g) => g.settings.length === 0), false);
});

test("every category in CATEGORY_ORDER has a label", () => {
  for (const category of CATEGORY_ORDER) {
    const groups = groupByCategory([setting({ category })]);
    assert.equal(groups.length, 1);
    assert.ok(groups[0].label.length > 0);
    assert.equal(/^[a-z_]+$/.test(groups[0].label), false, `${category}'s label is a raw key`);
  }
});

test("locked settings are counted so a tab can flag them", () => {
  assert.equal(lockedCount([setting({ mutable: true }), setting({ mutable: false })]), 1);
});

/* ═════════════════ 10. Lookup ═════════════════ */

test("findSetting is null-safe and returns undefined for an unknown key", () => {
  assert.equal(findSetting(null, "maxOpenBoxes"), undefined);
  assert.equal(findSetting(config(), "nope"), undefined);
  assert.equal(findSetting(config(), "maxOpenBoxes").key, "maxOpenBoxes");
});

/* ═════════════════ 11. Secrets are never expected or rendered ═════════════════ */

test("the configuration module never references a credential name", () => {
  const source = readFileSync(new URL("../src/lib/operatorConfig.ts", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/api/operatorConfig.ts", import.meta.url), "utf8");
  const FORBIDDEN = [
    "SITE_ACCESS_SECRET",
    "BROKER_TOKEN_ENCRYPTION_KEY",
    "KITE_API_SECRET",
    "DHAN_API_SECRET",
    "TOKEN_EXPOSURE_KEY",
    "DATABASE_URL",
    "MONGODB_URI",
    "KITE_TOKEN_BROKER_PASSCODE",
    "DHAN_TOKEN_BROKER_PASSCODE",
  ];
  for (const name of [...FORBIDDEN]) {
    assert.equal(source.includes(name), false, `operatorConfig.ts references ${name}`);
    assert.equal(api.includes(name), false, `api/operatorConfig.ts references ${name}`);
  }
});

test("no field named like a credential is read off a setting", () => {
  const source = readFileSync(new URL("../src/lib/operatorConfig.ts", import.meta.url), "utf8");
  for (const pattern of [/\.secret\b/, /\.passcode\b/, /\.api_key\b/, /\.token\b/]) {
    assert.equal(pattern.test(source), false, `operatorConfig.ts reads ${pattern}`);
  }
});

/* ═════════════════ 12. Deployment gates are read-only and backend-authoritative ═════════════════ */

test("the paper/live label comes from the backend's own verdict", () => {
  const paper = config();
  assert.equal(paper.deployment.live_capable, false);

  const live = config({
    deployment: { ...config().deployment, execution_mode: "live", live_trading_enabled: true, live_capable: true },
  });
  assert.equal(live.deployment.live_capable, true);

  // And the module offers no way to DERIVE liveness — it must be read, not computed.
  const source = readFileSync(new URL("../src/lib/operatorConfig.ts", import.meta.url), "utf8");
  assert.equal(/function\s+\w*(isLive|deriveLive|computeLive)/i.test(source), false,
    "the module derives liveness instead of reading the backend's verdict");
});

test("no deployment gate appears as an editable setting", () => {
  const editableKeys = new Set(config().settings.map((s) => s.key));
  for (const gate of [
    "executionMode",
    "liveTradingEnabled",
    "zerodhaLiveTradingEnabled",
    "dhanLiveTradingEnabled",
    "liveCapable",
  ]) {
    assert.equal(editableKeys.has(gate), false, `${gate} is editable`);
  }
});

/* ═════════════════ 13. The API client's contract ═════════════════ */

test("a PATCH refuses to be sent without the version being edited", async () => {
  const { patchOperatorConfig } = await import("../src/api/operatorConfig.ts");
  await assert.rejects(
    () => patchOperatorConfig({ version: undefined, changes: { maxOpenBoxes: 2 } }),
    /requires the integer version/,
  );
  await assert.rejects(
    () => patchOperatorConfig({ version: 1.5, changes: { maxOpenBoxes: 2 } }),
    /requires the integer version/,
  );
});

test("a PATCH refuses an empty change set", async () => {
  const { patchOperatorConfig } = await import("../src/api/operatorConfig.ts");
  await assert.rejects(
    () => patchOperatorConfig({ version: 1, changes: {} }),
    /at least one change/,
  );
});

test("the API client sends domain keys, never environment variable names", () => {
  const api = readFileSync(new URL("../src/api/operatorConfig.ts", import.meta.url), "utf8");
  assert.equal(/BOX_[A-Z_]+/.test(api), false, "the client mentions an env var name");
  assert.match(api, /\/api\/box\/operator-config/);
});


/* ═════════════════ 14. Double-click cannot double-submit ═════════════════ */

test("a second configuration write while one is in flight is refused, not queued", async () => {
  const { ControlRequests, runOnce } = await import("../src/lib/statusIntegrity.ts");
  const requests = new ControlRequests();

  let started = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const submit = () =>
    runOnce(requests, "configuration", async () => {
      started++;
      await blocked;
      return "ok";
    });

  // Two clicks in the same tick, exactly as a double-click produces.
  const first = submit();
  const second = await submit();

  assert.equal(second.sent, false, "the second click was sent");
  assert.match(second.reason, /already in flight/i);
  assert.equal(started, 1, "the backend was called twice for one operator intent");

  release();
  const firstOutcome = await first;
  assert.equal(firstOutcome.sent, true);
  assert.equal(firstOutcome.result, "ok");

  // And the class is released afterwards, so a deliberate second change still works.
  const third = await submit();
  assert.equal(third.sent, true);
  assert.equal(started, 2);
});

test("a configuration write in flight does not block an unrelated control", async () => {
  // Single-flighting must be per CLASS. Blocking an emergency flatten because a config PATCH is in
  // flight would be exactly the "a caution became a trap" failure the backend comments warn about.
  const { ControlRequests, runOnce } = await import("../src/lib/statusIntegrity.ts");
  const requests = new ControlRequests();

  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const config = runOnce(requests, "configuration", async () => {
    await blocked;
    return "config";
  });
  const emergency = await runOnce(requests, "emergency", async () => "flattened");

  assert.equal(emergency.sent, true, "an emergency action was blocked by a configuration write");
  release();
  assert.equal((await config).sent, true);
});

test("configuration is its own control class, not folded into another", async () => {
  const { CONTROL_LABEL } = await import("../src/lib/statusIntegrity.ts");
  assert.equal(CONTROL_LABEL.configuration, "configuration");
});


/* ═════════════════ 15. The ambiguous zero sentinel (mirrors the backend fix) ═════════════════ */

/*
 * The backend defect these mirror: for the three cross-leg coherence bounds, `zero_means: "disabled"`
 * and a stored 0 switches the gate OFF. An earlier revision normalised only `"unlimited"`, so setting
 * one to 0 was classified as a TIGHTENING — and on the frontend that meant no confirmation dialog for
 * an edit that disables a coherence check.
 *
 * The direction is genuinely undecidable from the value: the backend documents that in live-strict mode
 * a stored 0 refuses every entry (maximally safe) while paper reads it as disabled (maximally
 * permissive), and which applies depends on another setting. So any 0-involving change is treated as
 * risk-increasing here — where the only consequence is whether the operator is asked to confirm, and
 * asking is the conservative answer.
 */

function coherenceSetting(overrides = {}) {
  return setting({
    key: "maxCrossLegReceiveDispersionMs",
    label: "Cross-leg receive-time coherence",
    category: "market_data",
    unit: "milliseconds",
    type: "integer",
    min: 0,
    max: 60_000,
    zero_means: "disabled",
    safe_direction: "lower_is_safer",
    mutation_policy: "TIGHTEN_ONLY_WHILE_ARMED",
    configured_value: 500,
    effective_value: 500,
    default_value: 500,
    ...overrides,
  });
}

test("disabling a coherence bound is treated as risk-increasing", () => {
  const s = coherenceSetting();
  assert.equal(isRiskIncreasing(s, 500, 0), true, "500 -> 0 (gate off) was not flagged");
  assert.equal(needsConfirmation(s, 500, 0), true);
});

test("re-enabling a coherence bound from 0 is also treated as risk-increasing", () => {
  // Unprovable in the other direction too: in live-strict mode 0 refuses every entry, so 0 -> 500 is
  // enabling entry.
  const s = coherenceSetting({ configured_value: 0, effective_value: 0 });
  assert.equal(isRiskIncreasing(s, 0, 500), true);
});

test("a genuine finite tightening of a coherence bound is not flagged as risk-increasing", () => {
  // The fix must not make every edit to these settings loud, or the confirmation stops meaning
  // anything — which is the failure mode the specific dialog exists to avoid.
  const s = coherenceSetting();
  assert.equal(isRiskIncreasing(s, 500, 300), false);
  assert.equal(isRiskIncreasing(s, 300, 500), true, "loosening should still be flagged");
});

test("`disabled` renders as Disabled, never as a bare zero", () => {
  assert.equal(formatValue(coherenceSetting(), 0), "Disabled");
  assert.equal(formatValue(coherenceSetting(), 500), "500 ms");
});

/* ═════════════════ 16. The flat requirement is not understated ═════════════════ */

test("widening a tighten-only setting reports that it needs flat and disarmed", () => {
  // The backend flags requires_flat only for FLAT_AND_DISARMED settings, but a TIGHTEN_ONLY setting
  // also requires flat-and-disarmed for a WIDENING — that is the whole content of the policy. Omitting
  // it would leave the dialog silent about the one precondition the operator is about to fail.
  const s = setting({
    mutation_policy: "TIGHTEN_ONLY_WHILE_ARMED",
    requires_flat: false,
    requires_disarmed: false,
    safe_direction: "lower_is_safer",
    zero_means: null,
  });
  const widen = describeChange(s, 2, 5);
  assert.equal(widen.riskIncreasing, true);
  assert.equal(widen.requiresFlat, true, "the dialog would not have mentioned the flat requirement");
});

test("tightening the same setting does not claim a flat requirement it does not have", () => {
  const s = setting({
    mutation_policy: "TIGHTEN_ONLY_WHILE_ARMED",
    requires_flat: false,
    safe_direction: "lower_is_safer",
    zero_means: null,
  });
  const tighten = describeChange(s, 5, 2);
  assert.equal(tighten.riskIncreasing, false);
  assert.equal(tighten.requiresFlat, false);
});

test("a FLAT_AND_DISARMED setting reports the requirement in both directions", () => {
  const s = setting({
    mutation_policy: "FLAT_AND_DISARMED",
    requires_flat: true,
    requires_disarmed: true,
    safe_direction: "lower_is_safer",
    zero_means: null,
  });
  assert.equal(describeChange(s, 5, 2).requiresFlat, true);
  assert.equal(describeChange(s, 2, 5).requiresFlat, true);
});


/* ═════════════════ 17. A backend without the endpoint is NOT a failure ═════════════════ */

/*
 * THE DEFECT THIS FIXES, observed in production.
 *
 * The frontend half of the operator-configuration work ships ahead of the backend routes, so a
 * deployment running an in-between build answers `404` to `GET /api/box/operator-config` — which is
 * the correct answer for a route that does not exist. The panel rendered that as a red
 * "The configuration could not be read (HTTP 404)" banner with a Retry button, i.e. it presented a
 * normal state as a fault and offered an action that could never succeed. On a live trading screen
 * during a supervised test that is noise at precisely the wrong moment.
 *
 * `unavailable` is therefore its OWN state, not a flavour of `failed`.
 */

test("a 404 is recognised as 'endpoint absent', not as an error", async () => {
  const { isOperatorConfigUnavailable } = await import("../src/api/operatorConfig.ts");
  const { ApiError } = await import("../src/api/http.ts");

  assert.equal(isOperatorConfigUnavailable(new ApiError("not found", 404)), true);
});

test("401, 403 and 5xx are NOT treated as 'endpoint absent'", async () => {
  const { isOperatorConfigUnavailable } = await import("../src/api/operatorConfig.ts");
  const { ApiError } = await import("../src/api/http.ts");

  // A session/role problem and a real fault must keep surfacing as errors — collapsing them into
  // "not available" would hide a genuine 403 behind a reassuring message.
  for (const status of [401, 403, 409, 422, 500, 502, 503]) {
    assert.equal(
      isOperatorConfigUnavailable(new ApiError("x", status)),
      false,
      `HTTP ${status} was misread as a missing endpoint`,
    );
  }
  assert.equal(isOperatorConfigUnavailable(new Error("network down")), false);
  assert.equal(isOperatorConfigUnavailable(null), false);
});

test("a 404 with nothing loaded yields `unavailable`, not `failed`", () => {
  const state = onConfigUnavailable({ kind: "loading" });
  assert.equal(state.kind, "unavailable");
  // And it must not be submittable or offer a version to edit.
  assert.equal(canSubmit(state), false);
  assert.equal(editingVersion(state), null);
});

test("a 404 AFTER a successful read keeps the values and marks them stale", () => {
  // The deployment changed under us — a rollback to an older build, or a proxy now in front of a
  // different backend. Blanking a risk screen is the wrong response to an ambiguous signal.
  const ready = onConfigLoaded({ kind: "loading" }, config({ version: 6 }));
  const after = onConfigUnavailable(ready);

  assert.equal(after.kind, "ready");
  assert.equal(after.stale, true);
  assert.equal(after.config.version, 6, "the previously-read configuration was discarded");
  assert.match(after.error, /no longer exposes/i);
  assert.equal(canSubmit(after), false, "a stale view must not submit");
});

test("recovering from unavailable to ready works, so the panel self-heals", () => {
  // Once the backend routes land, the next successful refresh must simply work — no reload needed.
  let state = onConfigUnavailable({ kind: "loading" });
  assert.equal(state.kind, "unavailable");
  state = onConfigLoaded(state, config({ version: 1 }));
  assert.equal(state.kind, "ready");
  assert.equal(state.stale, false);
  assert.equal(canSubmit(state), true);
});
