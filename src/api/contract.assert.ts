/**
 * COMPILE-TIME CONTRACT ASSERTIONS — checked by `tsc -b` (part of `npm run build`).
 *
 * This module contains NO runtime behaviour that matters; it exists so the TypeScript
 * compiler proves, STATICALLY, that the frontend's hand-written types in `src/api/types.ts`
 * stay in lockstep with the backend-owned contract in `contract/schemas/**` (surfaced as the
 * generated types in `./contract.generated.ts`, produced by `npm run contract:types`). If the
 * backend contract and the frontend types DRIFT, `tsc -b` FAILS here — failing the build and
 * CI.
 *
 * ── ASSERTION KINDS ──────────────────────────────────────────────────────────────────────
 *   MutuallyAssignable<A,B>  — A and B describe the SAME shape (each extends the other). A
 *                              field added / removed / renamed / retyped on EITHER side
 *                              breaks it. Used for shapes whose schema is fully CLOSED and
 *                              whose hand-written type matches it exactly.
 *   AssignableTo<A,B>        — every value the contract guarantees (A) is consumable by the
 *                              hand-written type (B). Used where the hand-written type is a
 *                              deliberate SUPERSET of the contract body (documented per case).
 *                              This is the consumer-critical direction: a backend rename /
 *                              removal / retype of a field the frontend reads breaks it.
 *
 * ── WHY SOME SHAPES ARE FIELD-CURATED, NOT WHOLE-OBJECT ─────────────────────────────────
 * Several Box schemas are intentionally OPEN at the leaf: engine-owned diagnostic sub-objects
 * (`box-status.scanner|monitor|charges|reconciliation|metrics|day_pnl|…`, `risk.capital`,
 * `execution.entry_burst`, …) are pinned by the schema for PRESENCE + JSON type only, so the
 * generated type is `Record<string, never>` / `unknown[]` there and cannot match the
 * frontend's richly-typed sub-objects. A whole-object assertion on those shapes would be a
 * FALSE claim. For those shapes we therefore assert MUTUAL assignability over a CURATED set of
 * the CLOSED, consumer-facing fields (scalars/enums/ids the dashboard switches on). Renaming,
 * removing or retyping any of THOSE fields on either side still breaks compilation.
 *
 * The whole exercise is inert at runtime: `export type` aliases and one `never`-typed const.
 */

import type { AccessStatus } from "./access.ts";
import type { BoxFlattenItem, flattenAttributedBoxExposure } from "./box.ts";
import type {
  AccessStatusContract,
  AccessVerifyContract,
  ArmVerdictContract,
  BoxExecutionControlContract,
  BoxFlattenItemContract,
  BoxFlattenResultContract,
  OperationalReadinessContract,
  ReadinessBlockerContract,
  BoxOpenPositionContract,
  BoxOpportunityContract,
  BoxStatusContract,
  BoxMetricsContract,
  BoxExcludedUnderlyingsContract,
  AccountFundsContract,
  EntryAlertContract,
  EntryAlertsContract,
  BoxUniverseContract,
  UniverseUnderlyingContract,
  BrokerHealthContract,
  BrokerLoginStartContract,
  BrokerLogoutContract,
  BrokerRuntimeStatusContract,
  BrokerSessionContract,
  BrokerStatusContract,
  BrokerSwitchBlockersContract,
  BoxConfigContract,
  ExportStatusContract,
  RuntimeStatusContract,
} from "./contract.generated.ts";
import type {
  BrokerLoginStart,
  BrokerLogoutResponse,
  BoxConfigView,
  BoxExecutionControl,
  BoxOpenPosition,
  BoxOpportunity,
  BoxStatus,
  BoxMetricsSnapshot,
  BoxExcludedUnderlyings,
  AccountFunds,
  EntryAlert,
  EntryAlerts,
  BoxUniverse,
  UniverseUnderlying,
  BrokerHealthView,
  BrokerSessionView,
  BrokerStatus,
  BrokerSwitchBlockersResponse,
  BrokerTokenRuntime,
  ExportStatus,
  RuntimeStatus,
  OperationalReadiness,
  ReadinessBlocker,
} from "./types.ts";

/* ============================ assertion primitives ============================ */

/** Force a compile error unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/** True iff A and B are mutually assignable (same shape). */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** True iff A is assignable to B (every A is a valid B — B may be a superset). */
type AssignableTo<A, B> = [A] extends [B] ? true : false;

