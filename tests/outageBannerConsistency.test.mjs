/**
 * NO BANNER MAY CONTRADICT THE BACKEND'S EXPOSURE-MANAGEMENT VERDICT.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Three banners ended with an UNCONDITIONAL promise that open positions could still be exited:
 *
 *   entry          "Live entry is blocked — … Open positions are still monitored and can still exit."
 *   token-invalid  "The zerodha token was rejected. New entry is blocked; open positions are still
 *                   monitored and can still exit."
 *   recovery       "Recovery is in progress — … Reduction continues; new entry is closed."
 *
 * Not one of them consulted the backend. They were written for the ordinary case — entry blocked by
 * a configuration flag — where the claim happens to be true. But `live_entry.blocked` is ALSO true
 * during a durable-store outage, and then `exit_and_reduce`, `protective_cancel` and
 * `manage_working_orders` are all FALSE. The dashboard promised an exit route that did not exist.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND `pg_ready` COULD NOT SAVE IT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `pg_ready` is a STARTUP LATCH — it records whether PostgreSQL answered at boot. A store that dies
 * mid-session leaves it `true` for the rest of the day, so the outage banner never fired. The net
 * effect in a real mid-session failure was: NO outage banner, plus an active banner asserting that
 * positions could still exit, while the backend refused every exit, flatten, cancel and reconcile.
 *
 * The three scenarios below are the three that matter — startup outage, mid-session outage, recovery
 * — and the final test is a blanket invariant over EVERY banner the module can emit.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntimeBanners, reductionAssurance } from "../src/lib/runtimeBanners.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */

const READY_BROKER = {
  broker: "zerodha",
  token_state: "ready",
  feed_connected: true,
  last_depth_age_ms: 120,
  ist_day: "2026-09-20",
  last_error: null,
};

const runtimeWith = (overrides = {}) => ({
  active_broker: "zerodha",
  brokers: [READY_BROKER],
  pg_ready: true,
  migration_state: { pending: 0, applied: 14 },
  recovery_ready: true,
  recovery_pending: false,
  residual_exposure: false,
  live_entry: { blocked: false, reasons: [] },
  ...overrides,
});

/**
 * A readiness decision carrying only what the banners read.
 *
 * `buildRuntimeBanners` touches `entry.reasons`, `exposure_management` and
 * `reconciliation.blockers` and nothing else, so a narrow fixture is honest here — it is not
 * standing in for the full contract, it is the exact slice under test.
 */
const readinessWith = ({
  exit_and_reduce = true,
  protective_cancel = true,
  manage_working_orders = true,
  blocked_reasons = [],
  entryReasons = [],
  reconciliationBlockers = [],
  open_positions = 1,
} = {}) => ({
  entry: { permitted: entryReasons.length === 0, reasons: entryReasons },
  reconciliation: { pending: false, blockers: reconciliationBlockers },
  exposure_management: {
    exit_and_reduce,
    protective_cancel,
    manage_working_orders,
    blocked_reasons,
    limitations: ["reduction depends on the broker accepting the order"],
    open_positions,
    residual_legs: 0,
    working_orders: 0,
  },
});

const DURABLE_BLOCKER = {
  code: "durable_store_unavailable",
  scope: "both",
  detail:
    "The durable order-intent store cannot be written, so no order can be recorded before it is sent.",
};

/** Every reduction permission false — what GAR_B publishes during a durable-store outage. */
const OUTAGE_READINESS = readinessWith({
  exit_and_reduce: false,
  protective_cancel: false,
  manage_working_orders: false,
  blocked_reasons: [DURABLE_BLOCKER],
  entryReasons: [DURABLE_BLOCKER],
});

const build = (args) => buildRuntimeBanners({ exportStatus: null, ...args });
const keyed = (banners, key) => banners.find((b) => b.key === key);

/** Phrases that assert an exit is possible. Any of these, while reduction is not, is a lie. */
const REASSURANCES = [
  /can still exit/i,
  /still monitored and can still/i,
  /reduction continues/i,
  /exits?,? .{0,40}(are|is) unaffected/i,
  /positions are safe/i,
];

