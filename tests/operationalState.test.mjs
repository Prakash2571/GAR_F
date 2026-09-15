/**
 * OPERATIONAL-STATE DERIVATION TESTS (item 10).
 *
 * These prove the load-bearing HONESTY properties of the operational panel, on the SAME pure
 * functions the component renders (no DOM needed):
 *
 *   1. Market-data health and order-update health are INDEPENDENT — a READY market-data feed does
 *      not make the order stream "live", and a live order stream does not make the feed READY.
 *   2. A reconnecting / degraded feed is the "paused-but-safe" band (positions still manageable),
 *      DISTINCT from a disconnected / expired feed which is "broken".
 *   3. Entry is permitted ONLY when the market-data feed is READY; the reasons are stated.
 *   4. The economic figures keep gross notional and margin as DISTINCT quantities.
 *   5. Funnel ratios carry their denominator and report an undefined ratio as null, never 0/1.
 *
 * It also validates against the retained box-status fixture so the derivations are exercised on a
 * real captured payload shape.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  bandClass,
  bandGlyph,
  deriveActiveOrderStream,
  deriveEconomicFigures,
  deriveEntryGate,
  deriveFunnel,
  deriveMarketData,
  marketDataBand,
  orderStreamBrokerBand,
  formatRatio,
} from "../src/lib/operationalState.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(HERE, "fixtures", "box-status.json"), "utf8"));

/* ─────────────────────────── market-data band classification ─────────────────────────── */

test("marketDataBand maps the eight states into the three operator bands (+absent)", () => {
  assert.equal(marketDataBand("READY"), "ready");
  assert.equal(marketDataBand("CONNECTING"), "paused");
  assert.equal(marketDataBand("AUTHENTICATING"), "paused");
  assert.equal(marketDataBand("SYNCHRONIZING"), "paused");
  assert.equal(marketDataBand("DEGRADED"), "paused");
  assert.equal(marketDataBand("DISCONNECTED"), "broken");
  assert.equal(marketDataBand("AUTH_EXPIRED"), "broken");
  assert.equal(marketDataBand("DISABLED"), "absent");
});

test("deriveMarketData surfaces per-instrument readiness and only READY is usable for entry", () => {
  const ready = deriveMarketData({
    market_data_state: "READY",
    market_data_health: {
      state: "READY", generation: 3, desired: 4, confirmed: 4, readyInstruments: 4,
      lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: 1, backlog: false,
    },
  });
  assert.equal(ready.band, "ready");
  assert.equal(ready.dataUsableForEntry, true);
  assert.equal(ready.readyInstruments, 4);
  assert.equal(ready.desiredInstruments, 4);

  const sync = deriveMarketData({
    market_data_state: "SYNCHRONIZING",
    market_data_health: {
      state: "SYNCHRONIZING", generation: 4, desired: 4, confirmed: 2, readyInstruments: 2,
      lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: null, backlog: false,
    },
  });
  assert.equal(sync.band, "paused");
  assert.equal(sync.dataUsableForEntry, false, "a synchronizing feed is not usable for entry");
  assert.equal(sync.readyInstruments, 2);
});

/* ─────────────────────────── honesty rule #1: the two signals are independent ─────────────────────────── */

test("HONESTY #1: a READY market-data feed does NOT make the order stream live", () => {
  // Order stream is not wired for either broker → REST polling only, even though MD is READY.
  const orderStream = {
    any_stream_live: false,
    market_data_health_is_not_order_stream_health: true,
    brokers: [
      { broker: "zerodha", wiring: "not_wired", gate_env_var: "ZERODHA_ORDER_STREAM_ENABLED",
        gate_enabled: false, health: null, fills_observed_by: "rest_polling_only", detail: "x" },
    ],
  };
  const os = deriveActiveOrderStream(orderStream, "zerodha");
  assert.equal(os.anyStreamLive, false, "market-data READY cannot fabricate a live order stream");
  assert.equal(os.active.streamObserved, false);
  assert.equal(os.active.mechanismLabel, "REST polling only");
  assert.equal(os.antiConflation, true, "the anti-conflation flag is carried to the UI");
});