/* ============================ EXACT (fully-closed) shapes ============================ */
/* Schema is fully closed AND the hand-written type matches it exactly, both directions. */

// GET /api/broker/switch-blockers
type _SwitchBlockers = Assert<MutuallyAssignable<BrokerSwitchBlockersResponse, BrokerSwitchBlockersContract>>;

// GET /api/broker/status — the redacted health element (closed on both sides).
type _BrokerHealth = Assert<MutuallyAssignable<BrokerHealthView, BrokerHealthContract>>;

// GET /api/runtime/status — top-level and per-broker element are closed and match exactly.
type _BrokerRuntime = Assert<MutuallyAssignable<BrokerTokenRuntime, BrokerRuntimeStatusContract>>;
type _RuntimeStatus = Assert<MutuallyAssignable<RuntimeStatus, RuntimeStatusContract>>;

/*
 * SECTION 7 / contract v1.6.0 — THE ONE AUTHORITATIVE READINESS DECISION.
 *
 * Asserted WHOLE-OBJECT in both directions, not field-curated: the schema is fully CLOSED here
 * deliberately, because every field is a permission, a lifecycle, a blocker or a freshness fact the
 * dashboard renders as an operational claim. A silently added, renamed or retyped field would be a
 * silently changed permission — so it must fail `tsc -b` rather than degrade at runtime.
 *
 * This is also what keeps defect (b) from returning: the frontend cannot quietly stop reading
 * `entry.permitted` (or start reading a field the backend does not send) without breaking the build.
 */
type _ReadinessBlocker = Assert<MutuallyAssignable<ReadinessBlocker, ReadinessBlockerContract>>;
type _OperationalReadiness = Assert<MutuallyAssignable<OperationalReadiness, OperationalReadinessContract>>;

// The shared arm-verdict shape ({ ok, blockers:[{code,detail}] }) — closed.
type _ArmVerdict = Assert<
  MutuallyAssignable<ArmVerdictContract, { ok: boolean; blockers: { code: string; detail: string }[] }>
>;

/* ============================ ACCESS shapes (contract ⊆ frontend) ============================ */
/*
 * ONE hand-written `AccessStatus` interface models BOTH /verify and /status (and both /status
 * branches): `authenticated` is a plain boolean and role/expires_at/csrf_token/passcode_configured
 * are optional, so a single decoder consumes every real access response body. We therefore assert
 * the consumer-critical direction — the contract bodies are assignable INTO the hand-written type.
 * A backend rename/removal/retype of a field the gate reads breaks this.
 */
type _AccessVerify = Assert<AssignableTo<AccessVerifyContract, AccessStatus>>;
type _AccessStatus = Assert<AssignableTo<AccessStatusContract, AccessStatus>>;
// The authenticated /status|/verify branch supplies exactly what the gate reads.
type _AccessAuthBranch = Assert<
  AssignableTo<{ authenticated: true; role: "full" | "trade"; expires_at: string; csrf_token: string }, AccessStatus>
>;

/* ============================ EXPORT STATUS — now WHOLE-OBJECT (divergence resolved) ============================ */
/*
 * RESOLVED (contract v1.1.0): the `export-status` schema now pins `enabled` and `connected`
 * (required booleans) alongside the backlog/dead-letter counters. The hand-written
 * `ExportStatus` and the generated `ExportStatusContract` are now the SAME closed shape, so
 * this is asserted WHOLE-OBJECT, both directions. The former curated Pick over only the shared
 * counters (a workaround for the schema gap) is gone — a rename/removal/retype of ANY field on
 * either side now breaks the build.
 */
type _ExportStatus = Assert<MutuallyAssignable<ExportStatus, ExportStatusContract>>;