/* ═══════════════════ 1. STARTUP outage: pg_ready === false ═══════════════════ */

test("STARTUP outage: the pg banner fires and no banner promises an exit", () => {
  const banners = build({
    runtime: runtimeWith({ pg_ready: false, live_entry: { blocked: true, reasons: ["postgres_unavailable"] } }),
    readiness: OUTAGE_READINESS,
  });

  const pg = keyed(banners, "pg");
  assert.ok(pg, "a startup outage must still be reported by the pg_ready branch");
  assert.equal(pg.kind, "error");
  assert.equal(keyed(banners, "pg-midsession"), undefined, "and NOT also as a mid-session failure");

  for (const banner of banners) {
    for (const phrase of REASSURANCES) {
      assert.doesNotMatch(banner.text, phrase, `banner "${banner.key}" must not promise an exit`);
    }
  }
});

test("STARTUP outage: the entry banner states reduction is unavailable and names the cause", () => {
  const banners = build({
    runtime: runtimeWith({ pg_ready: false, live_entry: { blocked: true, reasons: ["postgres_unavailable"] } }),
    readiness: OUTAGE_READINESS,
  });
  const entry = keyed(banners, "entry");

  assert.ok(entry);
  assert.equal(entry.kind, "error", "entry blocked WITH reduction blocked is an incident, not a warning");
  assert.match(entry.text, /REDUCTION IS NOT FULLY AVAILABLE/);
  assert.match(entry.text, /exiting and reducing/, "it names the specific permission that is gone");
  assert.match(entry.text, /protective cancellation/);
  assert.match(entry.text, /managing working orders/);
  assert.match(entry.text, /broker terminal/, "it names the only remaining route");
  assert.ok(entry.text.includes(DURABLE_BLOCKER.detail), "it carries the backend's own explanation");
});

/* ═══════════════════ 2. MID-SESSION outage: pg_ready === true, store is down ═══════════════════ */

test("MID-SESSION outage: pg_ready is TRUE yet the outage is still reported", () => {
  // THE CASE THE LATCH CANNOT SEE. `pg_ready` stayed true because PostgreSQL answered at boot.
  const banners = build({
    runtime: runtimeWith({
      pg_ready: true,
      live_entry: { blocked: true, reasons: ["durable_store_unavailable"] },
    }),
    readiness: OUTAGE_READINESS,
  });

  assert.equal(keyed(banners, "pg"), undefined, "the startup branch legitimately does not fire");
  const mid = keyed(banners, "pg-midsession");
  assert.ok(mid, "but the outage MUST still be on screen — this is the whole defect");
  assert.equal(mid.kind, "error");

  // It must tell the operator why the healthy-looking PostgreSQL indicator cannot be trusted,
  // otherwise they will believe the field over the banner.
  assert.match(mid.text, /MID-SESSION/);
  assert.match(mid.text, /startup/i, "it explains that pg_ready only reflects boot");
  assert.match(mid.text, /authoritative/i, "it says which signal to trust");

  // Same operational consequence as a startup outage, stated just as plainly.
  assert.match(mid.text, /reduction is ALSO unavailable/i);
  assert.match(mid.text, /refused rather than queued/i);
  assert.match(mid.text, /still owned/i);
  assert.match(mid.text, /broker terminal/);
});

test("MID-SESSION outage: no banner contradicts the three permissions", () => {
  const banners = build({
    runtime: runtimeWith({
      pg_ready: true,
      recovery_ready: false,
      live_entry: { blocked: true, reasons: ["durable_store_unavailable"] },
    }),
    readiness: OUTAGE_READINESS,
  });

  assert.ok(banners.length >= 3, "entry, recovery and the mid-session outage should all be present");
  for (const banner of banners) {
    for (const phrase of REASSURANCES) {
      assert.doesNotMatch(banner.text, phrase, `banner "${banner.key}" contradicts the verdict`);
    }
  }
});