test("HONESTY #1: a live order stream is reported independently of the feed state", () => {
  const orderStream = {
    any_stream_live: true,
    market_data_health_is_not_order_stream_health: true,
    brokers: [
      { broker: "dhan", wiring: "armed", gate_env_var: "DHAN_ORDER_STREAM_ENABLED",
        gate_enabled: true,
        health: { state: "LIVE", connected: true, authorised: true, lastEventAt: 10,
          disconnects: 0, reconcilePending: false, detail: "live" },
        fills_observed_by: "stream_primary_rest_reconcile", detail: "live" },
    ],
  };
  const os = deriveActiveOrderStream(orderStream, "dhan");
  assert.equal(os.active.streamObserved, true);
  assert.equal(orderStreamBrokerBand(orderStream.brokers[0]), "ready");
  assert.equal(os.active.mechanismLabel, "stream first, REST reconciles");
});

/* ─────────────────────────── honesty rule #2: paused-but-safe ≠ broken ─────────────────────────── */

/**
 * SECTION 7 — THESE FOUR TESTS NOW ASSERT THE BACKEND'S VERDICT, NOT A LOCAL DERIVATION.
 *
 * They previously called `deriveEntryGate(md, os)` with no backend decision, because the frontend
 * computed entry permission itself from market-data readiness plus one reconcile flag. That was
 * defect (b): a SECOND permission matrix, which missed nearly every real blocker and showed a green
 * "New entry is permitted" while the backend refused every entry.
 *
 * Every scenario below is PRESERVED exactly. What changed is where the verdict comes from: a
 * `decision` built to mirror what the backend publishes for that same situation. So each test now
 * proves the panel RENDERS the backend answer for that scenario, which is strictly more than it
 * proved before — a frontend that quietly reverted to deriving its own answer would fail here.
 */

/** A backend readiness decision, shaped exactly as `box_status.operational_readiness` arrives. */
function decisionFor({
  marketData = "READY",
  orderStream = "READY",
  entryPermitted = true,
  entryReasons = [],
  exitAndReduce = true,
  protectiveCancel = true,
  reductionReasons = [],
  reconcilePending = false,
  generation = 1,
} = {}) {
  return {
    decision_generation: generation,
    decision_version: "1.6.0",
    decided_at: 1_700_000_000_000,
    identity: {
      broker: "zerodha", account_masked: "AB••34", account_present: true,
      execution_mode: "live", live_runtime_armed: true, deployment_live_capable: true,
    },
    market_data: {
      state: marketData, generation: 3, desired_instruments: 4, ready_instruments: 4,
      backlog: false, usable_for_entry: marketData === "READY",
    },
    order_stream: {
      lifecycle: orderStream, published_state: orderStream === "READY" ? "LIVE" : "DEGRADED",
      wiring: "armed", gate_enabled: true, connected: true, authorised: true, disconnects: 0,
    },
    fill_observation: {
      mechanism: orderStream === "READY" ? "stream_primary_rest_reconcile" : "rest_polling_only",
      stream_assisted: orderStream === "READY",
      detail: "mechanism detail",
    },
    evidence: {
      market_data_frame_age_ms: 100, market_data_heartbeat_age_ms: 100,
      market_data_depth_age_ms: 150, order_stream_event_age_ms: 900,
    },
    reconciliation: { pending: reconcilePending, blockers: [] },
    entry: { permitted: entryPermitted, reasons: entryReasons },
    exposure_management: {
      exit_and_reduce: exitAndReduce,
      protective_cancel: protectiveCancel,
      manage_working_orders: true,
      blocked_reasons: reductionReasons,
      limitations: ["A reduction is itself an order into the market: permission is not a fill."],
      open_positions: 1, residual_legs: 0, working_orders: 0,
    },
  };
}