/* ============================ BROKER SESSION / STATUS — now WHOLE-OBJECT (divergence resolved) ============================ */
/*
 * RESOLVED (contract v1.2.0): the `broker-session` schema now marks `account_label`,
 * `established_at` and `expires_at` REQUIRED with a nullable type (`["string","null"]`) instead
 * of optional — matching the real `projectBrokerSession`, which has always populated all three
 * (value or explicit null). The generated `BrokerSessionContract` therefore no longer gives
 * them `?`, so it is now the SAME closed shape as the hand-written `BrokerSessionView`
 * (`state` was already pinned in v1.1.0). Both are asserted WHOLE-OBJECT, both directions — the
 * former curated Pick over `broker｜connected｜state` (a workaround for the optional-vs-required
 * gap) is gone. A rename/removal/retype of ANY field on either side now breaks the build.
 *
 * `BrokerStatus` embeds that session (plus the already-whole-object `BrokerHealthView`) in its
 * `brokers[]` element and is otherwise closed (`active_broker`, `generation`), so it too is now
 * asserted WHOLE-OBJECT, replacing the former top-level-only curated Pick.
 */
type _BrokerSession = Assert<MutuallyAssignable<BrokerSessionView, BrokerSessionContract>>;
type _BrokerStatus = Assert<MutuallyAssignable<BrokerStatus, BrokerStatusContract>>;

/*
 * IN-APP BROKER LOGIN — contract v1.10.0.
 *
 * Both schemas are fully CLOSED (`additionalProperties: false`, every field required) and the
 * hand-written types match them exactly, so both are asserted WHOLE-OBJECT in both directions.
 *
 * `BrokerLogoutResponse.ok` is deliberately `boolean` on the frontend while the schema pins
 * `const: true`, so that direction is asserted one-way: the contract's `true` is assignable to
 * `boolean`. Widening it here is intentional — a client that hard-required `true` would crash
 * rather than render if the backend ever reported a refusal, and `ok` is read as a condition,
 * not matched as a literal.
 */
type _BrokerLoginStart = Assert<MutuallyAssignable<BrokerLoginStart, BrokerLoginStartContract>>;
type _BrokerLogout = Assert<AssignableTo<BrokerLogoutContract, BrokerLogoutResponse>>;

/* ============================ CURATED-FIELD shapes (open leaves excluded) ============================ */
/*
 * These Box shapes carry engine-owned OPEN diagnostic leaves that the schema pins by presence
 * only, so a whole-object match is impossible by design. We assert MUTUAL assignability over
 * the CLOSED, consumer-facing fields — renaming/removing/retyping any of these on either side
 * breaks the build. (Fields typed as bare `string` in the schema — e.g. `execution_mode`,
 * `circuit_state`, `paper_execution_profile`, `charge_origin`, `reject` — are intentionally
 * omitted here: the schema deliberately does NOT pin their enum domain, so asserting equality
 * with the frontend's narrower unions would be a false claim.)
 */

// GET /api/box/status — headline lifecycle/health scalars the dashboard switches on.
// `market_data_state` is a CLOSED enum in the schema (the 8-state MarketData machine), so it is
// asserted here; `market_data_health`/`execution_funnel`/`economic_admission` are OPEN leaves
// (schema pins presence + object-ness only), so a whole-object assertion on them would be false.
type _BoxStatusFields = Assert<
  MutuallyAssignable<
    Pick<
      BoxStatusContract,
      "running" | "monitoring" | "market_open" | "authenticated" | "db_enabled" | "hub_connected"
      | "feed_healthy" | "quotes" | "quote_updates" | "underlyings" | "candidates"
      | "monitored_tokens" | "hub_subscribed" | "strike_level" | "open_positions" | "started_at"
      | "stopped_at" | "universe_built_at" | "subscribed_option_tokens" | "subscribed_spot_tokens"
      | "feed_age_ms" | "skipped_for_budget" | "skipped_symbols" | "skipped_for_underlying_cap"
      | "skipped_underlying_cap_symbols" | "max_underlyings" | "last_error" | "market_data_state"
      | "excluded_underlyings"
    >,
    Pick<
      BoxStatus,
      "running" | "monitoring" | "market_open" | "authenticated" | "db_enabled" | "hub_connected"
      | "feed_healthy" | "quotes" | "quote_updates" | "underlyings" | "candidates"
      | "monitored_tokens" | "hub_subscribed" | "strike_level" | "open_positions" | "started_at"
      | "stopped_at" | "universe_built_at" | "subscribed_option_tokens" | "subscribed_spot_tokens"
      | "feed_age_ms" | "skipped_for_budget" | "skipped_symbols" | "skipped_for_underlying_cap"
      | "skipped_underlying_cap_symbols" | "max_underlyings" | "last_error" | "market_data_state"
      | "excluded_underlyings"
    >
  >
>;

