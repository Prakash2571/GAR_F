/**
 * RESTART-AWARE READINESS ORDERING (contract v1.7.0) — the frontend half.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `acceptDecision` accepted a readiness decision only when its `decision_generation` was strictly
 * greater than the one already rendered. Correct for ordering the concurrent responses of ONE backend
 * process — which is what it was written for — and wrong across a restart, because the backend mints
 * that counter with `++this.readinessDecisionGeneration` on a field declared `= 0`:
 *
 *     browser has rendered generation 5000
 *     backend restarts; the counter resets; it publishes generation 1
 *     5000 > 1  ⇒  the browser rejects 1, and 2, and 3, … indefinitely
 *
 * The dashboard went on rendering a permission verdict from a process that no longer existed — and
 * kept showing "entry permitted" long after the new process had decided otherwise. Only a manual
 * reload cleared it, and an operator had no reason to suspect they needed one.
 *
 * THE FIX IS NOT "ACCEPT SMALLER GENERATIONS": that would let a delayed in-flight response from the
 * OLD process overwrite the new one. Decisions are ordered by (instance.boot_ordinal,
 * decision_generation), where boot_ordinal is a restart-durable integer minted atomically by the
 * backend's PostgreSQL.
 *
 * This suite drives `src/lib/readinessOrder.ts` — the module the component calls — and the vendored
 * schema, so the contract and the behaviour are pinned together.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  orderReadinessDecision,
  readinessOrderOf,
  verdictApplies,
  verdictDisablesEntry,
  ReadinessOrderTracker,
} from "../src/lib/readinessOrder.ts";

const A = "instance-aaaa";
const B = "instance-bbbb";

const at = (instanceId, bootOrdinal, decisionGeneration) => ({ instanceId, bootOrdinal, decisionGeneration });
const NOTHING = at(null, null, null);

/** A status payload shaped like the real one. */
const statusWith = (instanceId, bootOrdinal, gen) => ({
  operational_readiness: {
    decision_generation: gen,
    instance: { instance_id: instanceId, boot_ordinal: bootOrdinal, started_at: 1_699_000_000_000 },
  },
});

/* ═══════════════ 1. the headline case ═══════════════ */

test("sequence 5000 then a legitimate new boot at sequence 1: the new instance is ADOPTED", () => {
  const v = orderReadinessDecision(at(A, 7, 5000), at(B, 8, 1));
  assert.equal(v.kind, "adopt_new_instance");
  assert.equal(verdictApplies(v.kind), true, "and it is APPLIED to the screen");
  assert.match(v.reason, /backend has restarted/);
});

test("REPRODUCTION: the OLD strictly-increasing rule rejects that decision forever", () => {
  const oldRule = (current, incoming) => incoming > current;
  assert.equal(oldRule(5000, 1), false);
  assert.equal(oldRule(5000, 2), false);
  assert.equal(oldRule(5000, 3), false, "and every decision thereafter, indefinitely");
  assert.equal(orderReadinessDecision(at(A, 7, 5000), at(B, 8, 1)).kind, "adopt_new_instance");
});

test("no manual refresh is needed: the tracker rebases onto the new instance and keeps accepting", () => {
  const tracker = new ReadinessOrderTracker();
  tracker.offer(at(A, 7, 4999));
  tracker.offer(at(A, 7, 5000));
  assert.equal(tracker.rendered().decisionGeneration, 5000);

  // The restart.
  assert.equal(tracker.offer(at(B, 8, 1)).kind, "adopt_new_instance");
  assert.equal(tracker.rendered().instanceId, B, "the baseline is REBASED wholesale");
  assert.equal(tracker.rendered().bootOrdinal, 8);
  assert.equal(tracker.rendered().decisionGeneration, 1);

  // And the new instance's subsequent decisions keep flowing — the point of the fix.
  assert.equal(tracker.offer(at(B, 8, 2)).kind, "accept");
  assert.equal(tracker.offer(at(B, 8, 3)).kind, "accept");
  assert.equal(tracker.rendered().decisionGeneration, 3);
});

test("the fix does NOT accept every smaller generation", () => {
  const v = orderReadinessDecision(at(A, 7, 5000), at(A, 7, 4999));
  assert.equal(v.kind, "reject_stale");
  assert.equal(verdictApplies(v.kind), false);
});

/* ═══════════════ 2. delayed old-boot response after adoption ═══════════════ */

test("a delayed response from the SUPERSEDED instance is rejected after the new one is adopted", () => {
  const tracker = new ReadinessOrderTracker();
  tracker.offer(at(A, 7, 5000));
  tracker.offer(at(B, 8, 1));

  // A slow in-flight response from A lands, with a far HIGHER generation.
  const v = tracker.offer(at(A, 7, 5001));
  assert.equal(v.kind, "reject_stale", "the higher generation must not win: it is from a dead process");
  assert.match(v.reason, /superseded backend instance/);
  assert.equal(tracker.rendered().instanceId, B, "the adopted instance is untouched");
  assert.equal(tracker.rendered().decisionGeneration, 1);
  assert.equal(
    verdictDisablesEntry(v.kind),
    false,
    "a merely stale response must NOT disable entry: what is on screen is still the newest seen",
  );
});