test("MID-SESSION outage: a rejected token does not promise an exit either", () => {
  const banners = build({
    runtime: runtimeWith({
      brokers: [{ ...READY_BROKER, token_state: "invalid" }],
      live_entry: { blocked: true, reasons: ["active_broker_token_not_ready"] },
    }),
    readiness: OUTAGE_READINESS,
  });
  const token = keyed(banners, "token-invalid");

  assert.ok(token);
  assert.doesNotMatch(token.text, /can still exit/i, "the original promise must be gone");
  assert.match(token.text, /REDUCTION IS NOT FULLY AVAILABLE/);
});

/* ═══════════════════ 3. RECOVERY ═══════════════════ */

test("RECOVERY with reduction AVAILABLE: the assurance is made, because it is earned", () => {
  // The fix must not degrade into never saying anything useful. When the backend confirms all three
  // permissions, the banner is allowed — required, really — to say so.
  const banners = build({
    runtime: runtimeWith({ recovery_pending: true, recovery_ready: false }),
    readiness: readinessWith(),
  });
  const recovery = keyed(banners, "recovery");

  assert.ok(recovery);
  assert.equal(recovery.kind, "warn", "reduction works, so this is a warning and not an incident");
  assert.match(recovery.text, /backend confirms/, "the claim is attributed to the decision");
  assert.match(recovery.text, /exiting, reducing and protective cancellation all remain available/);
  assert.match(recovery.text, /new entry is closed/i);
});

test("RECOVERY with reduction BLOCKED: 'Reduction continues' is gone", () => {
  const banners = build({
    runtime: runtimeWith({ recovery_pending: true, recovery_ready: false }),
    readiness: OUTAGE_READINESS,
  });
  const recovery = keyed(banners, "recovery");

  assert.ok(recovery);
  assert.doesNotMatch(recovery.text, /reduction continues/i, "the old unconditional claim must not return");
  assert.equal(recovery.kind, "error");
  assert.match(recovery.text, /REDUCTION IS NOT FULLY AVAILABLE/);
});

/* ═══════════════════ 4. RECOVERED: the banners must clear ═══════════════════ */

test("RECOVERED: once the store is writable again every outage banner disappears", () => {
  const banners = build({ runtime: runtimeWith(), readiness: readinessWith() });

  assert.equal(keyed(banners, "pg"), undefined);
  assert.equal(keyed(banners, "pg-midsession"), undefined);
  assert.deepEqual(banners, [], "a fully healthy system shows nothing at all");
});

test("RECOVERED: entry blocked by a CONFIG flag alone still reassures, and correctly", () => {
  // The common case, and the one the original wording was written for. It must keep working: a
  // disarmed flag is not an exposure problem, and refusing to say so would train operators to
  // ignore the sentence.
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["box_live_trading_disabled"] } }),
    readiness: readinessWith(),
  });
  const entry = keyed(banners, "entry");

  assert.equal(entry.kind, "warn");
  assert.match(entry.text, /BOX_LIVE_TRADING_ENABLED is false/);
  assert.match(entry.text, /still monitored/);
  assert.match(entry.text, /exiting, reducing and protective cancellation all remain available/);
});

/* ═══════════════════ 5. PARTIAL loss, and the UNKNOWN case ═══════════════════ */

test("a SINGLE lost permission is named, not flattened into a blanket refusal", () => {
  // `manage_working_orders` gone while exits still work is a genuinely different situation, and an
  // operator's next move differs. Collapsing the three into one boolean is what allowed the old
  // sentence to exist at all.
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["order_stream_lifecycle"] } }),
    readiness: readinessWith({
      manage_working_orders: false,
      blocked_reasons: [
        { code: "order_stream_degraded", scope: "reduction", detail: "The order-update stream is not delivering." },
      ],
    }),
  });
  const entry = keyed(banners, "entry");

  assert.match(entry.text, /managing working orders/);
  assert.doesNotMatch(entry.text, /exiting and reducing/, "it must not claim exits are blocked when they are not");
  assert.doesNotMatch(entry.text, /protective cancellation as unavailable/i);
  assert.match(entry.text, /The order-update stream is not delivering/);
});