/* ============================ BOX METRICS — newly assertable (contract v1.20.0) ============================ */
/**
 * `box-status.metrics` USED TO BE one of the open leaves listed in this file's header: the schema
 * pinned it as `{"type": "object"}` and nothing more, so the generated type was
 * `Record<string, never>` and no assertion here could say anything true about it.
 *
 * That was not a cosmetic gap. `BoxExecutionHealth` renders from these exact field names, the
 * frontend hand-maintains `BoxMetricsSnapshot` in `./types.ts`, the backend derives its own shape
 * from `ReturnType<BoxMetrics["snapshot"]>`, and NOTHING connected the two — not the digest, which
 * did not cover the interior, and not this file, which had nothing to assert against. A backend
 * rename would have compiled, validated, deployed, and shown the operator an empty panel.
 *
 * `box-metrics.schema.json` now pins the names, so the loop closes: the backend's contract suite
 * validates a REAL serialized response against that schema, the schema generates
 * `BoxMetricsContract`, and the two assertions below make `tsc -b` prove the generated contract and
 * the hand-written type still agree.
 *
 * CURATED, for the reason the header describes: the schema is deliberately OPEN at every level so
 * the engine can keep adding counters, and `BoxMetricsSnapshot` is correspondingly a superset
 * (22 execution fields against the 15 the contract pins). A whole-object assertion would be a false
 * claim. What is asserted is exactly the set the UI reads.
 */

// The scalar counters and rates, MUTUALLY: a rename, removal or retype on EITHER side breaks the
// build. Both sides are plain `number`, so equality is the right and strictest claim.
type _BoxMetricsExecutionScalars = Assert<
  MutuallyAssignable<
    Pick<
      BoxMetricsContract["execution"],
      "attempted" | "completed" | "successful" | "partial_recovered" | "partial_unresolved"
      | "failed" | "aborted" | "retries" | "success_rate" | "failure_rate" | "rejection_categories"
    >,
    Pick<
      BoxMetricsSnapshot["execution"],
      "attempted" | "completed" | "successful" | "partial_recovered" | "partial_unresolved"
      | "failed" | "aborted" | "retries" | "success_rate" | "failure_rate" | "rejection_categories"
    >
  >
>;

/*
 * `NonNullable` on the hand-written side, and the reason is itself a divergence worth naming.
 *
 * `BoxMetrics.snapshot()` ALWAYS returns a `legging` object — it is an unconditional key in the
 * returned literal — and the schema marks it required accordingly. This repository nevertheless
 * declares it `legging?:`, and `BoxExecutionHealth` guards every read with `legging?.` or
 * `legging && legging.outcomes.total > 0`.
 *
 * That divergence is in the SAFE direction: the frontend tolerates an absence the backend cannot
 * produce, which costs nothing, whereas the reverse would crash. So it is left alone rather than
 * "corrected" to match the contract — but it does mean `BoxMetricsSnapshot["legging"]` is a union
 * with `undefined`, and `keyof` over a union is the INTERSECTION of its members' keys, which for
 * anything unioned with `undefined` is `never`. `Pick` would then reject every key name. Stripping
 * the nullability is what lets these assertions talk about the shape, which is the part the
 * contract actually governs; the optionality is a local safety choice, not a contract claim.
 */
type _BoxMetricsLeggingScalars = Assert<
  MutuallyAssignable<
    Pick<
      BoxMetricsContract["legging"],
      "fill_rate_4_of_4" | "failure_rate_3_of_4" | "failure_rate_2_of_4" | "failure_rate_1_of_4"
    >,
    Pick<
      NonNullable<BoxMetricsSnapshot["legging"]>,
      "fill_rate_4_of_4" | "failure_rate_3_of_4" | "failure_rate_2_of_4" | "failure_rate_1_of_4"
    >
  >
>;

/*
 * `outcomes.total` and `outcomes.aborts` — the two the panel reads to decide whether the legging
 * block renders at all, and how many attempts were abandoned.
 */
type _BoxMetricsLeggingOutcomes = Assert<
  MutuallyAssignable<
    Pick<BoxMetricsContract["legging"]["outcomes"], "total" | "aborts">,
    Pick<NonNullable<BoxMetricsSnapshot["legging"]>["outcomes"], "total" | "aborts">
  >
>;