test("HONESTY #2: a reconnecting/degraded feed is PAUSED with positions still manageable", () => {
  for (const state of ["CONNECTING", "AUTHENTICATING", "SYNCHRONIZING", "DEGRADED"]) {
    const md = deriveMarketData({
      market_data_state: state,
      market_data_health: {
        state, generation: 2, desired: 4, confirmed: 1, readyInstruments: 1,
        lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: null, backlog: false,
      },
    });
    // The backend refuses entry for this transport state, and keeps exposure manageable.
    const decision = decisionFor({
      marketData: state,
      entryPermitted: false,
      entryReasons: [{ code: "market_data_lifecycle", scope: "entry", detail: `market data is ${state}` }],
      exitAndReduce: true,
    });
    const gate = deriveEntryGate(md, null, decision);
    assert.equal(gate.entryPermitted, false, `${state}: entry must be paused`);
    assert.equal(gate.overallBand, "paused", `${state}: band is paused, not broken`);
    assert.equal(gate.positionsManageable, true, `${state}: positions remain manageable`);
    assert.ok(gate.entryPausedReasons.length > 0, `${state}: a reason is given`);
  }
});

test("HONESTY #2: a disconnected feed is BROKEN, and an expired session is broken + unmanageable", () => {
  const disc = deriveEntryGate(
    deriveMarketData({
      market_data_state: "DISCONNECTED",
      market_data_health: { state: "DISCONNECTED", generation: 2, desired: 4, confirmed: 0,
        readyInstruments: 0, lastHeartbeatAt: null, lastFrameAt: null, lastDepthAt: null, backlog: false },
    }),
    null,
    // A disconnected feed cannot price a reduction, but a protective cancel still reduces exposure.
    decisionFor({
      marketData: "DISCONNECTED", entryPermitted: false,
      entryReasons: [{ code: "market_data_disconnected", scope: "entry", detail: "the socket is closed" }],
      exitAndReduce: false, protectiveCancel: true,
      reductionReasons: [{ code: "market_data_disconnected", scope: "reduction", detail: "no current book to price against" }],
    }),
  );
  assert.equal(disc.overallBand, "broken");
  assert.equal(disc.entryPermitted, false);
  assert.equal(disc.protectiveCancelPermitted, true, "disconnected still permits a protective cancel");

  const expired = deriveEntryGate(
    deriveMarketData({
      market_data_state: "AUTH_EXPIRED",
      market_data_health: { state: "AUTH_EXPIRED", generation: 2, desired: 4, confirmed: 0,
        readyInstruments: 0, lastHeartbeatAt: null, lastFrameAt: null, lastDepthAt: null, backlog: false },
    }),
    null,
    decisionFor({
      marketData: "AUTH_EXPIRED", entryPermitted: false,
      entryReasons: [{ code: "market_data_session_expired", scope: "both", detail: "the session expired" }],
      exitAndReduce: false, protectiveCancel: false,
      reductionReasons: [{ code: "market_data_session_expired", scope: "reduction", detail: "the broker will refuse a priced reduction" }],
    }),
  );
  assert.equal(expired.overallBand, "broken");
  assert.equal(expired.positionsManageable, false, "an expired session is not freely manageable");
  assert.ok(expired.reductionBlockedReasons.length > 0, "and the reduction blocker is stated");
});

