/**
 * THE SCANNER PIPELINE, AS THE UI MUST RENDER IT.
 *
 * THE DEFECT
 *
 * The backend's `ActiveBrokerManager.instruments()` returned `[]` for Zerodha, so the board, the
 * option chains, the ATM windows, the candidates and the desired subscriptions were all empty — and
 * the box-lane socket was never constructed, because it is created lazily on the first subscription.
 *
 * The UI had exactly two facts to render: `running` and `underlyings`. So a scanner that could not
 * possibly find anything displayed `SCANNING` above a `0`, indistinguishable from a scanner watching
 * a quiet market. These tests pin the properties that make that impossible to repeat, on the same
 * pure derivations the component renders.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  bandClass,
  deriveUniverse,
  scannerHeadline,
  universeBand,
  universeStageLabel,
} from "../src/lib/operationalState.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/box-status.json", import.meta.url), "utf8"),
);

/** A universe payload, defaulting to the fully healthy `evaluating` state. */
function universe(over = {}) {
  return {
    readyToEvaluate: true,
    stage: "evaluating",
    detail: "Evaluating 42 candidate(s) across 2 underlying(s) against 44 usable book(s).",
    transient: false,
    counts: {
      instruments: 92_000,
      board_rows: 2,
      chains_indexed: 2,
      board_with_chains: 2,
      underlyings_missing_spot: 0,
      windows_built: 2,
      candidates: 42,
      desired_option_subscriptions: 30,
      frames_observed: 5_000,
      depth_observations: 4_800,
      usable_books: 44,
    },
    instrument_load: "loaded",
    instruments_error: null,
    instruments_loaded_at: 1_774_000_000_000,
    instrument_load_failures: 0,
    spot_seed_failed: false,
    spot_seed_error: null,
    last_successful_build_at: 1_774_000_000_000,
    subscriptions_requested: true,
    box_socket_connected: true,
    ...over,
  };
}

/* ═════════ 1. RUNNING IS NOT SCANNING ═════════ */

test("a RUNNING scanner with an empty universe is NOT rendered as SCANNING", () => {
  /*
   * THE HEADLINE DEFECT. `running === true` used to be the whole basis for "SCANNING". The
   * instrument master here loaded SUCCESSFULLY and returned zero rows — which is precisely the shape
   * of the original bug, and precisely why it was invisible.
   */
  const empty = universe({
    readyToEvaluate: false,
    stage: "instruments_empty",
    transient: false,
    counts: { ...universe().counts, instruments: 0, board_rows: 0, chains_indexed: 0, board_with_chains: 0, windows_built: 0, candidates: 0, desired_option_subscriptions: 0, frames_observed: 0, depth_observations: 0, usable_books: 0 },
  });

  const headline = scannerHeadline(true, empty);
  assert.notEqual(headline.text, "SCANNING", "a scanner that cannot evaluate must not claim to be scanning");
  assert.match(headline.text, /STARTING/);
  assert.match(headline.text, /instrument master EMPTY/, "and it must NAME the stage that stopped");
  assert.equal(headline.band, "broken", "a successful load returning zero rows needs investigation");
  assert.equal(bandClass(headline.band), "is-bad");
});

test("a genuinely healthy scanner IS rendered as SCANNING", () => {
  const headline = scannerHeadline(true, universe());
  assert.equal(headline.text, "SCANNING");
  assert.equal(headline.band, "ready");
});

test("a stopped scanner is STOPPED, and that is not a fault", () => {
  const headline = scannerHeadline(false, universe({ readyToEvaluate: false, stage: "scanner_stopped" }));
  assert.equal(headline.text, "STOPPED");
  assert.equal(headline.band, "absent", "stopped is a choice, not a fault");
});

/* ═════════ 2. WAIT vs INVESTIGATE ═════════ */

test("transient stages are `paused` (wait); real faults are `broken` (investigate)", () => {
  // The backend decides which is which; the UI must not invent a second opinion.
  for (const stage of [
    "instruments_loading",
    "awaiting_spot_prices",
    "awaiting_first_tick",
    "awaiting_usable_depth",
    "box_socket_disconnected",
  ]) {
    const b = universeBand(universe({ readyToEvaluate: false, stage, transient: true }));
    assert.equal(b, "paused", `${stage} should be paused/wait`);
  }
  for (const stage of [
    "instruments_failed",
    "instruments_empty",
    "no_board_rows",
    "no_option_chains",
    "no_board_chain_overlap",
    "no_candidates",
    "no_desired_subscriptions",
  ]) {
    const b = universeBand(universe({ readyToEvaluate: false, stage, transient: false }));
    assert.equal(b, "broken", `${stage} should be broken/investigate`);
  }
});

test("every stage has a distinct, non-empty label", () => {
  const stages = [
    "scanner_stopped", "not_authenticated", "instruments_never_loaded", "instruments_loading",
    "instruments_failed", "instruments_empty", "no_board_rows", "no_option_chains",
    "no_board_chain_overlap", "awaiting_spot_prices", "no_windows_built", "no_candidates",
    "no_desired_subscriptions", "box_socket_disconnected", "awaiting_first_tick",
    "awaiting_usable_depth", "evaluating",
  ];
  const labels = stages.map(universeStageLabel);
  for (const [i, l] of labels.entries()) {
    assert.equal(typeof l, "string");
    assert.ok(l.length > 0, `${stages[i]} needs a label`);
  }
  assert.equal(new Set(labels).size, labels.length, "labels must be distinguishable from each other");
});

/* ═════════ 3. THE BACKEND'S REASON, VERBATIM ═════════ */