/*
 * The RING-valued fields, one-way (contract → hand-written), which is the consumer-critical
 * direction: everything the contract guarantees must be consumable by the type the panel reads.
 *
 * Deliberately not mutual. The generated ring carries an index signature because the schema leaves
 * it open, while the hand-written `RingSummary` is an `interface` — and TypeScript grants an
 * implicit index signature to type aliases but NOT to interfaces, so the reverse direction cannot
 * hold for a reason that has nothing to do with the contract agreeing. Asserting it anyway would
 * mean weakening `RingSummary` to satisfy the compiler, which is the wrong way round.
 */
type _BoxMetricsRings = Assert<
  AssignableTo<
    Pick<
      BoxMetricsContract["execution"],
      "decision_deterioration" | "execution_slippage" | "exit_slippage"
    >,
    Pick<
      BoxMetricsSnapshot["execution"],
      "decision_deterioration" | "execution_slippage" | "exit_slippage"
    >
  >
>;

type _BoxMetricsLeggingRings = Assert<
  AssignableTo<
    Pick<
      BoxMetricsContract["legging"],
      "legging_net_loss" | "first_to_last_fill_ms" | "expected_vs_realised_net" | "most_failing_role"
    >,
    Pick<
      NonNullable<BoxMetricsSnapshot["legging"]>,
      "legging_net_loss" | "first_to_last_fill_ms" | "expected_vs_realised_net" | "most_failing_role"
    >
  >
>;

/**
 * GET /api/box/excluded-underlyings — whole-object, because the schema is CLOSED.
 *
 * Worth asserting rather than curating: the blocklist is a safety control, and `load_state` is the
 * field whose meaning a client must not get wrong. A renamed or re-typed member here breaks
 * compilation instead of silently degrading a refusal into "nothing is excluded".
 */
type _BoxExcludedUnderlyings = Assert<
  MutuallyAssignable<BoxExcludedUnderlyingsContract, BoxExcludedUnderlyings>
>;

/**
 * box_status.account_funds — whole-object, because the schema is CLOSED.
 *
 * Asserted rather than curated because the fields that must not drift are `free_to_trade_rupees`
 * being NULLABLE and `unavailable_reason` being an exhaustive union. If the backend added a seventh
 * reason, a curated assertion would let the UI fall through to a bare dash on a state that has a
 * specific operator action — which is the whole point of keeping the six apart.
 */
type _AccountFunds = Assert<MutuallyAssignable<AccountFundsContract, AccountFunds>>;

/**
 * box_status.entry_alerts — whole-object, both levels, because both schemas are CLOSED.
 *
 * Asserted rather than curated because of what this surface is FOR. It exists because a deployment
 * reported `UNKNOWN_INTERNAL_ERROR: 354` for what was actually a spent session budget, so the fields
 * that must never drift are `category` (an exhaustive union the badge and the panel both switch on)
 * and `actionable` (the backend's own verdict on urgency, which the UI must not re-derive). If the
 * backend added a fifth category, a curated assertion would let the panel fall through to an
 * unstyled, unbadged row for a class of problem nobody had considered — reintroducing, in the very
 * feature built to prevent it, the silence that caused the original bug. This breaks compilation
 * instead.
 *
 * `count` and `dropped_groups` are likewise load-bearing: a truncated list that renders as a complete
 * one would be a new way of misleading an operator about how much is being refused.
 */
type _EntryAlert = Assert<MutuallyAssignable<EntryAlertContract, EntryAlert>>;
type _EntryAlerts = Assert<MutuallyAssignable<EntryAlertsContract, EntryAlerts>>;

/**
 * GET /api/box/universe — whole-object, both levels, because both schemas are CLOSED.
 *
 * Asserted rather than curated for the same reason as the blocklist: this is the surface an operator
 * screens the universe from before arming, and the two fields whose meaning must not drift are
 * `admissible` and `inadmissible_reason`. If the backend ever renamed an inadmissibility code, a
 * curated assertion would let the picker fall through to "no reason given" on a name that can never
 * trade — silence exactly where an explanation is the whole point. This breaks compilation instead.
 */
type _UniverseUnderlying = Assert<
  MutuallyAssignable<UniverseUnderlyingContract, UniverseUnderlying>
>;
type _BoxUniverse = Assert<MutuallyAssignable<BoxUniverseContract, BoxUniverse>>;