test("HONESTY #2: a reconnected order stream owing reconciliation pauses entry with a clear reason", () => {
  const md = deriveMarketData({
    market_data_state: "READY",
    market_data_health: { state: "READY", generation: 3, desired: 4, confirmed: 4, readyInstruments: 4,
      lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: 1, backlog: false },
  });
  const osBroker = {
    broker: "zerodha", wiring: "armed", gate_env_var: "ZERODHA_ORDER_STREAM_ENABLED", gate_enabled: true,
    health: { state: "RECONNECTED_PENDING_RECONCILE", connected: true, authorised: true, lastEventAt: 5,
      disconnects: 1, reconcilePending: true, detail: "reconnected", lifecycle: "RECONCILING" },
    lifecycle: "RECONCILING",
    fills_observed_by: "rest_polling_only", detail: "reconnected, reconciliation owed",
  };
  const os = deriveActiveOrderStream(
    { any_stream_live: false, market_data_health_is_not_order_stream_health: true, brokers: [osBroker] },
    "zerodha",
  );
  const gate = deriveEntryGate(
    md,
    os.active,
    decisionFor({
      orderStream: "RECONCILING", reconcilePending: true, entryPermitted: false,
      entryReasons: [{
        code: "order_stream_lifecycle", scope: "entry",
        detail: "the order-update stream connected and a REST reconciliation is owed",
      }],
      exitAndReduce: true,
    }),
  );
  assert.equal(gate.entryPermitted, false, "READY feed but reconciliation owed → entry still paused");
  assert.equal(gate.overallBand, "paused");
  assert.ok(
    gate.entryPausedReasons.some((r) => /reconcil/i.test(r)),
    "the reason names the owed reconciliation",
  );
  assert.equal(gate.positionsManageable, true);
});

test("entry is permitted ONLY when the BACKEND says so — a READY feed is not sufficient on its own", () => {
  const md = deriveMarketData({
    market_data_state: "READY",
    market_data_health: { state: "READY", generation: 3, desired: 4, confirmed: 4, readyInstruments: 4,
      lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: 1, backlog: false },
  });

  // The backend permits it: the panel shows green.
  const permitted = deriveEntryGate(md, null, decisionFor({ entryPermitted: true }));
  assert.equal(permitted.entryPermitted, true);
  assert.deepEqual(permitted.entryPausedReasons, []);
  assert.equal(permitted.overallBand, "ready");

  // THE DEFECT, INVERTED: identical READY market data, but the backend refuses (PostgreSQL is the
  // authoritative store and it is unavailable). Pre-fix this rendered green because the frontend
  // never consulted the backend at all.
  const refused = deriveEntryGate(
    md,
    null,
    decisionFor({
      entryPermitted: false,
      entryReasons: [{ code: "postgres_unavailable", scope: "entry", detail: "PostgreSQL is unavailable" }],
    }),
  );
  assert.equal(refused.entryPermitted, false, "a READY feed cannot override the backend's refusal");
  assert.equal(refused.overallBand, "paused");
  assert.deepEqual(refused.entryPausedReasons, ["PostgreSQL is unavailable"]);
});

/* ─────────────────────────── gross notional ≠ margin ─────────────────────────── */

test("deriveEconomicFigures keeps gross notional and planned margin as DISTINCT labelled quantities", () => {
  const admission = {
    allowed: true,
    reasons: [],
    detail: null,
    controls: { gross_cap_enabled: true, funds_check_enabled: true, margin_evidence_required: false },
    picture: {
      available_funds: { value_rupees: 500000, provenance: "broker_confirmed", observed_at: 1, age_ms: 10, usable: true, note: "funds" },
      planned_margin: { value_rupees: 42000, provenance: "broker_confirmed", observed_at: 1, age_ms: 10, usable: true, note: "netted margin" },
      peak_legging_exposure: { value_rupees: 210000, provenance: "estimate", observed_at: 1, age_ms: 10, usable: false, note: "peak" },
      gross_notional: { value_rupees: 210000, provenance: "estimate", observed_at: 1, age_ms: 10, usable: false, note: "gross" },
      worst_case_entry: { value_rupees: 215000, provenance: "estimate", observed_at: 1, age_ms: 10, usable: false, note: "worst" },
    },
  };
  const figs = deriveEconomicFigures(admission);
  const byKey = Object.fromEntries(figs.map((f) => [f.key, f]));
  assert.equal(byKey.gross_notional.label, "Gross notional");
  assert.equal(byKey.planned_margin.label, "Planned margin (netted)");
  assert.notEqual(byKey.gross_notional.value, byKey.planned_margin.value, "gross notional and margin are different numbers");
  assert.equal(byKey.planned_margin.value, "₹42,000");
  assert.equal(byKey.gross_notional.value, "₹2,10,000");
  // A margin-confirmed figure is usable; an estimated gross-notional is shown but not authority.
  assert.equal(byKey.planned_margin.usable, true);
  assert.equal(byKey.gross_notional.usable, false);
});