test("the derived view carries the backend's own sentence and errors, unrewritten", () => {
  const v = deriveUniverse(
    universe({
      readyToEvaluate: false,
      stage: "instruments_failed",
      transient: false,
      detail: "The instrument master could not be loaded after 3 attempt(s). Broker error: HTTP 503",
      instrument_load: "failed",
      instruments_error: "HTTP 503 from the instruments endpoint",
      instrument_load_failures: 3,
    }),
  );
  assert.equal(v.detail, "The instrument master could not be loaded after 3 attempt(s). Broker error: HTTP 503");
  assert.equal(v.instrumentsError, "HTTP 503 from the instruments endpoint");
  assert.equal(v.instrumentLoad, "failed");
  assert.equal(v.band, "broken");
  assert.equal(v.readyToEvaluate, false);
});

test("a failed SPOT seed surfaces its real reason rather than looking like an empty universe", () => {
  const v = deriveUniverse(
    universe({
      readyToEvaluate: false,
      stage: "awaiting_spot_prices",
      transient: true,
      spot_seed_failed: true,
      spot_seed_error: "HTTP 500 from the quote endpoint",
      counts: { ...universe().counts, windows_built: 0, candidates: 0, underlyings_missing_spot: 2 },
    }),
  );
  // The universe itself is fine — the counts prove it — so this must not read as a broken universe.
  assert.equal(v.counts.board_with_chains, 2, "the universe loaded correctly");
  assert.equal(v.counts.windows_built, 0, "but nothing could be centred");
  assert.equal(v.spotSeedError, "HTTP 500 from the quote endpoint");
  assert.equal(v.band, "paused", "a spot seed failure is recoverable — the next pass retries");
});

/* ═════════ 4. REQUESTED ≠ ACKNOWLEDGED ═════════ */

test("a written subscribe frame is never presented as a broker acknowledgement", () => {
  const v = deriveUniverse(
    universe({
      readyToEvaluate: false,
      stage: "awaiting_first_tick",
      transient: true,
      subscriptions_requested: true,
      counts: { ...universe().counts, frames_observed: 0, depth_observations: 0, usable_books: 0 },
    }),
  );
  // The field is named Requested, and the confirmation is tracked entirely separately.
  assert.equal(v.subscriptionsRequested, true, "a frame was WRITTEN");
  assert.equal(v.counts.depth_observations, 0, "and nothing has confirmed it");
  assert.equal(v.readyToEvaluate, false, "so the scanner is not ready");
  assert.ok(
    !Object.keys(v).some((k) => /confirmed/i.test(k)),
    "the view must not expose anything called `confirmed` for a protocol that acknowledges nothing",
  );
});

test("frames without depth is its own reported state", () => {
  const v = deriveUniverse(
    universe({
      readyToEvaluate: false,
      stage: "awaiting_usable_depth",
      transient: true,
      counts: { ...universe().counts, frames_observed: 900, depth_observations: 0, usable_books: 0 },
    }),
  );
  assert.ok(v.counts.frames_observed > 0, "the socket is alive");
  assert.equal(v.counts.usable_books, 0, "and delivering nothing executable");
  assert.equal(v.readyToEvaluate, false);
  assert.equal(v.band, "paused");
});

/* ═════════ 5. THE FIXTURE ═════════ */

test("the retained fixture carries the universe block and the two lane facts", () => {
  assert.ok(fixture.universe, "the fixture must exercise the new block");
  const v = deriveUniverse(fixture.universe);
  // The fixture is the stopped closed-market paper baseline.
  assert.equal(fixture.universe.stage, "scanner_stopped");
  assert.equal(v.band, "absent", "stopped is not a fault");
  assert.equal(scannerHeadline(fixture.running, fixture.universe).text, "STOPPED");

  // THE LANE SEPARATION. A connected shared board lane is a different socket.
  assert.equal(typeof fixture.box_lane_connected, "boolean");
  assert.equal(fixture.box_lane_dedicated, true, "the box lane is physically separate by default");
  assert.notEqual(
    "hub_connected" in fixture ? undefined : "missing",
    "missing",
    "the shared lane is still published, but it is no longer the only lane fact",
  );
});

test("market_data_health publishes AGES and wall stamps, not the removed raw timestamps", () => {
  /*
   * THE REGRESSION GUARD for a bug this change fixed in passing: the frontend type still declared
   * `lastHeartbeatAt`/`lastFrameAt`/`lastDepthAt` long after the backend stopped emitting them (ages
   * are now computed inside the monotonic domain that stamps them, and the raw monotonic timestamps
   * are deliberately not exported). Because this payload leaf is an OPEN schema node and the type was
   * hand-written, TypeScript could not object — three stats simply rendered "never observed" on a
   * perfectly healthy feed.
   */
  const h = fixture.market_data_health;
  for (const removed of ["lastHeartbeatAt", "lastFrameAt", "lastDepthAt"]) {
    assert.ok(!(removed in h), `${removed} must not reappear — it is a mixed-clock-domain hazard`);
  }
  for (const present of [
    "heartbeatAgeMs", "frameAgeMs", "depthAgeMs",
    "lastHeartbeatWallAt", "lastFrameWallAt", "lastDepthWallAt",
    "frames", "depthObservations", "transportLive", "bookMaxAgeMs", "heartbeatMaxAgeMs",
  ]) {
    assert.ok(present in h, `${present} must be published`);
  }
  // NEVER OBSERVED stays null in this stopped baseline, and must never become a fresh 0.
  assert.equal(h.depthAgeMs, null);
  assert.equal(h.lastDepthWallAt, null);
  // The enforced bounds are stated rather than assumed by the UI.
  assert.equal(typeof h.bookMaxAgeMs, "number");
  assert.ok(h.bookMaxAgeMs > 0);
});
