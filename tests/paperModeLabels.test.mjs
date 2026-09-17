/**
 * PAPER-MODE LABELLING AND REFUSAL REASONS — the two frontend honesty defects.
 *
 * Exercised on the SAME pure derivation functions the components render, so these are behavioural
 * assertions rather than source greps.
 *
 * DEFECT 1 — PAPER RENDERED AS BROKEN.
 * The backend previously reported a paper deployment's order stream as `not_wired` +
 * `rest_polling_only`, because a paper process builds no order-stream consumer BY DESIGN and the
 * status module read that absence as "should be running and is not". The frontend faithfully painted
 * that as a fault: `severity()` fell through to `is-bad`, `orderStreamBrokerBand` fell through to
 * `paused`, and the mechanism read "REST polling only" — claiming a broker round trip for orders
 * that are never sent anywhere. The contract now carries `not_applicable_paper` and
 * `simulated_paper_fills`, and these tests pin how they must render.
 *
 * DEFECT 2 — A REFUSED PROTECTIVE CANCELLATION DESCRIBED AS AN EXPIRED SESSION.
 * `BoxOperationalState` asserted "the broker itself will reject it on an expired session" for ANY
 * refused protective cancellation — a diagnosis invented from one false boolean. `protective_cancel:
 * false` does not mean the token expired: the published verdict is the combined permission table
 * PLUS reduction-scoped external blockers, so a PostgreSQL outage, a reservation fault or a recovery
 * hold all land there. Telling an operator to re-authenticate while the real cause is untouched is
 * the wrong action, taken under time pressure with open exposure.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deriveEntryGate,
  deriveOrderStreamBroker,
  mechanismLabel,
  orderStreamBrokerBand,
} from "../src/lib/operationalState.ts";

/** A published order-stream entry for one broker. */
function broker(over = {}) {
  return {
    broker: "zerodha",
    wiring: "armed",
    gate_env_var: "ZERODHA_ORDER_STREAM_ENABLED",
    gate_enabled: true,
    health: null,
    lifecycle: null,
    fills_observed_by: "rest_polling_only",
    detail: "",
    ...over,
  };
}

/** A readiness decision, defaulting to a healthy paper deployment. */
function decision(over = {}) {
  return {
    entry: { permitted: false, reasons: [] },
    exposure_management: {
      exit_and_reduce: true,
      protective_cancel: true,
      manage_working_orders: true,
      blocked_reasons: [],
      limitations: ["a limitation"],
      open_positions: 0,
      residual_legs: 0,
      working_orders: 0,
    },
    ...over,
  };
}

/* ═════════════ 1. PAPER IS INACTIVE, NOT BROKEN ═════════════ */

test("simulated paper fills are labelled 'Simulated fills', never 'REST polling only'", () => {
  assert.equal(mechanismLabel("simulated_paper_fills"), "Simulated fills");
  // The other two are unchanged, so a genuine live stream and a genuine REST fallback still read
  // exactly as before.
  assert.equal(mechanismLabel("stream_primary_rest_reconcile"), "stream first, REST reconciles");
  assert.equal(mechanismLabel("rest_polling_only"), "REST polling only");
});

test("a paper order stream is the ABSENT band — not paused, and certainly not broken", () => {
  const paper = broker({
    wiring: "not_applicable_paper",
    gate_enabled: false,
    fills_observed_by: "simulated_paper_fills",
  });
  assert.equal(
    orderStreamBrokerBand(paper),
    "absent",
    "there is nothing to be paused: no order is sent, so the broker has nothing to stream",
  );

  const view = deriveOrderStreamBroker(paper);
  assert.equal(view.wiringLabel, "not applicable (paper)");
  assert.equal(view.mechanismLabel, "Simulated fills");
  assert.equal(view.streamObserved, false);
  assert.equal(view.band, "absent");
});