/* ─────────────────────────── funnel honesty ─────────────────────────── */

test("formatRatio reports an undefined ratio as null-basis, never 0% or 100%", () => {
  assert.equal(formatRatio({ rate: null, numerator: 0, denominator: 0 }), "— (0/0)");
  assert.equal(formatRatio({ rate: 0.5, numerator: 1, denominator: 2 }), "50% (1/2)");
});

test("deriveFunnel exposes the nested chain, both ratio kinds, and never hides exposure/recovery", () => {
  const snap = {
    candidates_evaluated: 100, qualified_opportunities: 20, attempts_admitted: 10,
    attempts_submitted: 6, four_leg_completed_entries: 4,
    zero_post_refusals: 4, zero_post_by_reason: {}, submitted_failures: 2, submitted_failures_by_reason: {},
    no_fill_cancellations: 1, partial_entry_recoveries: 1, unresolved_exposure_open: 1,
    unresolved_exposure_total: 3, completed_exits: 2, realised_net_pnl: -1500,
    recovery_costs_included: 900, economically_profitable: 2, economically_unprofitable: 2,
    ratios: {
      admission_rate: { numerator: 10, denominator: 20, rate: 0.5, basis: "admitted / qualified" },
      submission_rate: { numerator: 6, denominator: 10, rate: 0.6, basis: "submitted / admitted" },
      execution_completion_rate: { numerator: 4, denominator: 6, rate: 0.6667, basis: "completed / submitted" },
      economic_success_rate: { numerator: 2, denominator: 4, rate: 0.5, basis: "profitable / completed" },
      unresolved_exposure_rate: { numerator: 3, denominator: 10, rate: 0.3, basis: "unresolved / admitted" },
    },
  };
  const v = deriveFunnel(snap);
  assert.equal(v.chain.length, 5);
  assert.equal(v.chain[0].count, 100);
  assert.equal(v.chain[4].count, 4);
  // Economic success is a SEPARATE ratio kind from execution completion.
  const econ = v.ratios.find((r) => r.kind === "economic");
  assert.ok(econ && /economic/i.test(econ.label));
  const exec = v.ratios.filter((r) => r.kind === "execution");
  assert.equal(exec.length, 4);
  // Exposure and recovery are surfaced, not hidden.
  assert.equal(v.exposure.unresolvedOpen, 1);
  assert.equal(v.exposure.zeroPostRefusals, 4);
  assert.equal(v.exposure.recoveryCostsIncluded, "₹900");
  assert.equal(v.exposure.realisedNetPnl, "−₹1,500", "a loss renders with a real minus sign, not hidden");
});

/* ─────────────────────────── colour-not-alone + fixture exercise ─────────────────────────── */

test("every band has a distinct text glyph so signalling is never colour-alone", () => {
  const glyphs = ["ready", "paused", "broken", "absent"].map(bandGlyph);
  assert.equal(new Set(glyphs).size, 4, "each band has a unique glyph");
  assert.equal(bandClass("ready"), "is-good");
  assert.equal(bandClass("paused"), "is-warn");
  assert.equal(bandClass("broken"), "is-bad");
});