/* ═══════════════ 3. a different random id is not automatically newer ═══════════════ */

test("an unfamiliar instance with NO ordinal is INCOMPATIBLE and DISABLES entry", () => {
  const v = orderReadinessDecision(at(A, 7, 100), at(B, null, 1));
  assert.equal(v.kind, "reject_incompatible");
  assert.equal(verdictDisablesEntry(v.kind), true, "unorderable readiness must disable new entry");
  assert.match(v.reason, /could not establish a durable boot ordinal/);
});

test("a backend with no instance identity at all is INCOMPATIBLE (pre-1.7.0 backend)", () => {
  const v = orderReadinessDecision(at(A, 7, 100), at(null, null, 101));
  assert.equal(v.kind, "reject_incompatible");
  assert.match(v.reason, /predates the instance-aware readiness contract/);
});

/* ═══════════════ 4. same-boot out-of-order and duplicates ═══════════════ */

test("same-boot: strictly increasing, duplicates and older responses refused", () => {
  assert.equal(orderReadinessDecision(at(A, 7, 10), at(A, 7, 11)).kind, "accept");
  assert.equal(orderReadinessDecision(at(A, 7, 10), at(A, 7, 10)).kind, "reject_stale");
  assert.equal(orderReadinessDecision(at(A, 7, 10), at(A, 7, 9)).kind, "reject_stale");
});

/* ═══════════════ 5. concurrent HTTP requests crossing a restart ═══════════════ */

test("concurrent responses crossing a restart resolve to the newest instance, whatever the order", () => {
  // box_status arrives from five places on this page; they are independent requests over one
  // connection pool and resolve out of order. Here a restart happens mid-flight.
  const tracker = new ReadinessOrderTracker();
  tracker.offer(at(A, 7, 4997));

  const arrivals = [
    at(A, 7, 4998),
    at(B, 8, 1),
    at(A, 7, 5000), // old instance, higher generation, arrives AFTER the new instance
    at(B, 8, 2),
    at(A, 7, 4999),
  ];
  const applied = [];
  for (const a of arrivals) {
    const v = tracker.offer(a);
    if (verdictApplies(v.kind)) applied.push(`${a.instanceId}:${a.decisionGeneration}`);
  }
  assert.deepEqual(applied, [`${A}:4998`, `${B}:1`, `${B}:2`]);
  assert.equal(tracker.rendered().instanceId, B);
  assert.equal(tracker.rendered().decisionGeneration, 2);
});

/* ═══════════════ 6. reconnection and component remount ═══════════════ */

test("a component REMOUNT accepts the current backend immediately", () => {
  // A remount starts with a fresh tracker (nothing rendered), so a legitimate first paint works even
  // when the backend's sequence is low after a restart.
  const remounted = new ReadinessOrderTracker();
  const v = remounted.offer(at(B, 8, 1));
  assert.equal(v.kind, "accept");
  assert.match(v.reason, /First orderable/);
});

test("a REMOUNT still refuses an unorderable payload", () => {
  const remounted = new ReadinessOrderTracker();
  assert.equal(remounted.offer(at(A, null, 1)).kind, "reject_incompatible");
  assert.equal(remounted.rendered().instanceId, null, "nothing was adopted");
  assert.notEqual(remounted.incompatibleReason(), null, "and the reason is retained for display");
});

test("an ORDERABLE decision replaces an UNORDERABLE one on screen, but not the reverse", () => {
  assert.equal(orderReadinessDecision(at(A, null, 5), at(B, 9, 1)).kind, "adopt_new_instance");
  assert.equal(orderReadinessDecision(at(B, 9, 5), at(A, null, 1)).kind, "reject_incompatible");
});

/* ═══════════════ 7. missing / incompatible readiness fields ═══════════════ */

test("readinessOrderOf tolerates whatever actually arrived, and never fabricates a 0", () => {
  assert.deepEqual(readinessOrderOf(statusWith(A, 8, 3)), {
    instanceId: A,
    bootOrdinal: 8,
    decisionGeneration: 3,
  });
  // A fabricated 0 would sort as the OLDEST possible instance and make an unorderable decision look
  // definitively stale, so absence must stay null.
  assert.deepEqual(readinessOrderOf({ operational_readiness: { decision_generation: 3 } }), {
    instanceId: null,
    bootOrdinal: null,
    decisionGeneration: 3,
  });
  assert.deepEqual(readinessOrderOf({}), { instanceId: null, bootOrdinal: null, decisionGeneration: null });
  assert.deepEqual(readinessOrderOf(null), { instanceId: null, bootOrdinal: null, decisionGeneration: null });
  assert.deepEqual(readinessOrderOf(undefined), { instanceId: null, bootOrdinal: null, decisionGeneration: null });
  // Non-finite and wrong-typed values are refused rather than coerced.
  assert.equal(readinessOrderOf(statusWith(A, Number.NaN, 3)).bootOrdinal, null);
  assert.equal(readinessOrderOf(statusWith(A, 8, Number.NaN)).decisionGeneration, null);
  assert.equal(readinessOrderOf(statusWith("", 8, 3)).instanceId, null);
});