// GET /api/box/config — the closed entry-gate economics scalars (excludes the frontend-
// optional `tunable`, and the frontend-narrowed `execution_mode` enum vs schema `string`).
type _BoxConfigFields = Assert<
  MutuallyAssignable<
    Pick<
      BoxConfigContract,
      "min_expected_net_profit" | "min_gross_edge" | "min_net_edge" | "simulated_decision_ms"
      | "simulated_latency_ms" | "expected_entry_slippage" | "expected_exit_slippage"
      | "enable_short_box" | "directions" | "min_captured_pct" | "reconcile_charges"
      | "charge_reconcile_warn_pct" | "require_priced_charges" | "safety_buffer" | "quote_max_age_ms"
      | "feed_max_age_ms" | "underlying_max_age_ms" | "strikes_each_side" | "strike_level"
      | "max_strikes" | "max_candidates_per_underlying" | "prefilter_gross_threshold"
      | "convergence_floor" | "convergence_pct" | "min_exit_net_pnl" | "profit_capture_pct"
      | "expiry_safety_minutes" | "max_subscribed_tokens" | "lots" | "universe"
    >,
    Pick<
      BoxConfigView,
      "min_expected_net_profit" | "min_gross_edge" | "min_net_edge" | "simulated_decision_ms"
      | "simulated_latency_ms" | "expected_entry_slippage" | "expected_exit_slippage"
      | "enable_short_box" | "directions" | "min_captured_pct" | "reconcile_charges"
      | "charge_reconcile_warn_pct" | "require_priced_charges" | "safety_buffer" | "quote_max_age_ms"
      | "feed_max_age_ms" | "underlying_max_age_ms" | "strikes_each_side" | "strike_level"
      | "max_strikes" | "max_candidates_per_underlying" | "prefilter_gross_threshold"
      | "convergence_floor" | "convergence_pct" | "min_exit_net_pnl" | "profit_capture_pct"
      | "expiry_safety_minutes" | "max_subscribed_tokens" | "lots" | "universe"
    >
  >
>;

// GET /api/box/execution-control — the closed safety-surface scalars.
type _BoxExecControlFields = Assert<
  MutuallyAssignable<
    Pick<
      BoxExecutionControlContract,
      "broker" | "deployment_live_capable" | "live_capability_detail" | "live_runtime_armed"
      | "entry_enabled" | "emergency_flatten_enabled" | "block_reason" | "block_detail"
    >,
    Pick<
      BoxExecutionControl,
      "broker" | "deployment_live_capable" | "live_capability_detail" | "live_runtime_armed"
      | "entry_enabled" | "emergency_flatten_enabled" | "block_reason" | "block_detail"
    >
  >
>;

// GET /api/box/opportunities element — the closed economics/identity fields (excludes the
// `legs` leg-evaluation array, which the schema pins with nullable prices the frontend narrows).
type _BoxOpportunityFields = Assert<
  MutuallyAssignable<
    Pick<
      BoxOpportunityContract,
      "key" | "underlying" | "name" | "is_index" | "expiry" | "direction" | "lower_strike"
      | "upper_strike" | "box_width" | "lot_size" | "quantity" | "entry_box_cost" | "gross_edge"
      | "entry_charges" | "estimated_exit_charges" | "execution_cost" | "safety_buffer"
      | "projected_net_edge" | "expected_net_profit" | "min_expected_net_profit" | "liquidity_ok"
      | "depth_ok" | "worst_age_ms" | "price_source" | "updated_at"
    >,
    Pick<
      BoxOpportunity,
      "key" | "underlying" | "name" | "is_index" | "expiry" | "direction" | "lower_strike"
      | "upper_strike" | "box_width" | "lot_size" | "quantity" | "entry_box_cost" | "gross_edge"
      | "entry_charges" | "estimated_exit_charges" | "execution_cost" | "safety_buffer"
      | "projected_net_edge" | "expected_net_profit" | "min_expected_net_profit" | "liquidity_ok"
      | "depth_ok" | "worst_age_ms" | "price_source" | "updated_at"
    >
  >
>;