test("the derivations run on the retained box-status fixture (stopped/paper baseline)", () => {
  /*
   * THE FIXTURE CHANGED, AND THAT IS THE POINT.
   *
   * It used to assert `state === "DISABLED"` and `band === "absent"` for a `paper_latency`
   * deployment — because that is genuinely what the backend published, and it was the defect: market
   * data was armed only when `executionMode === "live"`, so every paper deployment reported a
   * DISABLED market-data lifecycle, generation 0 and no depth evidence however many ticks arrived.
   *
   * A paper deployment consuming the real broker quote feed is now READY, so the fixture and these
   * assertions move with it. The `absent` band is retained below for the ORDER STREAM, where it is
   * still correct: paper sends no order, so there is genuinely no broker stream.
   */
  const r = fixture.operational_readiness;

  // NOT "DISABLED". A paper deployment monitors the real quote feed, so with the exchange shut and
  // no socket the honest state is DISCONNECTED — a transport fact — rather than "not armed".
  const md = deriveMarketData(fixture);
  assert.equal(md.state, "DISCONNECTED");
  assert.equal(md.dataUsableForEntry, false, "and it is still NOT usable for entry");

  // THE RED EXPOSURE WARNING, pinned. `market_data_not_configured` carries scope `both`, so while
  // the machine was DISABLED in paper it blocked REDUCTION too and even protective cancel was
  // reported as refused — purely because live readiness was off.
  assert.ok(
    !r.entry.reasons.some((x) => x.code === "market_data_not_configured"),
    "market data IS configured in paper; that blocker must never appear again",
  );
  assert.equal(
    r.exposure_management.protective_cancel,
    true,
    "a protective cancel always reduces exposure and must not be refused in paper",
  );
  assert.equal(r.exposure_management.manage_working_orders, true);
  // exit_and_reduce stays false here, and that is the CORRECT preserved policy: with no socket there
  // is no book to price a reduction against. The reason given is the honest one.
  assert.equal(r.exposure_management.exit_and_reduce, false);
  assert.deepEqual(
    r.exposure_management.blocked_reasons.map((x) => x.code),
    ["market_data_disconnected"],
    "blocked for want of a BOOK, not because market data is unconfigured",
  );

  const os = deriveActiveOrderStream(fixture.order_stream, fixture.broker);
  assert.equal(os.anyStreamLive, false, "no broker order stream is live — nor should one be");
  assert.equal(os.active.streamObserved, false);
  // PAPER: absent (inactive by design), NOT paused or broken.
  assert.equal(os.active.band, "absent");
  assert.equal(os.active.wiringLabel, "not applicable (paper)");
  assert.equal(
    os.active.mechanismLabel,
    "Simulated fills",
    "a broker cannot confirm an order it never received — this must not say REST polling",
  );

  // The paper mechanism is published separately from the order stream — and because this baseline has
  // NO tick evidence, the "real broker WebSocket quotes" claim must be WITHHELD.
  assert.equal(r.paper_execution.simulated, true);
  assert.equal(r.paper_execution.profile, "paper_latency");
  assert.equal(r.paper_execution.using_streamed_quotes, false);
  assert.doesNotMatch(
    r.paper_execution.detail,
    /Real broker WebSocket quotes/,
    "no ticks observed ⇒ the streamed-quotes claim must not be made",
  );
  assert.equal(r.market_data.ticks_observed, false);
  assert.equal(r.market_data.source, "none");
  assert.equal(r.fill_observation.mechanism, "simulated_paper_fills");
  assert.doesNotMatch(
    r.fill_observation.detail,
    /REST polling is observing fills/,
    "nothing is polled for an order that is never sent",
  );

  // NEVER OBSERVED stays null — it must never render as a fresh 0 — and the clock domain is
  // published so a reader can verify the ages were not computed across mixed clocks.
  assert.equal(r.evidence.market_data_depth_age_ms, null);
  assert.equal(r.evidence.market_data_frame_age_ms, null);
  assert.equal(r.evidence.market_data_last_frame_at, null);
  assert.equal(r.evidence.market_data_age_clock, "monotonic");

  const funnel = deriveFunnel(fixture.execution_funnel);
  assert.equal(funnel.chain[0].count, 0);
  // economic_admission is null in the paper baseline — the component must not fabricate figures.
  assert.equal(fixture.economic_admission, null);
});