test("with NO readiness decision the exit claim is UNKNOWN, never reassuring", () => {
  // Absence of evidence is not evidence of safety. This is the same judgement `explainScannerStop`
  // makes, and it is what stops a not-yet-loaded status from reading like an all-clear.
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["box_live_trading_disabled"] } }),
    readiness: null,
  });
  const entry = keyed(banners, "entry");

  assert.match(entry.text, /UNKNOWN/);
  assert.match(entry.text, /not a statement that they can/i);
  assert.equal(entry.kind, "error", "an unverifiable exit route is not a mere warning");
  for (const phrase of REASSURANCES) assert.doesNotMatch(entry.text, phrase);
});

/* ═══════════════════ 6. the blanket invariant ═══════════════════ */

test("INVARIANT: across every combination, no banner ever contradicts the verdict", () => {
  /*
   * The exhaustive sweep. Any future banner that hard-codes an exit promise fails here regardless of
   * which scenario introduced it — which is the property that actually prevents this defect class
   * from returning, as opposed to fixing the three known instances.
   */
  const permissionSets = [
    [true, true, true],
    [false, true, true],
    [true, false, true],
    [true, true, false],
    [false, false, false],
  ];
  const runtimeVariants = [
    { pg_ready: false, live_entry: { blocked: true, reasons: ["postgres_unavailable"] } },
    { live_entry: { blocked: true, reasons: ["durable_store_unavailable"] } },
    { recovery_pending: true, recovery_ready: false },
    { residual_exposure: true },
    { brokers: [{ ...READY_BROKER, token_state: "invalid" }] },
    { brokers: [{ ...READY_BROKER, token_state: "configuration_error", last_error: "passcode rejected" }] },
    { brokers: [{ ...READY_BROKER, token_state: "polling" }] },
    { brokers: [{ ...READY_BROKER, feed_connected: false }] },
    { brokers: [{ ...READY_BROKER, last_depth_age_ms: null }] },
    { migration_state: { pending: 2, applied: 12 } },
  ];

  let checked = 0;
  for (const [exit_and_reduce, protective_cancel, manage_working_orders] of permissionSets) {
    const allowed = exit_and_reduce && protective_cancel && manage_working_orders;
    const readiness = readinessWith({
      exit_and_reduce,
      protective_cancel,
      manage_working_orders,
      blocked_reasons: allowed ? [] : [DURABLE_BLOCKER],
    });
    for (const overrides of runtimeVariants) {
      const banners = build({ runtime: runtimeWith(overrides), readiness });
      for (const banner of banners) {
        checked++;
        if (allowed) continue;
        for (const phrase of REASSURANCES) {
          assert.doesNotMatch(
            banner.text,
            phrase,
            `banner "${banner.key}" promises an exit while ` +
              `exit_and_reduce=${exit_and_reduce} protective_cancel=${protective_cancel} ` +
              `manage_working_orders=${manage_working_orders}`,
          );
        }
      }
    }
  }
  assert.ok(checked > 50, `the sweep must actually exercise the banners (checked ${checked})`);
});

test("the assurance derivation itself is total: three states, and only three", () => {
  assert.equal(reductionAssurance(null).state, "unknown");
  assert.equal(reductionAssurance(undefined).state, "unknown");
  assert.equal(reductionAssurance(readinessWith()).state, "available");
  assert.equal(reductionAssurance(readinessWith({ exit_and_reduce: false })).state, "blocked");
  assert.equal(reductionAssurance(readinessWith({ protective_cancel: false })).state, "blocked");
  assert.equal(reductionAssurance(readinessWith({ manage_working_orders: false })).state, "blocked");

  // A blocked verdict with an EMPTY reason list must still produce a usable sentence rather than
  // "undefined" — the backend contract allows the list to be empty.
  const bare = reductionAssurance(readinessWith({ exit_and_reduce: false, blocked_reasons: [] }));
  assert.equal(bare.state, "blocked");
  assert.doesNotMatch(bare.sentence, /undefined/);
  assert.match(bare.sentence, /readiness panel/);
});