test("the genuinely broken and genuinely absent order-stream states are UNCHANGED", () => {
  // The paper relabelling must not soften any real fault. These are the regression guards.
  assert.equal(
    orderStreamBrokerBand(broker({ wiring: "not_wired" })),
    "paused",
    "an implemented-but-unconsumed stream in a LIVE deployment is still a real operational state",
  );
  assert.equal(
    orderStreamBrokerBand(broker({ wiring: "armed", lifecycle: "AUTH_EXPIRED" })),
    "broken",
    "an expired session behind an armed stream is still BROKEN",
  );
  assert.equal(orderStreamBrokerBand(broker({ wiring: "gated_off" })), "absent");
  assert.equal(orderStreamBrokerBand(broker({ wiring: "not_built" })), "absent");
  assert.equal(
    orderStreamBrokerBand(
      broker({ wiring: "armed", fills_observed_by: "stream_primary_rest_reconcile" }),
    ),
    "ready",
    "a genuinely live stream is still READY",
  );
});

test("a live stream is never mislabelled as simulated", () => {
  // The paper branch is scored AFTER the stream-observed branch, so a real consumer always wins.
  const live = broker({
    wiring: "armed",
    lifecycle: "READY",
    fills_observed_by: "stream_primary_rest_reconcile",
  });
  assert.equal(deriveOrderStreamBroker(live).mechanismLabel, "stream first, REST reconciles");
  assert.equal(deriveOrderStreamBroker(live).band, "ready");
});

/* ═════════════ 2. THE REFUSAL REASON IS THE BACKEND'S ═════════════ */

test("a refused protective cancellation carries the BACKEND's reason, not an invented expiry", () => {
  const gate = deriveEntryGate(
    null,
    null,
    decision({
      exposure_management: {
        ...decision().exposure_management,
        exit_and_reduce: false,
        protective_cancel: false,
        blocked_reasons: [
          {
            code: "postgres_unavailable",
            scope: "reduction",
            detail:
              "The authoritative store is unavailable, so a reduction cannot be recorded durably.",
          },
        ],
      },
    }),
  );

  assert.equal(gate.protectiveCancelPermitted, false);
  assert.equal(gate.positionsManageable, false);
  // The backend's own sentence, verbatim — this is what the component renders.
  assert.deepEqual(gate.reductionBlockedReasons, [
    "The authoritative store is unavailable, so a reduction cannot be recorded durably.",
  ]);
  // And nothing in the derived gate invents a session/token diagnosis.
  const joined = gate.reductionBlockedReasons.join(" ");
  assert.doesNotMatch(joined, /expired/i, "the real cause here is a database, not a credential");
  assert.doesNotMatch(joined, /sign in|token/i);
});

test("a genuinely expired session still says so — because the BACKEND says so", () => {
  // The counterweight: removing the inference must not remove the truth when it IS the truth.
  const gate = deriveEntryGate(
    null,
    null,
    decision({
      exposure_management: {
        ...decision().exposure_management,
        exit_and_reduce: false,
        protective_cancel: false,
        blocked_reasons: [
          {
            code: "market_data_session_expired",
            scope: "both",
            detail:
              "The market-data session or token was rejected or expired. The broker will refuse " +
              "everything but a cancel, so a priced reduction cannot be relied on until it is renewed.",
          },
        ],
      },
    }),
  );
  assert.match(gate.reductionBlockedReasons.join(" "), /rejected or expired/);
});

test("the component no longer hardcodes an expiry diagnosis for a refused cancel", () => {
  /*
   * A complement to the behavioural tests above, not a substitute for them: the defect was a literal
   * sentence in JSX, and the pure derivation cannot observe that the component stopped printing it.
   * Comments are stripped before matching so the explanation of the defect does not count as the
   * defect.
   */
  const src = readFileSync(new URL("../src/BoxOperationalState.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    src,
    /because the broker itself will reject it on an[\s\S]{0,40}expired session/,
    "the invented expiry diagnosis must be gone from the rendered text",
  );
  assert.match(
    src,
    /gate\.reductionBlockedReasons/,
    "and the rendered text must be driven by the backend's published reasons",
  );
});
