/**
 * TWO SNAPSHOTS, FETCHED SEPARATELY, MUST NOT BE ABLE TO PROMISE AN EXIT BETWEEN THEM.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The dashboard reads its two sources INDEPENDENTLY, on separate timers, with separate failure
 * modes:
 *
 *   GET /api/runtime/status  → RuntimeStatus        (pg_ready, live_entry.reasons)
 *   GET /api/box/status      → OperationalReadiness (exposure_management, blockers)
 *
 * So they disagree. Reproducing case, measured on e6c8ca8:
 *
 *   FRESH runtime      live_entry.reasons = ["durable_store_unavailable"], pg_ready = true
 *   OLDER readiness    exit_and_reduce / protective_cancel / manage_working_orders ALL true
 *
 * produced exactly ONE banner, at WARN, which named the outage in its first clause and then
 * contradicted itself in the second:
 *
 *   [warn] entry: "Live entry is blocked — the durable order-intent store cannot be written, so
 *                  nothing can reach the broker. Open positions are still monitored, and the backend
 *                  confirms exiting, reducing and protective cancellation all remain available."
 *
 * No outage banner at all, because the outage was keyed off the readiness blockers alone and
 * `pg_ready` is a startup latch that stays true after a mid-session failure.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS ASSERTED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The RENDERED BANNER TEXT, not a helper boolean. The defect was that the text on an operator's
 * screen was wrong; a green assertion on an internal flag would not have caught it and did not.
 *
 * Six scenarios: startup outage, mid-session outage, BOTH conflicting orderings, stale and failed
 * refresh, recovery, and the ordinary case where entry is disarmed but reduction genuinely remains
 * available — which must still say so, or the sentence becomes noise operators learn to skip.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntimeBanners } from "../src/lib/runtimeBanners.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */

const NOW = 1_700_000_000_000;

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

const readinessWith = ({
  exit_and_reduce = true,
  protective_cancel = true,
  manage_working_orders = true,
  blocked_reasons = [],
  entryReasons = [],
  reconciliationBlockers = [],
} = {}) => ({
  entry: { permitted: entryReasons.length === 0, reasons: entryReasons },
  reconciliation: { pending: false, blockers: reconciliationBlockers },
  exposure_management: {
    exit_and_reduce,
    protective_cancel,
    manage_working_orders,
    blocked_reasons,
    limitations: ["reduction depends on the broker accepting the order"],
    open_positions: 1,
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

/** What GAR_B publishes once readiness has caught up with the outage. */
const COHERENT_OUTAGE_READINESS = readinessWith({
  exit_and_reduce: false,
  protective_cancel: false,
  manage_working_orders: false,
  blocked_reasons: [DURABLE_BLOCKER],
  entryReasons: [DURABLE_BLOCKER],
});

/** The STALE snapshot at the heart of the defect: still claims all three permissions. */
const STALE_PERMISSIVE_READINESS = readinessWith();

const fresh = { freshness: "fresh", ageMs: 1_000, consecutiveFailures: 0, lastError: null, detail: "Refreshed 1s ago." };
const staleRefresh = {
  freshness: "stale",
  ageMs: 40_000,
  consecutiveFailures: 4,
  lastError: "network error",
  detail: "The last successful refresh was 40s ago, past the freshness limit. Treat this as stale.",
};
const unknownRefresh = {
  freshness: "unknown",
  ageMs: null,
  consecutiveFailures: 2,
  lastError: "network error",
  detail: "No refresh has ever succeeded.",
};

const build = (args) => buildRuntimeBanners({ exportStatus: null, ...args });
const keyed = (banners, key) => banners.find((b) => b.key === key);
/** The whole rendered surface, exactly as an operator reads it. */
const allText = (banners) => banners.map((b) => b.text).join("\n");

/** Phrases that assert an exit is possible. Any of these, while reduction is not, is a lie. */
const REASSURANCES = [
  /can still exit/i,
  /all remain available/i,
  /still monitored and can still/i,
  /reduction continues/i,
  /exits?,? .{0,40}(are|is) unaffected/i,
];

function assertNoPromise(banners, label) {
  for (const banner of banners) {
    for (const phrase of REASSURANCES) {
      assert.doesNotMatch(banner.text, phrase, `${label}: banner "${banner.key}" promises an exit`);
    }
  }
}

/* ═══════════════════ 1. STARTUP outage — pg_ready === false ═══════════════════ */

test("STARTUP outage: the rendered text reports the outage and refuses to promise an exit", () => {
  const banners = build({
    runtime: runtimeWith({ pg_ready: false, live_entry: { blocked: true, reasons: ["postgres_unavailable"] } }),
    readiness: COHERENT_OUTAGE_READINESS,
    refresh: fresh,
  });

  const pg = keyed(banners, "pg");
  assert.ok(pg, "the startup branch must fire");
  assert.equal(pg.kind, "error");
  assert.match(pg.text, /PostgreSQL is unavailable/);
  assert.match(pg.text, /reduction is ALSO unavailable/i);
  assert.match(pg.text, /broker terminal/);

  assert.equal(keyed(banners, "pg-midsession"), undefined, "not ALSO reported as mid-session");
  // The sources agree here, so there is nothing to warn about.
  assert.equal(keyed(banners, "readiness-conflict"), undefined);
  assertNoPromise(banners, "startup outage");
});

/* ═══════════════════ 2. MID-SESSION outage, sources COHERENT ═══════════════════ */

test("MID-SESSION outage with both sources agreeing: reported, no conflict banner", () => {
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["durable_store_unavailable"] } }),
    readiness: COHERENT_OUTAGE_READINESS,
    refresh: fresh,
  });

  const mid = keyed(banners, "pg-midsession");
  assert.ok(mid, "pg_ready is true, so only the mid-session branch can report this");
  assert.equal(mid.kind, "error");
  assert.match(mid.text, /PostgreSQL FAILED MID-SESSION/);
  assert.match(mid.text, /startup/i, "it explains why the healthy-looking indicator cannot be trusted");
  assert.equal(keyed(banners, "readiness-conflict"), undefined, "the sources agree");
  assertNoPromise(banners, "coherent mid-session outage");
});