// GET /api/box/trades/open element — the closed identity/lifecycle scalars.
type _BoxOpenPositionFields = Assert<
  MutuallyAssignable<
    Pick<
      BoxOpenPositionContract,
      "id" | "key" | "underlying" | "name" | "is_index" | "expiry" | "direction" | "lower_strike"
      | "upper_strike" | "box_width" | "lot_size" | "quantity" | "opened_at" | "margin"
      | "safety_buffer" | "liquidity_ok" | "worst_age_ms" | "exit_eligible" | "expiry_safety"
      | "status"
    >,
    Pick<
      BoxOpenPosition,
      "id" | "key" | "underlying" | "name" | "is_index" | "expiry" | "direction" | "lower_strike"
      | "upper_strike" | "box_width" | "lot_size" | "quantity" | "opened_at" | "margin"
      | "safety_buffer" | "liquidity_ok" | "worst_age_ms" | "exit_eligible" | "expiry_safety"
      | "status"
    >
  >
>;

/* Reference every assertion so `noUnusedLocals` keeps them, and force the compiler to hold
 * all of them at once. All are `true` by construction; any drift turns one into a non-`true`
 * and this alias becomes a compile error. */
export type __ContractAssertProof = [
  _SwitchBlockers,
  _BrokerHealth,
  _BrokerRuntime,
  _RuntimeStatus,
  // SECTION 7 / contract v1.6.0 — the ONE readiness decision and its blocker element.
  _ReadinessBlocker,
  _OperationalReadiness,
  _ArmVerdict,
  _ExportStatus,
  _BrokerSession,
  _BrokerStatus,
  // contract v1.10.0 — the in-app broker login surface.
  _BrokerLoginStart,
  _BrokerLogout,
  _AccessVerify,
  _AccessStatus,
  _AccessAuthBranch,
  _BoxStatusFields,
  // contract v1.20.0 — the rolling metrics the execution-health panel renders from, no longer an
  // open leaf. These four are what make a backend rename a COMPILE error instead of a blank panel.
  _BoxMetricsExecutionScalars,
  _BoxMetricsLeggingScalars,
  _BoxMetricsLeggingOutcomes,
  _BoxMetricsRings,
  _BoxMetricsLeggingRings,
  // contract v1.13.0 — the operator blocklist of underlyings that may never be entered.
  _BoxExcludedUnderlyings,
  // contract v1.17.0 — free capital, published continuously rather than per entry attempt.
  _AccountFunds,
  // contract v1.18.0 — which underlying was refused, and why.
  _EntryAlert,
  _EntryAlerts,
  // contract v1.15.0 — the pre-run universe picker.
  _UniverseUnderlying,
  _BoxUniverse,
  _BoxConfigFields,
  _BoxExecControlFields,
  _BoxOpportunityFields,
  _BoxOpenPositionFields,
  // contract v1.22.0 — the emergency-flatten result. The route previously answered a hardcoded
  // `ok: true` over an untyped `results` array, so there was nothing for the compiler to check and a
  // per-position failure had no place to be reported. Asserting the UI's hand-typed shape against the
  // generated one makes a backend rename a COMPILE error rather than a silently missing reason.
  _BoxFlattenResultFields,
  _BoxFlattenItemFields,
];

/*
 * contract v1.22.0 — POST /api/box/live/flatten.
 *
 * The route used to answer `{ ok: true, ... }` as a LITERAL over `results: unknown[]`, with no schema at
 * all, so per-position and per-residual failures were unrepresentable and the UI's green toast was
 * unfalsifiable. These assertions tie the fields the panel actually reads to the generated contract, so
 * a backend rename or retype becomes a compile error here instead of a reason that silently stops being
 * displayed.
 *
 * `remaining_quantity` is included deliberately: its `number | null` is load-bearing, because null means
 * UNKNOWN and must never be rendered as zero.
 */
type _BoxFlattenResultFields = Assert<
  MutuallyAssignable<
    Pick<
      BoxFlattenResultContract,
      "ok" | "requested" | "attempted" | "outcome" | "remaining_exposure_known"
      | "remaining_quantity" | "blockers" | "next_action" | "settlement"
    >,
    Pick<
      Awaited<ReturnType<typeof flattenAttributedBoxExposure>>,
      "ok" | "requested" | "attempted" | "outcome" | "remaining_exposure_known"
      | "remaining_quantity" | "blockers" | "next_action" | "settlement"
    >
  >
>;

type _BoxFlattenItemFields = Assert<MutuallyAssignable<BoxFlattenItemContract, BoxFlattenItem>>;

/** A single inert value so the module has a runtime export; carries no data. */
export const __contractAssertsHold = true as const;