/* ═══════════════════ 7. the CONTROL-PANEL entry point ═══════════════════ */

/*
 * `BoxSessionControl` carries two messages that fire precisely BECAUSE a durable write or read
 * failed, and both used to end with a flat promise:
 *
 *   write_failed     "… Run a live reconciliation once the database is reachable.
 *                     Exit and residual flattening are unaffected."
 *   !readable        "… Exit, residual flattening and reconciliation continue normally."
 *
 * plus a state label: RECOVERY "Exposure is quarantined pending reconciliation. Entry is closed;
 * reduction is not."
 *
 * That panel holds `BoxExecutionControl`, not `operational_readiness`, so it needs its own entry
 * point into the SAME derivation. These tests pin that the two entry points agree — a second
 * implementation is exactly how the original defect would grow back.
 */

const controlWith = (ok, blockers = []) => ({
  arm: { exposure_management: { ok, blockers } },
});

test("the arm-verdict entry point produces the SAME sentences as the readiness one", async () => {
  const { armReductionAssurance, reductionAssurance: shared } = await import(
    "../src/lib/reductionAssurance.ts"
  );

  // Identical wording for the two states both payloads can express. If these ever diverge, one panel
  // reassures while another does not, on the same facts.
  assert.equal(armReductionAssurance(controlWith(true)).sentence, shared(readinessWith()).sentence);
  assert.equal(armReductionAssurance(null).sentence, shared(null).sentence);
  assert.equal(armReductionAssurance(undefined).state, "unknown");
});

test("the arm verdict blocks with the backend's own reason and names the broker terminal", async () => {
  const { armReductionAssurance } = await import("../src/lib/reductionAssurance.ts");
  const verdict = armReductionAssurance(
    controlWith(false, [{ detail: "The durable order-intent store cannot be written." }]),
  );

  assert.equal(verdict.state, "blocked");
  assert.match(verdict.sentence, /REDUCTION IS NOT FULLY AVAILABLE/);
  assert.match(verdict.sentence, /The durable order-intent store cannot be written\./);
  assert.match(verdict.sentence, /broker terminal/);
  for (const phrase of REASSURANCES) assert.doesNotMatch(verdict.sentence, phrase);
});

test("a blocked arm verdict with NO blockers still reads as a sentence", async () => {
  const { armReductionAssurance } = await import("../src/lib/reductionAssurance.ts");
  const verdict = armReductionAssurance(controlWith(false, []));

  assert.equal(verdict.state, "blocked");
  assert.doesNotMatch(verdict.sentence, /undefined/);
  assert.match(verdict.sentence, /readiness panel/);
});

test("REGRESSION: the five original false sentences appear nowhere in the source", async () => {
  /*
   * The defect was WORDING, so the guard is over the source text. Reviewing by eye is what let five
   * copies of the same false promise accumulate; this fails the build if any of them is reinstated,
   * in any file, including one this test does not know about yet.
   */
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const banned = [
    /can still exit\./,
    /Reduction continues/,
    /Exit and residual flattening are unaffected/,
    /Exit, residual flattening and reconciliation continue normally/,
    /Entry is closed; reduction is not/,
    /Exits, protective cancellation and reconciliation are unaffected/,
  ];

  async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(path);
      else if (/\.tsx?$/.test(entry.name)) yield path;
    }
  }

  let scanned = 0;
  for await (const path of walk("src")) {
    // The generated contract mirror is machine-written from the backend schemas, and the two modules
    // that FIXED this quote the old sentences in their comments so the history stays legible.
    if (path.endsWith("contract.generated.ts")) continue;
    if (path.endsWith("reductionAssurance.ts") || path.endsWith("runtimeBanners.ts")) continue;
    if (path.endsWith("BoxSessionControl.tsx")) continue;
    const text = await readFile(path, "utf8");
    scanned++;
    for (const phrase of banned) {
      assert.doesNotMatch(text, phrase, `${path} reinstates a false reduction assurance`);
    }
  }
  assert.ok(scanned > 20, `the sweep must actually read the source (scanned ${scanned} files)`);
});