/* ═══════════════ 3. THE DEFECT: fresh runtime outage vs OLDER permissive readiness ═══════════════ */

test("CONFLICT (runtime fresher): a fresh outage overrides an older 'reduction available' claim", () => {
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["durable_store_unavailable"] } }),
    readiness: STALE_PERMISSIVE_READINESS,
    refresh: fresh,
    observedAt: { runtime: NOW, readiness: NOW - 45_000 },
  });

  // (a) The outage is on screen at all — it was completely absent before.
  const mid = keyed(banners, "pg-midsession");
  assert.ok(mid, "the outage MUST be reported even though readiness has not caught up");
  assert.equal(mid.kind, "error");

  // (b) The display says it made a choice, and names the disagreement.
  const conflict = keyed(banners, "readiness-conflict");
  assert.ok(conflict, "the operator must be told the two snapshots disagree");
  assert.equal(conflict.kind, "error");
  assert.match(conflict.text, /CONFLICTING READINESS SNAPSHOTS/);
  assert.match(conflict.text, /FAILED CLOSED/);
  assert.match(conflict.text, /read 45s before the runtime one/, "the observed gap is stated");
  assert.match(conflict.text, /broker terminal/);

  // (c) The entry banner no longer contradicts itself in its own second clause.
  const entry = keyed(banners, "entry");
  assert.equal(entry.kind, "error", "entry blocked with no way out is an incident, not a warning");
  assert.match(entry.text, /REDUCTION IS NOT FULLY AVAILABLE/);
  assert.match(entry.text, /exiting and reducing/);
  assert.match(entry.text, /protective cancellation/);
  assert.match(entry.text, /managing working orders/);

  // (d) THE HEADLINE. Nothing anywhere on screen promises an exit.
  assertNoPromise(banners, "conflict, runtime fresher");
  assert.doesNotMatch(
    allText(banners),
    /backend confirms exiting/,
    "the exact false sentence from the defect must be gone",
  );
});

test("CONFLICT with NO observation times: still fails closed, and says ordering is unknowable", () => {
  // `RuntimeStatus` carries no timestamp or generation, so a caller that does not track observation
  // times has NO way to order the two. The verdict must not soften — only the wording changes.
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["durable_store_unavailable"] } }),
    readiness: STALE_PERMISSIVE_READINESS,
    refresh: fresh,
  });

  const conflict = keyed(banners, "readiness-conflict");
  assert.ok(conflict);
  assert.match(conflict.text, /carry no shared ordering/);
  assert.match(conflict.text, /FAILED CLOSED/);
  assert.ok(keyed(banners, "pg-midsession"), "the outage is still reported");
  assertNoPromise(banners, "conflict, ordering unknown");
});