test("a null payload is refused and reported, never treated as an empty success", () => {
  const tracker = new ReadinessOrderTracker();
  const v = tracker.offerStatus(null);
  assert.equal(v.kind, "reject_incompatible");
  assert.equal(verdictDisablesEntry(v.kind), true);
});

test("the incompatible reason is CLEARED once an orderable decision is applied", () => {
  const tracker = new ReadinessOrderTracker();
  tracker.offerStatus(null);
  assert.notEqual(tracker.incompatibleReason(), null);
  tracker.offer(at(A, 7, 1));
  assert.equal(tracker.incompatibleReason(), null, "a recovered backend must clear the banner");
});

/* ═══════════════ 8. multiple backends at one epoch ═══════════════ */

test("two backends reporting the SAME ordinal is INCOMPATIBLE and disables entry", () => {
  const v = orderReadinessDecision(at(A, 8, 100), at(B, 8, 1));
  assert.equal(v.kind, "reject_incompatible");
  assert.equal(verdictDisablesEntry(v.kind), true);
  assert.match(v.reason, /same boot ordinal 8/);
  assert.match(v.reason, /single backend process/);
});

/* ═══════════════ 9. no dependence on wall clocks ═══════════════ */

test("ordering consults no clock, so a skewed client cannot change any verdict", () => {
  assert.equal(orderReadinessDecision.length, 2, "exactly (rendered, incoming) — no clock argument");
  // A lower ordinal loses even when it claims a much later started_at.
  const late = { operational_readiness: { decision_generation: 99999, instance: { instance_id: A, boot_ordinal: 7, started_at: 9_999_999_999_999 } } };
  const v = orderReadinessDecision(at(B, 8, 1), readinessOrderOf(late));
  assert.equal(v.kind, "reject_stale", "started_at is audit-only and cannot promote a stale instance");
});

/* ═══════════════ 10. the contract and the component wiring ═══════════════ */

test("the vendored schema REQUIRES the instance object and documents the ordering", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../contract/schemas/operational-readiness.schema.json", import.meta.url), "utf8"),
  );
  assert.ok(schema.required.includes("instance"), "instance must be required, not optional");
  const inst = schema.properties.instance;
  assert.equal(inst.additionalProperties, false);
  assert.deepEqual(inst.required.sort(), ["boot_ordinal", "instance_id", "started_at"]);
  // Each field nullable, so "cannot be ordered" is expressible rather than defaulted.
  for (const f of ["instance_id", "boot_ordinal", "started_at"]) {
    assert.ok(inst.properties[f].type.includes("null"), `${f} must be nullable`);
  }
  // The corrected description of the counter that caused the defect.
  assert.match(schema.properties.decision_generation.description, /SCOPED TO instance\.instance_id/);
  assert.match(schema.properties.decision_generation.description, /resets to 0 on restart/);
  assert.match(inst.properties.started_at.description, /never used for ordering/);
});

