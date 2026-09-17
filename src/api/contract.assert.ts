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
import type {
  AccessStatusContract,
  AccessVerifyContract,
  ArmVerdictContract,
  BoxExecutionControlContract,
  OperationalReadinessContract,
  ReadinessBlockerContract,
  BoxOpenPositionContract,
  BoxOpportunityContract,
  BoxStatusContract,
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
      | "feed_age_ms" | "skipped_for_budget" | "skipped_symbols" | "last_error" | "market_data_state"
    >,
    Pick<
      BoxStatus,
      "running" | "monitoring" | "market_open" | "authenticated" | "db_enabled" | "hub_connected"
      | "feed_healthy" | "quotes" | "quote_updates" | "underlyings" | "candidates"
      | "monitored_tokens" | "hub_subscribed" | "strike_level" | "open_positions" | "started_at"
      | "stopped_at" | "universe_built_at" | "subscribed_option_tokens" | "subscribed_spot_tokens"
      | "feed_age_ms" | "skipped_for_budget" | "skipped_symbols" | "last_error" | "market_data_state"
    >
  >
>;

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
  _BoxConfigFields,
  _BoxExecControlFields,
  _BoxOpportunityFields,
  _BoxOpenPositionFields,
];

/** A single inert value so the module has a runtime export; carries no data. */
export const __contractAssertsHold = true as const;