test("CONFLICT (reverse order): readiness reports the outage while runtime looks clean", () => {
  /*
   * The other arrival order, and it must be just as safe. Here the Box snapshot is the one that has
   * seen the failure and the runtime response is the stale one. Reading only `runtime` — the naive
   * fix for the case above — would have reintroduced the identical defect mirrored.
   */
  const banners = build({
    runtime: runtimeWith(), // healthy: pg_ready true, entry not blocked
    readiness: COHERENT_OUTAGE_READINESS,
    refresh: fresh,
    observedAt: { runtime: NOW - 30_000, readiness: NOW },
  });

  assert.ok(keyed(banners, "pg-midsession"), "the readiness-side outage must still surface");
  assertNoPromise(banners, "conflict, readiness fresher");
  // Readiness itself already reports all three permissions false, so there is no permissive claim to
  // contradict — the restrictive reading is simply the only reading.
  assert.equal(keyed(banners, "readiness-conflict"), undefined);
});

test("a fresh runtime outage beats a permissive readiness snapshot on EVERY permission", () => {
  // The three are kept DISTINCT elsewhere, but an unwritable store blocks all three — so all three
  // must be named, not collapsed into one word.
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["durable_store_unavailable"] } }),
    readiness: readinessWith({ exit_and_reduce: true, protective_cancel: true, manage_working_orders: true }),
    refresh: fresh,
  });
  const text = allText(banners);
  for (const permission of ["exiting and reducing", "protective cancellation", "managing working orders"]) {
    assert.ok(text.includes(permission), `${permission} must be named as unavailable`);
  }
});

/* ═══════════════════ 4. STALE / FAILED refresh ═══════════════════ */

test("STALE refresh: an 'all three available' snapshot degrades to UNKNOWN, never confirmed", () => {
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["box_live_trading_disabled"] } }),
    readiness: readinessWith(),
    refresh: staleRefresh,
  });

  const freshness = keyed(banners, "readiness-freshness");
  assert.ok(freshness, "staleness itself is reported first");
  assert.match(freshness.text, /Readiness may be STALE/);

  const entry = keyed(banners, "entry");
  assert.match(entry.text, /UNKNOWN/, "a permission read from a stale snapshot is not a permission");
  assert.match(entry.text, /not current/i);
  assert.equal(entry.kind, "error");
  assertNoPromise(banners, "stale refresh");
});

test("FAILED refresh (never succeeded): also UNKNOWN, and says so loudly", () => {
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["box_live_trading_disabled"] } }),
    readiness: readinessWith(),
    refresh: unknownRefresh,
  });

  const freshness = keyed(banners, "readiness-freshness");
  assert.equal(freshness.kind, "error");
  assert.match(freshness.text, /Readiness is UNKNOWN/);
  assert.match(freshness.text, /Do not read the absence of a warning as an all-clear/);

  assert.match(keyed(banners, "entry").text, /UNKNOWN/);
  assertNoPromise(banners, "failed refresh");
});

test("a stale refresh does NOT soften a real outage into merely 'unknown'", () => {
  // Staleness must degrade an optimistic claim, but it must never downgrade a KNOWN outage: "we are
  // not sure" is weaker than "the store is unwritable", and the operator needs the stronger one.
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["durable_store_unavailable"] } }),
    readiness: COHERENT_OUTAGE_READINESS,
    refresh: staleRefresh,
  });

  assert.ok(keyed(banners, "pg-midsession"), "the outage is still stated as fact");
  assert.match(keyed(banners, "entry").text, /REDUCTION IS NOT FULLY AVAILABLE/);
  assertNoPromise(banners, "stale + outage");
});

/* ═══════════════════ 5. RECOVERY ═══════════════════ */

test("RECOVERED: once both sources are healthy and fresh, nothing is reported", () => {
  const banners = build({ runtime: runtimeWith(), readiness: readinessWith(), refresh: fresh });
  assert.deepEqual(banners, [], "a fully healthy, coherent, fresh system shows nothing at all");
});