test("the contract version and the backend pin move TOGETHER", () => {
  const version = JSON.parse(readFileSync(new URL("../contract/version.json", import.meta.url), "utf8"));
  const pin = JSON.parse(readFileSync(new URL("../contract/BACKEND_CONTRACT.json", import.meta.url), "utf8"));
  // Pinned to the CURRENT contract version, deliberately as a literal: this assertion exists to fail
  // when the contract moves without the pin and the generated types moving with it, so reading it from
  // the file it is checking would defeat the purpose.
  //
  // 1.8.0 -> 1.9.0: the GTS Algo Research rebrand changed `session_cookie_default` in
  // protocol.json (strikedge_session -> gts_session). protocol.json is hashed by digest.mjs
  // alongside the schemas, so a protocol-constant change moves schemas_sha256 exactly as a
  // schema edit would — hence a version bump, a re-vendor and a re-pin. Updating this literal
  // is the deliberate acknowledgement that step is complete.
  //
  // 1.9.0 -> 1.10.0: the backend gained IN-APP BROKER LOGIN, adding two response schemas
  // (broker-login-start, broker-logout) for POST /api/broker/{broker}/login/start and
  // POST /api/broker/{broker}/logout. ADDITIVE — no existing shape moved — but the frontend
  // consumes both, so it is a minor bump rather than a patch. Re-vendored, re-pinned to the
  // backend commit that introduced them, and `contract.generated.ts` regenerated; this literal
  // moving is the acknowledgement that all four steps are done.
  //
  // 1.10.0 -> 1.11.0: PAPER-MODE MARKET-DATA HONESTY. The backend now monitors the real broker
  // quote feed in every execution mode (market-data monitoring was wrongly gated on
  // `executionMode === "live"`, leaving paper with a permanently DISABLED lifecycle, generation 0
  // and no depth evidence at all), and the payload gained the fields needed to report that
  // truthfully:
  //   • operational-readiness: a new REQUIRED `paper_execution` block; nine new `market_data`
  //     fields (source, socket_connected, authenticated, subscriptions_requested, usable_books,
  //     ticks_observed, frames_observed, heartbeats_observed, depth_observations); three new
  //     `evidence` fields (market_data_last_frame_at, market_data_last_depth_at, and
  //     market_data_age_clock, pinned to "monotonic" so a reader can VERIFY the ages were not
  //     computed by subtracting a monotonic stamp from a wall-clock now — the defect that made
  //     every age ~55 years and rendered as "never observed").
  //   • order-stream-status + operational-readiness: `wiring` gained `not_applicable_paper` and
  //     the fill mechanism gained `simulated_paper_fills`, because a paper deployment builds no
  //     order-stream consumer BY DESIGN and previously fell through to `not_wired` /
  //     `rest_polling_only` — reporting a broken fast fill path that was never meant to exist and
  //     claiming REST polling for orders that are never sent to a broker.
  // ADDITIVE to existing shapes, but `paper_execution` is REQUIRED and both schemas are
  // `additionalProperties: false`, so an unbumped frontend would reject the whole response. Hence a
  // minor bump, a re-vendor, a re-pin and a regenerated `contract.generated.ts`; this literal
  // moving is the acknowledgement that all four steps are done.
  //
  // 1.11.0 -> 1.12.0: THE ZERODHA EMPTY-UNIVERSE FIX AND ITS DIAGNOSTICS.
  // `ActiveBrokerManager.instruments()` returned `[]` for Zerodha, which starved the board, the
  // option chains, the ATM windows, the candidates and the desired subscriptions — and therefore the
  // box-lane socket, which is created lazily on the first subscription. `box-status` published only
  // `underlyings: windows.size`, so an EMPTY instrument master and a quiet market rendered
  // identically as `0`, and the header said SCANNING throughout. `box-status` therefore gained:
  //   • `universe` — the pipeline diagnosis: the FIRST unsatisfied stage (17-value enum), the count
  //     behind every stage, the four-state instrument-load status with the broker's own error, the
  //     spot-seed result, the last successful build, and `readyToEvaluate` as a fact SEPARATE from
  //     `running` (the operator's intent and the engine's capability are not the same bit);
  //   • `box_lane_connected` / `box_lane_dedicated` — the BOX lane's own socket, because
  //     `hub_connected` is the shared board feed and a different socket entirely, so publishing only
  //     it let a connected board lane read as a healthy box feed;
  //   • `market_data_health` was CORRECTED, not extended: it had been publishing
  //     `lastHeartbeatAt`/`lastFrameAt`/`lastDepthAt`, which the backend stopped emitting when ages
  //     began being computed inside the monotonic domain that stamps them. The frontend type was
  //     hand-written and stale, so three stats silently rendered "never observed" on a healthy feed.
  // `universe`, `box_lane_connected` and `box_lane_dedicated` are all REQUIRED on an
  // `additionalProperties: false` schema, so this is again a hard deploy-order dependency.
  //
  // 1.12.0 -> 1.13.0: THE OPERATOR BLOCKLIST OF UNDERLYINGS THAT MAY NEVER BE ENTERED.
  // Until now the traded universe came entirely from the broker's instrument dump, and the only ways
  // to keep a name out were to shrink `BOX_MAX_UNDERLYINGS` (which selects by the board's priority
  // order, not by name) or to stop the scanner. Neither expresses "this specific name is not
  // tradable until I say otherwise", which is a REFUSAL rather than a preference. The contract
  // therefore gained:
  //   • `excluded-underlying.schema.json` — one blocklisted name with its provenance (symbol, a
  //     bounded operator note, the operator ROLE that added it, and when). Never a token or account;
  //   • `box-excluded-underlyings.schema.json` — `GET /api/box/excluded-underlyings`, whose
  //     `load_state` is part of the contract ON PURPOSE. A blocklist that cannot be READ is not an
  //     empty blocklist: `readable: false` means the backend is refusing ALL new entry (readiness
  //     blocker `underlying_exclusions_unreadable`, scope `entry`), because a list it cannot read
  //     cannot confirm that any name is permitted. A client that rendered that as "nothing is
  //     excluded" would tell the operator the opposite of what is happening, which is why the state
  //     is asserted whole-object in contract.assert.ts rather than field-curated;
  //   • `box-status.excluded_underlyings` — the same block embedded verbatim, so the dashboard can
  //     badge an excluded row without a second request.
  // The status field is REQUIRED on an `additionalProperties: false` schema, so this is once more a
  // hard deploy-order dependency: the backend must ship first, or an unbumped frontend rejects the
  // whole status response.
  //
  // 1.13.0 -> 1.14.0: A TOTAL INVENTORY CEILING THAT PAPER CAN ACTUALLY EXERCISE.
  // `BOX_LIVE_MAX_OPEN_BOXES` looks like the "only one box" control and is not, for two reasons: it
  // lives in the live-only order manager (so no paper rehearsal can breach it) and it is read from a
  // count the engine refreshes only AFTER a position exists (so it cannot refuse the second of two
  // entries admitted in the same instant). `box-execution-control.risk` therefore gained:
  //   • `max_open_boxes_all_modes` — BOX_MAX_OPEN_BOXES, enforced in the coordinator's synchronous
  //     admission prologue in EVERY execution mode and before any exposure exists. 0 = unlimited;
  //   • `box_inventory_held` — what it counts: open positions + unresolved residual attempts +
  //     distinct underlyings with unresolved order intents. It can EXCEED `open_boxes`, because a
  //     half-filled entry that never became a Box is still capital at risk, and the UI must not
  //     present the two as the same number.
  // Both are REQUIRED on the `additionalProperties: false` risk block, so this is another hard
  // deploy-order dependency: the backend ships first or the whole execution-control response is
  // rejected here.
  //
  // 1.14.0 -> 1.15.0: THE PRE-RUN UNIVERSE, AND WHY A WIDE ONE BREAKS A QUANTITY CAP.
  // Everything above assumed one deliberately configured underlying. Watching the whole F&O universe
  // instead is safe for EXPOSURE — `BOX_MAX_OPEN_BOXES` is an inventory ceiling and does not care how
  // many names are watched — but it silently breaks one control and leaves another unusable.
  //   • `BOX_LIVE_MAX_OPEN_LEG_QUANTITY` is ONE global number, and F&O lot sizes span orders of
  //     magnitude (an index lot of 75 against single-stock lots in the thousands). With one chosen
  //     name the cap could be set to exactly that instrument's lot; across ~200 names no single value
  //     works. A name whose lot exceeds it is not UNLIKELY to trade, it CANNOT — and the refusal
  //     happens deep on the entry path in `entryQuantityEnvelopeBlockReason`, where it surfaces as an
  //     execution refusal rather than a configuration mismatch. An operator watching a quiet name
  //     could not tell "no edge today" from "impossible by configuration".
  //   • The board was never exposed at all, so a name could only be excluded by already KNOWING its
  //     symbol. A deny list you cannot browse is a deny list you cannot use.
  // The contract therefore gained:
  //   • `universe-underlying.schema.json` — one underlying with its lot size, expiry, paired-strike
  //     count, blocklist state, and TWO INDEPENDENT verdicts: `excluded` (what the operator decided)
  //     and `admissible` + `inadmissible_reason` (whether the current caps permit it at all). Both
  //     are asserted whole-object in contract.assert.ts rather than field-curated, because a renamed
  //     inadmissibility code would otherwise let the picker fall through to "no reason given" on a
  //     name that can never trade — silence exactly where the explanation is the point;
  //   • `box-universe.schema.json` — `GET /api/box/universe`, readable while the engine is IDLE,
  //     which is the whole point: `boot()` performs one universe pass, so the operator decides what
  //     to discover instead of inferring it afterwards from whichever opportunities appeared.
  //     `built: false` distinguishes "no pass has completed" from "the universe is empty" (without it
  //     an empty list at boot reads as a broken instrument master), and `summary.blocked_by_caps`
  //     counts names that are NOT excluded and still cannot trade — the count that matters, because
  //     those look enabled.
  // Also `POST /api/box/excluded-underlyings/bulk`, which has no response schema of its own (it
  // returns the already-pinned `box-excluded-underlyings` shape). It exists because each
  // single-symbol write triggers a full universe rebuild backend-side, so screening eighty names one
  // request at a time would be eighty instrument-master fetches. It is DIFF-BASED rather than
  // replace-the-set, so a client holding a stale list cannot silently RE-ADMIT a name excluded
  // moments earlier from elsewhere — the one direction of error that re-opens entry on something
  // deliberately declined.
  // PURELY ADDITIVE: no existing shape moved, and nothing became required on an existing schema. The
  // frontend consumes both new shapes, so it is a minor bump rather than a patch, and unlike the four
  // bumps above it is NOT a hard deploy-order dependency — an unbumped frontend would keep working,
  // it simply could not show the picker.
  //
  // 1.15.0 -> 1.16.0: "WATCHABLE" WAS NOT WHAT IS WATCHED, AND TWO CAPS WERE REPORTED AS ONE.
  // The universe payload above shipped with only `watchable` — not excluded AND admissible — which a
  // picker naturally renders as "underlyings being watched". It is not: it counts what nothing
  // FORBIDS, and says nothing about `BOX_MAX_UNDERLYINGS` or the token budget, either of which can
  // leave a perfectly eligible name unobserved. On the live deployment that was maximally misleading —
  // `BOX_MAX_UNDERLYINGS=1` with 215 joined names reported 215 watchable while exactly ONE underlying
  // held a window. Compounding it, `refreshUniverse` pushed BOTH the `BOX_MAX_UNDERLYINGS` cut and the
  // token-budget cut into one `skipped` array published as `skipped_for_budget`, so the dashboard
  // announced that 214 names were "outside the live-feed token budget (2200 instruments)" while that
  // budget had hundreds of tokens to spare and the setting actually responsible went unnamed — the
  // same conflation `skippedForIndicativeCap` had already been split out to fix, recurring elsewhere.
  // The contract therefore gained:
  //   • universe-underlying: `watched`, taken from the engine's OWN window map rather than re-derived
  //     from the caps (a second implementation of "who won a place in the universe" would be free to
  //     disagree with the one that actually built the windows), plus `not_watched_reason`
  //     (excluded | underlying_cap | token_budget | discovery_off) naming the cause. Note an EXCLUDED
  //     name that still holds a window reports `watched: true`, because its legs keep streaming so the
  //     monitor can exit it — the count reflects what the feed carries, not what the blocklist prefers;
  //   • box-universe: `summary.watched` and `summary.eligible_not_watched` (a non-zero gap means a CAP
  //     is deciding what gets looked at, not the market), plus `max_underlyings`,
  //     `max_subscribed_tokens` and `discovering` so a client can NAME the setting to change instead
  //     of describing the symptom;
  //   • box-status: `skipped_for_underlying_cap`, `skipped_underlying_cap_symbols` and
  //     `max_underlyings`. `skipped_for_budget` now means ONLY the token budget, and the two must
  //     never be summed or described as one limit.
  // The three box-status additions are REQUIRED on an `additionalProperties: false` schema, so this is
  // once again a hard deploy-order dependency: the backend ships first or an unbumped frontend rejects
  // the whole status response.
  //
  // 1.16.0 -> 1.16.1: `watched` and `not_watched_reason` were added to universe-underlying but LEFT OUT
  // of its `required` array, so they generated as optional. That defeats the point — a payload silently
  // missing `watched` would validate and a client would treat an unobserved name as UNKNOWN rather
  // than being told the contract was broken. The backend could not catch it (it validates a payload
  // that HAS both fields, and an optional field validates when present); it surfaced here, as a
  // MutuallyAssignable failure between `watched?: boolean` and the hand-written `watched: boolean`.
  // Tightening only: no shape changed and both fields were always emitted.
  //
  // 1.16.1 -> 1.17.0: FREE CAPITAL, PUBLISHED CONTINUOUSLY RATHER THAN PER ENTRY ATTEMPT.
  // The account balance already existed on the wire, but only inside
  // `economic_admission.picture.available_funds` — which is a by-product of live entry admission and
  // is therefore null in every paper mode, null in live while the three funding gates are off, null
  // until the FIRST entry has been economically evaluated, and thereafter frozen at whatever that
  // attempt observed (potentially hours old). So the one figure an operator most wants before arming
  // was absent precisely then. `box-status` gained a REQUIRED `account_funds` block
  // (`account-funds.schema.json`), refreshed on its own timer in every mode that has an authenticated
  // session — read through the market-data client rather than the live-only order adapter, because
  // "what can I actually trade with?" is a question that matters while REHEARSING.
  // The honesty properties that shape the schema, each of which a client must respect:
  //   • `free_to_trade_rupees: null` is UNKNOWN and must NEVER render as ₹0. Six distinct
  //     `unavailable_reason`s are kept apart because they call for different actions — log in
  //     (`no_session`), wait (`never_read`), stop expecting a number (`not_supported`), or read the
  //     error (`read_failed` / `not_reported` / `semantics_unknown`);
  //   • a GENUINE ₹0 balance is reported as 0 with `unavailable_reason: null`, so an empty account is
  //     distinguishable from an unread one;
  //   • a STALE figure is published WITH its age rather than discarded, because mid-session
  //     "₹47,000 as of 60s ago, refresh failing" is more useful than a blank — and a blank would be
  //     indistinguishable from an empty account. `fresh` is the flag, `age_ms` is never negative;
  //   • `semantics` is the machine-readable enum, not prose: for Zerodha `net_of_encumbrance` means
  //     `utilised.debits` is NOT subtracted from `live_balance` again. The headline runs through the
  //     SAME per-broker helper the live admission gate uses, so the screen and the engine cannot
  //     disagree about whether an entry was affordable.
  // `account_funds` is REQUIRED on an `additionalProperties: false` schema, so this is another hard
  // deploy-order dependency: the backend ships first or an unbumped frontend rejects the whole status
  // response. Asserted whole-object in contract.assert.ts rather than field-curated, because a
  // seventh `unavailable_reason` added later must break compilation instead of silently falling
  // through to a bare dash on a state that has a specific operator action.
  //
  // ── v1.18.0 — `entry_alerts`: WHICH underlying was refused, and WHY ──────────────────────────
  //
  // The motivating failure is worth recording, because the page was actively misleading rather than
  // merely incomplete. A paper_legging deployment displayed:
  //
  //     ATTEMPTS 355   FAILED 355   FAILURE RATE 100%
  //     Rejection categories:  UNKNOWN_INTERNAL_ERROR 354   CROSS_LEG_TIME_SKEW 1
  //
  // Nothing had crashed. The armed session's attempt budget was spent, so every candidate was
  // correctly refused with `session_limit_reached` — but that reason was one of SIX members of the
  // backend's refusal union that had never been added to its closed metric-label set, so the
  // cardinality backstop rewrote all 354 of them to `unknown_internal_error`. The operator was sent
  // hunting a crash that did not exist, and the single fact that explained everything was the one
  // fact being discarded.
  //
  // Fixing the label was necessary but not sufficient: NOTHING on the wire carried the SYMBOL.
  // `metrics.execution.rejection_categories` is a process-lifetime counter map and structurally
  // cannot (a symbol in a metric label is an unbounded label space); `box_execution_attempts` rows
  // are written only once a leg has actually FILLED, so a refusal that never reached the market
  // persists nothing at all; and the `ENTRY_REJECTED_*` trade events are throttled per candidate, so
  // a name refused hundreds of times leaves a handful of rows. Three places, three different ways of
  // losing the same answer.
  // The properties that shape this schema, each of which the UI must respect:
  //   • AGGREGATED by (underlying, reason). 354 identical refusals arrive as ONE alert with
  //     `count: 354`. Rendering them individually would bury the two that differ, which are
  //     invariably the ones worth reading;
  //   • `count` is EXACT — unthrottled and unsampled — so it can be compared with
  //     `metrics.execution.failed` and a discrepancy is itself a signal;
  //   • `category` splits ordinary market churn from things needing a human, and `actionable` is the
  //     BACKEND's verdict. The badge must count `actionable_alerts`, never `total_alerts`: a bell
  //     that rings for `price_moved` rings permanently and is ignored within a day, taking the real
  //     alerts with it;
  //   • `dropped_groups > 0` means the list is TRUNCATED at the backend's group cap. It is published
  //     rather than hidden because the cap is what makes keying by symbol safe, and a silent cap
  //     would just be a different way of misleading someone about how much is being refused;
  //   • `remedy` always carries a real sentence, including an explicit "no action" — the whole point
  //     is that no state on this surface is left unexplained.
  // Like `account_funds`, `entry_alerts` is REQUIRED on the closed `box-status` schema, so the same
  // hard deploy order applies: backend first. Asserted whole-object (both levels) in
  // contract.assert.ts, so a fifth `category` added later breaks compilation instead of silently
  // rendering an unstyled, unbadged row for a class of problem nobody considered — which would
  // reintroduce, inside the very feature built to prevent it, the silence that caused the bug.
  // ── v1.19.0 — OPERATOR RUNTIME CONFIGURATION: the authority boundary, on the wire ────────────
  // The backend gained a validated, PostgreSQL-persisted runtime configuration surface so an
  // operator can change a strategy or risk parameter without editing a server `.env` and restarting.
  // Four new schemas, all additive, none touching an existing shape:
  //   • `operator-config` — GET and PATCH both return it, so a client always finishes a mutation
  //     holding the new authoritative state instead of re-reading and hoping. `version` is the
  //     optimistic-concurrency token for the configuration AS A WHOLE: a PATCH echoes the version it
  //     believes it is editing and is refused if anything moved, and the frontend uses the same
  //     number to DISCARD a stale response that arrives after a newer one;
  //   • `operator-config-setting` — and the reason this schema carries THREE values rather than one
  //     is the entire point of the feature. `configured_value` is what the operator asked for,
  //     `effective_value` is what the engine enforces, and they diverge whenever an explicitly-set
  //     deployment ceiling clamps the operator's figure (`source: runtime_clamped_by_env`,
  //     `clamped_by_deployment: true`). A UI showing only one number would report a limit that is
  //     not in force, which on a capital cap is the most dangerous thing this surface could do.
  //     `session_snapshot_value` is the fourth: non-null only for a NEXT_SESSION setting while a
  //     session is armed, carrying the value FROZEN at arm time, so a newly configured attempt
  //     ceiling can never be rendered as though the armed session were already bound by it;
  //   • `operator-config-change` — the append-only audit trail, recording the configured AND the
  //     effective value before and after, because a clamp makes those differ and "I set 150,000"
  //     versus "120,000 was enforced" is exactly what an incident review needs;
  //   • `operator-config-refusal` — 409 stale version, 422 validation/policy, 403 role. `applied` is
  //     `const: false` rather than a boolean, and `problems` has `minItems: 1`, so a refusal can
  //     neither be misread as a partial success nor arrive without saying why.
  // The `deployment` block is READ-ONLY and env-owned: it DISPLAYS the four live-capability gates
  // (execution mode, the deployment live flag and the two per-broker gates) plus the backend's own
  // `live_capable` verdict, and nothing in it is writable through any runtime API. That is what makes
  // it impossible to turn a paper deployment live from a browser, and it is why the UI must keep
  // taking the paper/live label from here rather than deriving one.
  // NO SECRET APPEARS IN ANY OF THESE SHAPES. Only environment variables classified as plain `config`
  // in the backend's own `src/env/secrets.ts` may be registered as settings at all, a backend test
  // asserts it against the real classifier, and `env_var` is provenance for an Advanced detail only.
  // PURELY ADDITIVE and NOT a hard deploy-order dependency: nothing became required on an existing
  // schema, so an unbumped frontend keeps working — it simply cannot show the configuration screen.
  // ── v1.20.0 — THE METRICS SNAPSHOT, WRITTEN DOWN ─────────────────────────────────────────────
  // `box-status.metrics` was declared `{"type": "object"}` and nothing more, with the comment "OPEN
  // by design: engine-owned rolling ... rings". The intent was right — the engine must stay free to
  // add counters — but the effect was that the interior was covered by NOTHING, and the execution
  // health panel renders from ~25 names inside it. The digest did not reach them. The compile-time
  // assertions could not see them, because an open object generates `Record<string, never>` — the
  // header of contract.assert.ts listed `metrics` among exactly those unassertable leaves. And the
  // panel reads them defensively, so a rename would not throw. A backend renaming
  // `partial_recovered` would therefore have compiled on both sides, passed every test in both
  // repositories, deployed, and rendered a grid of dashes: not an error, just silence, on the one
  // panel whose job is to say whether execution is working.
  //   • `box-metrics` — OPEN at every level, exactly as before, and `latency`/`throughput`/`charges`
  //     are still not listed at all. What it adds is a `required` array over the names a consumer
  //     depends on, which draws the distinction that matters: ADDING a counter needs no bump, while
  //     renaming, removing or retyping one the UI reads fails immediately;
  //   • `box-metric-ring` — `Ring.summary()`, which is NULL until the ring has a sample, so null
  //     means "not measured yet" and must never be rendered as zero. Open for the same reason:
  //     `required` already catches a DROPPED percentile, which is what breaks a consumer, whereas an
  //     ADDED one breaks nobody.
  // This is what makes the loop closed rather than merely documented: the backend's contract suite
  // validates a REAL serialized engine response against these schemas, the schemas generate
  // `BoxMetricsContract`, and four assertions in contract.assert.ts make `tsc -b` prove the
  // generated contract and the hand-written `BoxMetricsSnapshot` still agree.
  // NO WIRE CHANGE and NOT a deploy-order dependency: not one byte of any response moved, so either
  // side may ship first. `readContractIdentity()` is reported by the backend and gated on by
  // nothing, so a version skew cannot refuse a request.
  // v1.21.0 — `account_funds` now publishes the broker's FULL funds breakdown (`components`) and the
  // `basis` that produced the headline, so a figure that disagrees with the broker's own screen can be
  // explained component by component instead of taken on trust.
  assert.equal(version.contract_version, "1.21.0");
  assert.equal(
    pin.contract_version,
    version.contract_version,
    "the pin must name the same contract version it vendors",
  );
  assert.equal(
    pin.schemas_sha256,
    version.schemas_sha256,
    "and the same digest — contract:verify checks the digest, only this checks they agree",
  );
  assert.match(pin.backend_sha, /^[0-9a-f]{40}$/, "the pinned backend SHA must be a real commit id");
});

test("Box.tsx uses the ORDERING TRACKER and no longer the bare generation comparison", () => {
  const box = readFileSync(new URL("../src/Box.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(box.includes("new ReadinessOrderTracker()"), "the component must hold the tracker");
  assert.ok(box.includes("readinessOrder.current.offerStatus("), "and route every payload through it");
  assert.ok(
    !box.includes("acceptStatus("),
    "the restart-blind generation guard must no longer decide whether a status is applied",
  );
  assert.ok(
    box.includes("verdictDisablesEntry("),
    "an unorderable payload must visibly disable entry rather than be silently dropped",
  );
  assert.ok(
    box.includes("readinessIncompatible"),
    "and the reason must be rendered for the operator",
  );
});

/* ═══════════════ 11. the server remains the authority ═══════════════ */

test("this module never grants permission — it only orders evidence", () => {
  // A UI ordering rule is not a safety boundary. Every verdict here is about WHICH payload to render;
  // none of them can turn a refusal into a permission, and the backend revalidates every entry request
  // independently (and itself refuses entry when its own epoch is unknown).
  const surface = Object.keys({ orderReadinessDecision, readinessOrderOf, verdictApplies, verdictDisablesEntry });
  for (const name of surface) {
    assert.ok(
      !/permit|allow|arm|authorise|authorize|enable/i.test(name),
      `${name} must not read as a permission-granting API`,
    );
  }
  // And the strictest verdict available is "do not show this", never "allow entry".
  const v = orderReadinessDecision(NOTHING, at(A, 1, 1));
  assert.equal(v.kind, "accept");
  assert.equal(Object.keys(v).sort().join(","), "kind,reason", "a verdict carries no permission field");
});