test("RECOVERY in progress with reduction genuinely available: the assurance IS made", () => {
  const banners = build({
    runtime: runtimeWith({ recovery_pending: true, recovery_ready: false }),
    readiness: readinessWith(),
    refresh: fresh,
  });
  const recovery = keyed(banners, "recovery");
  assert.ok(recovery);
  assert.equal(recovery.kind, "warn", "reduction works, so this is a warning and not an incident");
  assert.match(recovery.text, /backend confirms/, "the claim is attributed, not asserted");
  assert.match(recovery.text, /new entry is closed/i);
});

test("RECOVERY while the store is down: the old 'Reduction continues' must not reappear", () => {
  const banners = build({
    runtime: runtimeWith({
      recovery_pending: true,
      recovery_ready: false,
      live_entry: { blocked: true, reasons: ["durable_store_unavailable"] },
    }),
    readiness: STALE_PERMISSIVE_READINESS,
    refresh: fresh,
  });
  const recovery = keyed(banners, "recovery");
  assert.ok(recovery);
  assert.equal(recovery.kind, "error");
  assert.doesNotMatch(recovery.text, /Reduction continues/i);
  assert.match(recovery.text, /REDUCTION IS NOT FULLY AVAILABLE/);
  assertNoPromise(banners, "recovery during outage");
});

/* ═══════════════════ 6. THE ORDINARY CASE — it must still reassure ═══════════════════ */

test("ORDINARY: entry disarmed by a config flag, reduction available — says so, and correctly", () => {
  /*
   * The case the original wording was written for, and the reason this whole mechanism cannot simply
   * refuse to ever reassure. A disarmed BOX_LIVE_TRADING_ENABLED is not an exposure problem. If the
   * banner hedged here too, operators would learn that the sentence means nothing and ignore it
   * during an actual outage.
   */
  const banners = build({
    runtime: runtimeWith({ live_entry: { blocked: true, reasons: ["box_live_trading_disabled"] } }),
    readiness: readinessWith(),
    refresh: fresh,
  });

  const entry = keyed(banners, "entry");
  assert.ok(entry);
  assert.equal(entry.kind, "warn", "not an incident: nothing is wrong with the exposure");
  assert.match(entry.text, /BOX_LIVE_TRADING_ENABLED is false/, "it still says WHY entry is blocked");
  assert.match(entry.text, /still monitored/);
  assert.match(entry.text, /exiting, reducing and protective cancellation all remain available/);
  assert.match(entry.text, /backend confirms/, "attributed to the decision, not asserted by the UI");

  assert.equal(keyed(banners, "readiness-conflict"), undefined, "an entry-only flag is no conflict");
  assert.equal(keyed(banners, "pg-midsession"), undefined, "and no outage");
});

test("ENTRY-ONLY reasons never masquerade as reduction problems", () => {
  // The override set must stay tight. If any of these started forcing `blocked`, the assurance would
  // be useless in normal operation — which is how it ends up ignored.
  const entryOnly = [
    "box_live_trading_disabled",
    "zerodha_live_trading_disabled",
    "market_closed",
    "scanner_stopped",
    "entry_disabled",
    "migrations_pending",
    "active_broker_token_not_ready",
  ];
  for (const reason of entryOnly) {
    const banners = build({
      runtime: runtimeWith({ live_entry: { blocked: true, reasons: [reason] } }),
      readiness: readinessWith(),
      refresh: fresh,
    });
    assert.equal(keyed(banners, "pg-midsession"), undefined, `${reason} must not fake an outage`);
    assert.match(
      keyed(banners, "entry").text,
      /all remain available/,
      `${reason} is entry-only, so the assurance must still be made`,
    );
  }
});

test("both PostgreSQL reason codes are honoured as reduction-blocking", () => {
  for (const reason of ["durable_store_unavailable", "postgres_unavailable"]) {
    const banners = build({
      runtime: runtimeWith({ live_entry: { blocked: true, reasons: [reason] } }),
      readiness: STALE_PERMISSIVE_READINESS,
      refresh: fresh,
    });
    assert.ok(keyed(banners, "pg-midsession"), `${reason} must raise the outage banner`);
    assertNoPromise(banners, reason);
  }
});
