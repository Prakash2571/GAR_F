/**
 * Backend response types.
 *
 * Covers the Box and broker surfaces only, and kept PURE — no browser globals, no fetch — so
 * `node:test` can import this file directly under Node 22's native type-stripping.
 *
 * ── ON IDENTIFIERS ──────────────────────────────────────────────────────────────────
 * Every `id` / `*_id` here is an OPAQUE STRING. The authoritative store is PostgreSQL with
 * MongoDB as an async reporting replica, so an id is whatever the backend minted — it is NOT
 * a Mongo ObjectId, NOT a UUID, and NOT parseable. The UI treats ids as equality-comparable
 * opaque tokens and nothing more.
 */

/* ============================ shared charge shapes ============================ */

/** One order's charges from the broker's virtual contract note. */
export interface TradeLegCharges {
  side: "BUY" | "SELL";
  tradingsymbol: string;
  quantity: number;
  price: number;
  value: number;
  brokerage: number;
  stt: number;
  stt_type: string;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
}

/**
 * Charges for one side of a trade (both legs), as billed by the active broker.
 *
 * `source` records WHICH broker priced it: Zerodha's and Dhan's fee schedules differ, so a
 * Dhan trade's costs must never be shown as if Zerodha priced them. `*_estimate` means the
 * charge was projected rather than confirmed against a real contract note.
 */
export interface TradeCharges {
  legs: TradeLegCharges[];
  value: number;
  brokerage: number;
  stt: number;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
  source: "kite" | "kite_estimate" | "dhan" | "dhan_estimate";
  at: string;
}

/* ================================ Box vocabulary ============================== */

export type BoxLegRole = "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe";
export type BoxSide = "BUY" | "SELL";
export type BoxExitReason =
  | "EDGE_CONVERGED"
  | "PROFIT_CAPTURE"
  | "MANUAL"
  | "EXPIRY_SAFETY";

/** Why a candidate was not eligible for an automatic paper entry. */
export type BoxRejectReason =
  | "no_quote"
  | "stale_quote"
  | "missing_bid"
  | "missing_ask"
  | "insufficient_qty"
  | "below_gross_prefilter"
  | "below_net_edge"
  | "below_expected_net_profit"
  | "execution_failed"
  | "unpriced_charges"
  | "duplicate_open"
  | "stale_underlying"
  | "market_closed"
  | "implausible_close";

/** Which way a box is traded. Absent on old data means a long box. */
export type BoxDirection = "LONG_BOX" | "SHORT_BOX";

/** How an entry is executed: three paper models, or real broker orders. */
export type BoxExecutionMode = "paper_touch" | "paper_latency" | "paper_legging" | "live";

/**
 * Which broker a record belongs to.
 *
 * Only ONE broker is ever active for new trades, but history from both coexists, so every
 * trade carries its own. Absent on data written before broker identity existed, which means
 * Zerodha — the only broker the app originally had.
 */
export type BrokerId = "zerodha" | "dhan";

/**
 * Where a charge figure came from.
 *
 * The `dhan` values exist because Dhan's brokerage differs from Zerodha's: a Dhan trade's
 * costs must never be displayed as if Zerodha had priced them.
 */
export type BoxChargeOrigin =
  | "local"
  | "kite"
  | "local_verified"
  | "dhan"
  | "dhan_estimate";

/** Per-leg liquidity/freshness detail behind an opportunity. */
export interface BoxLegEvaluation {
  role: BoxLegRole;
  side: BoxSide;
  token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "CE" | "PE";
  /** Executable price for this side: ask for BUY, bid for SELL. */
  price: number | null;
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  quote_at: number | null;
  age_ms: number | null;
  fresh: boolean;
  executable: boolean;
}

export type BoxOpportunityStatus =
  | "WATCHING"
  | "INDICATIVE"
  | "UNPRICED"
  | "ELIGIBLE"
  | "PAPER_OPENED"
  | "OPEN"
  | "REJECTED";

export interface BoxOpportunity {
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;
  direction: BoxDirection;
  entry_box_cost: number | null;
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  execution_cost: number;
  safety_buffer: number;
  projected_net_edge: number | null;
  expected_net_profit: number | null;
  min_expected_net_profit: number;
  charge_origin: BoxChargeOrigin;
  entry_sides: { role: BoxLegRole; side: BoxSide; tradingsymbol: string }[];
  liquidity_ok: boolean;
  depth_ok: boolean;
  worst_age_ms: number | null;
  price_source: "touch" | "last_close";
  status: BoxOpportunityStatus;
  reject: BoxRejectReason | null;
  legs: BoxLegEvaluation[];
  updated_at: number;
}

export interface BoxConfigView {
  min_expected_net_profit: number;
  min_gross_edge: number;
  min_net_edge: number;
  execution_mode: BoxExecutionMode;
  simulated_decision_ms: number;
  simulated_latency_ms: number;
  expected_entry_slippage: number;
  expected_exit_slippage: number;
  enable_short_box: boolean;
  directions: BoxDirection[];
  min_captured_pct: number;
  reconcile_charges: boolean;
  charge_reconcile_warn_pct: number;
  require_priced_charges: boolean;
  safety_buffer: number;
  quote_max_age_ms: number;
  feed_max_age_ms: number;
  underlying_max_age_ms: number;
  strikes_each_side: number;
  strike_level: number;
  max_strikes: number;
  max_candidates_per_underlying: number;
  prefilter_gross_threshold: number;
  convergence_floor: number;
  convergence_pct: number;
  min_exit_net_pnl: number;
  profit_capture_pct: number;
  expiry_safety_minutes: number;
  max_subscribed_tokens: number;
  lots: number;
  universe: string;
  leg_execution_mode?: "parallel" | "sequential";
  leg_timeout_ms?: number;
  exit_use_realisable_net?: boolean;
  indicative_discovery?: boolean;
  closed_cache_enabled?: boolean;
  tunable?: {
    min_expected_net_profit: { min: number; max: number };
    safety_buffer: { min: number; max: number };
  };
}

/**
 * ORDER-UPDATE STREAM STATUS, as published inside GET /api/box/status.
 *
 * Mirrors `order-stream-status.schema.json` (contract v1.3.0) and
 * `src/box/orderStreamStatus.ts` in the backend. Its whole purpose is to keep two questions
 * apart that a dashboard naturally conflates:
 *
 *   "are ticks arriving?"        → market-data health
 *   "will I see a fill quickly?" → THIS
 *
 * `fills_observed_by` is the field a human should read. `rest_polling_only` means
 * fill-observation latency is bounded by the polling cadence and the broker pacing floor, not
 * by broker push latency — so no promptness should be assumed.
 *
 * `wiring` distinguishes four genuinely different situations, and `not_wired` is NOT the same
 * as "disabled by choice": it means the implementation exists and is tested but nothing is
 * consuming it, so it cannot deliver a fill however healthy the socket looks.
 *
 * NO SECRET APPEARS HERE. `gate_env_var` is a variable NAME only, never a value.
 */
/**
 * ORDER-UPDATE LIFECYCLE — the AUTHORITATIVE order-stream state (contract v1.6.0).
 *
 * Mirrors `OrderStreamLifecycleState` in the backend `src/box/streamHealthPolicy.ts`. This is the
 * value the backend's live-entry gate actually scores, and it is now published so the frontend
 * never has to infer it. Its absence was defect (a): the lifecycle could be `DEGRADED` while the
 * published `state` below said `LIVE`, so the dashboard advertised the fast fill path at the moment
 * entry was being refused for the opposite reason.
 */
export type OrderStreamLifecycle =
  | "DISABLED"
  | "CONNECTING"
  | "AUTHENTICATING"
  | "RECONCILING"
  | "READY"
  | "DEGRADED"
  | "DISCONNECTED"
  | "AUTH_EXPIRED";

export interface OrderStreamHealthSnapshot {
  /**
   * The PUBLISHED state, DERIVED by the backend from `lifecycle` below (see
   * `publishedStateForLifecycle` in src/box/orderStreamConsumer.ts), so the two cannot disagree.
   *
   * `DEGRADED` (v1.6.0) means connected but NOT delivering while a fill is expected.
   * `AUTH_EXPIRED` (v1.6.0) is distinct from `DOWN`: reconnecting with a rejected credential is
   * pointless, so it must not be rendered as a transient drop.
   */
  state:
    | "DISABLED"
    | "DOWN"
    | "CONNECTING"
    | "LIVE"
    | "DEGRADED"
    | "RECONNECTED_PENDING_RECONCILE"
    | "AUTH_EXPIRED";
  connected: boolean;
  authorised: boolean;
  lastEventAt: number | null;
  disconnects: number;
  reconcilePending: boolean;
  detail: string;
  /** The single lifecycle authority `state` was derived from, carried verbatim. */
  lifecycle: OrderStreamLifecycle;
}

export interface OrderStreamBrokerStatus {
  broker: BrokerId;
  /**
   * `not_applicable_paper` — this deployment SIMULATES execution, so no order is sent to the broker
   * and the broker has no order to report on. A paper backend constructs no order-stream consumer
   * BY DESIGN (building one implies a live order manager). This must render as inactive / not
   * applicable, NEVER as broken: before this value existed, paper fell through to `not_wired`,
   * whose documented meaning is "this should be running and is not", so every paper deployment
   * permanently showed a broken fast fill path that was never meant to exist.
   */
  wiring: "not_built" | "not_wired" | "gated_off" | "armed" | "not_applicable_paper";
  /** Variable NAME only — never a value. */
  gate_env_var: string;
  gate_enabled: boolean;
  health: OrderStreamHealthSnapshot | null;
  /**
   * The AUTHORITATIVE lifecycle that decided `fills_observed_by`, or null when nothing consumes
   * the stream. Published next to the mechanism so the operator can see both were decided from the
   * SAME state rather than from two holders that drifted apart.
   */
  lifecycle: OrderStreamLifecycle | null;
  /**
   * `simulated_paper_fills` — the backend's LOCAL execution simulator produces the fill against
   * real streamed quotes. A broker cannot emit an order-update event for an order it never
   * received, so rendering paper fills as "REST polling only" was not a conservative
   * understatement but false: it implied a broker round trip and a fill confirmation that do not
   * exist. Render this as "Simulated fills".
   */
  fills_observed_by:
    | "rest_polling_only"
    | "stream_primary_rest_reconcile"
    | "simulated_paper_fills";
  detail: string;
}

export interface OrderStreamStatus {
  any_stream_live: boolean;
  /** Always true. The payload itself tells the UI not to conflate the two health signals. */
  market_data_health_is_not_order_stream_health: true;
  brokers: OrderStreamBrokerStatus[];
}

/**
 * How the instrument master load stands. Four states, not a boolean.
 *
 * `loading` and `never_attempted` used to be indistinguishable from `failed`, and they are the two
 * where the correct action is to WAIT rather than investigate.
 */
export type InstrumentLoadState = "never_attempted" | "loading" | "loaded" | "failed";

/**
 * The FIRST unsatisfied stage of the universe → evaluation pipeline.
 *
 * Ordered as the pipeline runs, so exactly one blocker is ever reported: everything after the first
 * failure is unreachable. `evaluating` is the only value meaning the scanner is genuinely working on
 * real books.
 */
export type UniverseStage =
  | "scanner_stopped"
  | "not_authenticated"
  | "instruments_never_loaded"
  | "instruments_loading"
  | "instruments_failed"
  | "instruments_empty"
  | "no_board_rows"
  | "no_option_chains"
  | "no_board_chain_overlap"
  | "awaiting_spot_prices"
  | "no_windows_built"
  | "no_candidates"
  | "no_desired_subscriptions"
  | "box_socket_disconnected"
  | "awaiting_first_tick"
  | "awaiting_usable_depth"
  | "evaluating";

/** The universe pipeline diagnosis. Source: backend `src/box/universeReadiness.ts`. */
export interface UniverseReadiness {
  /**
   * Whether the engine can evaluate a candidate against real current-generation books.
   *
   * DELIBERATELY NOT the same as `running`. The operator's intent and the engine's capability are
   * different facts, and rendering only the former is what let `SCANNING` sit above zero underlyings.
   */
  readyToEvaluate: boolean;
  stage: UniverseStage;
  /** Backend-authored plain language. Render VERBATIM; the backend is the authority. */
  detail: string;
  /** True when the correct action is to WAIT rather than investigate. */
  transient: boolean;
  counts: {
    instruments: number;
    board_rows: number;
    chains_indexed: number;
    board_with_chains: number;
    underlyings_missing_spot: number;
    windows_built: number;
    candidates: number;
    desired_option_subscriptions: number;
    frames_observed: number;
    depth_observations: number;
    usable_books: number;
  };
  instrument_load: InstrumentLoadState;
  instruments_error: string | null;
  instruments_loaded_at: number | null;
  instrument_load_failures: number;
  spot_seed_failed: boolean;
  spot_seed_error: string | null;
  last_successful_build_at: number | null;
  /**
   * A subscribe frame was WRITTEN. NOT a broker acknowledgement — Zerodha sends none, so this must
   * never be rendered as "confirmed by the broker". `counts.depth_observations` is the confirmation.
   */
  subscriptions_requested: boolean;
  box_socket_connected: boolean;
}

/**
 * MARKET-DATA TRANSPORT STATE, distinct from BOTH order-stream health AND the crude
 * `market_data_healthy` boolean.
 *
 * Mirrors `MarketDataState` in the backend `src/box/streamHealthPolicy.ts`, pinned in
 * `box-status.schema.json` (contract v1.5.0). `READY` is the ONLY state that asserts usable
 * data, and it is deliberately expensive to reach: connected AND authenticated AND
 * subscriptions confirmed AND fresh usable depth observed for the traded instruments IN THE
 * CURRENT connection generation. A socket that has merely opened is NOT `READY`.
 *
 * The reconnect-and-recover states (`CONNECTING`/`AUTHENTICATING`/`SYNCHRONIZING`) and
 * `DEGRADED` are the "paused entry, positions still manageable" band; `DISCONNECTED` /
 * `AUTH_EXPIRED` are the broken band. The UI must render these two bands visibly differently.
 */
export type MarketDataState =
  | "DISABLED"
  | "CONNECTING"
  | "AUTHENTICATING"
  | "SYNCHRONIZING"
  | "READY"
  | "DEGRADED"
  | "DISCONNECTED"
  | "AUTH_EXPIRED";

/**
 * MARKET-DATA STATE-MACHINE DIAGNOSTICS — the four DISTINCT time facts kept apart.
 *
 * Mirrors `MarketDataStateMachine.diagnostics()` in the backend. The schema pins this leaf as an
 * OPEN object (presence + object-ness), so this hand-written shape is a deliberate SUPERSET the
 * dashboard reads — it is NOT asserted whole-object against the generated `Record<string, never>`.
 *
 * `generation` advances on every (re)authentication; a book observed under a superseded socket is
 * not evidence for the new one. `readyInstruments` of `desired` is the per-instrument readiness
 * gauge — "the feed is up" says nothing about whether the four specific legs a box needs each have
 * a fresh usable book. `lastHeartbeatAt` (1-byte keep-alive), `lastFrameAt` (any inbound frame)
 * and `lastDepthAt` (a usable two-sided book) are three separate clocks, never substituted for one
 * another; `backlog` is the application-ingestion overload signal.
 */
/**
 * The driven market-data machine's diagnostics, as published in `box_status.market_data_health`.
 *
 * THIS TYPE WAS STALE AND THE UI SILENTLY SUFFERED FOR IT. It used to declare
 * `lastHeartbeatAt`/`lastFrameAt`/`lastDepthAt`, and the panel rendered them through a
 * timestamp-to-"ago" helper. The backend stopped publishing those three the moment ages began being
 * computed inside the monotonic domain that stamps them (raw monotonic timestamps are deliberately
 * no longer exported at all, so a caller cannot subtract a wall-clock `now` from them). Because
 * `market_data_health` is an OPEN leaf in the schema and this interface is hand-written, TypeScript
 * had nothing to object to — the fields were simply `undefined` at runtime and three stats rendered
 * "never observed" on a perfectly healthy feed.
 *
 * The lesson encoded here: ages arrive PRE-COMPUTED as durations, and the wall stamps beside them are
 * for display only. Never subtract one from the other.
 */
export interface MarketDataHealth {
  state: MarketDataState;
  generation: number;
  desired: number;
  confirmed: number;
  readyInstruments: number;
  backlog: boolean;
  /** Ages in ms, computed in the backend's MONOTONIC domain. `null` means NEVER OBSERVED. */
  heartbeatAgeMs: number | null;
  frameAgeMs: number | null;
  depthAgeMs: number | null;
  /** Wall-clock (epoch ms) stamps for display only. `null` means never observed. */
  lastHeartbeatWallAt: number | null;
  lastFrameWallAt: number | null;
  lastDepthWallAt: number | null;
  /** Evidence counters — what separates "connected" from "actually delivering". */
  heartbeats: number;
  frames: number;
  depthObservations: number;
  /** Coverage over the desired set. Reported, and deliberately NOT a gate. */
  coverageDesired: number;
  coverageFresh: number;
  coverageMissing: number;
  transportLive: boolean;
  /** The bounds the backend is enforcing, so the UI states the real thresholds. */
  bookMaxAgeMs: number;
  heartbeatMaxAgeMs: number;
}

/** One denominator-carrying funnel ratio. `rate` is null (never 0) when the denominator is 0. */
export interface FunnelRatio {
  numerator: number;
  denominator: number;
  rate: number | null;
  /** Plain-language statement of the denominator, carried verbatim from the backend. */
  basis: string;
}

/**
 * THE EXECUTION FUNNEL — outcome counts with EXPLICIT denominators.
 *
 * Mirrors `ExecutionFunnel.snapshot()` in the backend `src/box/executionFunnel.ts`. The schema
 * pins this leaf as an OPEN object, so this shape is a deliberate SUPERSET the dashboard reads.
 *
 * The chain is strictly nested (each a subset of the one above): candidates_evaluated ⊇
 * qualified_opportunities ⊇ attempts_admitted ⊇ attempts_submitted ⊇ four_leg_completed_entries.
 * EXECUTION completion (did four legs get built) and ECONOMIC outcome (did we make money after
 * ALL costs including recovery) are independent and BOTH published — neither hides the other.
 * Zero-POST refusals, submitted failures, unresolved exposure and recovery costs are all carried
 * so a displayed success rate can never be inflated by hiding them.
 */
export interface ExecutionFunnelSnapshot {
  candidates_evaluated: number;
  qualified_opportunities: number;
  attempts_admitted: number;
  attempts_submitted: number;
  four_leg_completed_entries: number;
  zero_post_refusals: number;
  zero_post_by_reason: Record<string, number>;
  submitted_failures: number;
  submitted_failures_by_reason: Record<string, number>;
  no_fill_cancellations: number;
  partial_entry_recoveries: number;
  /** Exposure outstanding RIGHT NOW — a live gauge, not a cumulative count. */
  unresolved_exposure_open: number;
  /** Every attempt that ever ended holding unresolved exposure (cumulative). */
  unresolved_exposure_total: number;
  completed_exits: number;
  /** Realised net P&L (₹) after ALL costs, including recovery/unwind. */
  realised_net_pnl: number;
  /** Recovery/unwind charges (₹) INSIDE the figure above, shown so they cannot be hidden. */
  recovery_costs_included: number;
  economically_profitable: number;
  economically_unprofitable: number;
  ratios: {
    admission_rate: FunnelRatio;
    submission_rate: FunnelRatio;
    execution_completion_rate: FunnelRatio;
    economic_success_rate: FunnelRatio;
    unresolved_exposure_rate: FunnelRatio;
  };
}

/** Provenance of an economic figure — whether a number is broker-confirmed, estimated, stale or absent. */
export type EconomicProvenance =
  | "broker_confirmed"
  | "estimate"
  | "stale"
  | "unavailable";

/**
 * ONE of the five economic quantities, with provenance and freshness.
 *
 * `value_rupees` is a rupee amount (₹), never conflated across quantities. `usable` is true ONLY
 * when the provenance is broker-confirmed AND within the freshness bound; a stale or estimated
 * figure is shown but must not be read as authority. `note` states exactly what the figure can
 * and cannot prove — carried verbatim.
 */
export interface EconomicFigure {
  value_rupees: number | null;
  provenance: EconomicProvenance;
  observed_at: number | null;
  age_ms: number | null;
  usable: boolean;
  note: string;
}

/**
 * THE ECONOMIC PICTURE — five DISTINCT quantities, never collapsed into one "capital" number.
 *
 * GROSS NOTIONAL (#4) and PLANNED MARGIN (#2) are different quantities and must never be conflated
 * or silently relabelled: gross notional is the total option-order value; planned margin is the
 * broker's netted requirement (much smaller for a hedged box). Peak legging exposure (#3) and
 * worst-case entry cost (#5) are separate again. Each is labelled by its own field.
 */
export interface EconomicPicture {
  /** #1 Available broker funds. */
  available_funds: EconomicFigure;
  /** #2 Margin required by the planned execution sequence (broker basket estimate). */
  planned_margin: EconomicFigure;
  /** #3 Peak temporary exposure during the legging window. */
  peak_legging_exposure: EconomicFigure;
  /** #4 Gross order notional — the total option-order value, NOT the margin. */
  gross_notional: EconomicFigure;
  /** #5 Bounded worst-case entry cost. */
  worst_case_entry: EconomicFigure;
  /** The underlying gross-notional metric object (engine-owned; presence only). */
  gross_notional_metrics?: Record<string, unknown>;
}

/**
 * Why an economic admission was refused. Distinct, non-conflated reasons.
 *
 * MIRRORS `EconomicRefusalReason` in the backend `src/box/boxCapital.ts` — ALL EIGHT of them.
 * This union previously listed only four, which was a silent drift: the backend has emitted
 * `margin_evidence_invalid`, `funds_evidence_invalid`, `funding_stage_unknown` and
 * `hedge_sequence_invalid` for some time.
 *
 * Nothing was VISIBLY broken by the gap, and that is worth stating precisely so the fix is not
 * mistaken for a bug fix: `BoxOperationalState` renders reasons generically
 * (`r.replace(/_/g, " ")`) and the contract assertions do not enumerate this field, so an
 * unlisted reason still displayed and was never rejected at runtime. The gap was a TYPE hazard —
 * any code that switches on a reason, or maps reasons to operator-facing copy, would have been
 * type-checked against an incomplete set and silently missed four cases.
 *
 * `funding_stage_unknown` is the one that now matters most in practice. It is what the supervised
 * Mumbai trial profile reports when the active broker cannot supply a defensible
 * EXECUTION-STAGE funding requirement — which is the documented, intended state for Dhan, whose
 * API publishes no field meaning "margin required to execute the orders". An operator seeing it
 * is being told the gate is working, not that something is misconfigured.
 */
export type EconomicRefusalReason =
  | "gross_notional_over_cap"
  | "insufficient_available_funds"
  | "margin_evidence_stale_or_missing"
  /** The margin figure was present but structurally unusable (non-finite, negative, wrong shape). */
  | "margin_evidence_invalid"
  /** The available-funds figure was present but structurally unusable. */
  | "funds_evidence_invalid"
  /**
   * No defensible funding requirement could be established for an INTERMEDIATE point of the
   * four-leg entry sequence. While hedges are still going out the completed-basket spread benefit
   * does not exist yet, so the FINAL hedged margin is not evidence for the stages that create the
   * box. Refusing is the honest answer; gross option premium does not bound a short-option margin.
   */
  | "funding_stage_unknown"
  /** The planned transport order was not hedge-first (a SELL would precede its protecting BUY). */
  | "hedge_sequence_invalid"
  | "metric_incomplete";

/**
 * THE ECONOMIC-ADMISSION DECISION — the last decision the economic gate made, or null when no
 * economic control is enabled.
 *
 * Mirrors `EconomicAdmissionReport` in the backend `src/box/boxCapital.ts`. `controls` says which
 * controls were ENABLED (a control with no config is skipped — reporting it as "passed" would be a
 * lie). `reasons` lists EVERY failing control at once so an operator sees them all.
 */
export interface EconomicAdmission {
  allowed: boolean;
  reasons: EconomicRefusalReason[];
  detail: string | null;
  picture: EconomicPicture;
  controls: {
    gross_cap_enabled: boolean;
    funds_check_enabled: boolean;
    margin_evidence_required: boolean;
  };
}

/**
 * ONE NAMED REASON something is not permitted (contract v1.6.0).
 *
 * `scope` is the field that carries the invariant: an `entry`-scoped blocker may stop creating NEW
 * exposure and can NEVER be a reason a REDUCTION of exposure already owned is refused. The UI must
 * respect that separation when it renders — presenting an entry restriction next to an exit button
 * as though it applied to both is how an operator concludes a position is stuck when it is not.
 */
export interface ReadinessBlocker {
  /** Stable snake_case machine code, for keying and grouping. */
  code: string;
  scope: "entry" | "reduction" | "both";
  /** One bounded sentence, safe to display verbatim. */
  detail: string;
}

/**
 * THE ONE AUTHORITATIVE READINESS DECISION (contract v1.7.0) — `box_status.operational_readiness`.
 *
 * WHY THE FRONTEND MUST RENDER THIS AND NOT RECOMPUTE IT
 * Defect (b) was that this file's consumers derived entry permission from market-data readiness plus
 * a single reconcile flag — a SECOND permission matrix that missed most of the real blockers, and
 * which showed a green "New entry is permitted" while the backend was refusing every entry. The
 * backend now answers the question once, from the same permission table its live-entry checkpoint
 * enforces. Anything the UI computes for itself is a divergence waiting to happen.
 *
 * ORDERING (contract v1.7.0). `decision_generation` is monotonic per response but SCOPED TO
 * `instance.instance_id` — it is a process-local counter that resets on restart. Treating it as
 * globally monotonic is what left a browser holding generation 5000 rejecting a restarted backend's
 * generation 1 indefinitely, rendering a permission verdict from a process that no longer existed.
 * Decisions are ordered by the pair (`instance.boot_ordinal`, `decision_generation`); see
 * `lib/readinessOrder.ts`, which vendors the backend's own rule rather than reimplementing it.
 *
 * Mirrors `OperationalReadinessDecision` in the backend `src/box/operationalReadiness.ts`. The whole
 * object is CLOSED in the schema, so `contract.assert.ts` pins it whole-object — a rename, removal
 * or retype on either side fails `tsc -b`.
 */
export interface OperationalReadiness {
  /**
   * Monotonic per-decision counter, SCOPED TO `instance.instance_id`. Lower than what is on screen
   * FROM THE SAME INSTANCE ⇒ stale ⇒ ignore. Across instances it means nothing: it is process-local
   * and resets on restart, so `instance.boot_ordinal` is what orders decisions across one.
   */
  decision_generation: number;
  /**
   * WHICH backend process produced this decision, and where that process sits in the restart order.
   *
   * `boot_ordinal` is a restart-durable, strictly increasing integer minted by the backend's
   * PostgreSQL — not a clock (an NTP step or a snapshot restore would make an older instance look
   * newer) and not a random id (a random value cannot express "newer"). `null` means the backend
   * could not establish it, so the decision is UNORDERABLE: it must not overwrite an ordered decision
   * and new entry must be treated as disabled. The backend independently refuses entry in that state,
   * so this is defence in depth rather than the only guard.
   */
  instance: {
    instance_id: string | null;
    boot_ordinal: number | null;
    /** AUDIT ONLY. Never used for ordering. */
    started_at: number | null;
  };
  /** The decision shape's version. An unrecognised value must degrade to unknown, never to green. */
  decision_version: string;
  /** Wall-clock ms the decision was evaluated. */
  decided_at: number;
  identity: {
    broker: BrokerId | null;
    /** MASKED reference, e.g. "AB••34". Never the raw account id. */
    account_masked: string | null;
    /** Whether an account is bound at all — distinct from "the id is hidden". */
    account_present: boolean;
    execution_mode: string;
    live_runtime_armed: boolean;
    deployment_live_capable: boolean;
  };
  market_data: {
    state: MarketDataState;
    /** Feed/session generation. A book from a superseded socket is not evidence for the new one. */
    generation: number;
    desired_instruments: number;
    ready_instruments: number;
    backlog: boolean;
    usable_for_entry: boolean;

    /*
     * THE SIX DISTINCT FACTS THIS UI MUST NOT COLLAPSE.
     *
     * With only `state` available, "is the socket up?" and "is there executable depth?" could not be
     * told apart on screen. Each of these is separately observable, so the display can show exactly
     * how far along the chain the feed actually got.
     */
    /** Where quotes come from. `rest_snapshot_fallback` is a documented fallback, NOT executable depth. */
    source: "broker_websocket" | "rest_snapshot_fallback" | "none";
    socket_connected: boolean;
    authenticated: boolean;
    subscriptions_requested: boolean;
    /** Instruments holding a currently usable executable book. */
    usable_books: number;
    /**
     * Whether ANY frame arrived in the current generation.
     *
     * THE ONLY field that licenses the "Real broker WebSocket quotes" label. An open socket alone
     * must never produce it.
     */
    ticks_observed: boolean;
    frames_observed: number;
    /** Keep-alives. Prove the socket is alive; prove NOTHING about any book's freshness. */
    heartbeats_observed: number;
    depth_observations: number;
  };
  order_stream: {
    lifecycle: OrderStreamLifecycle;
    published_state: OrderStreamHealthSnapshot["state"];
    wiring: OrderStreamBrokerStatus["wiring"];
    gate_enabled: boolean;
    connected: boolean;
    authorised: boolean;
    disconnects: number;
  };
  fill_observation: {
    mechanism: OrderStreamBrokerStatus["fills_observed_by"];
    stream_assisted: boolean;
    detail: string;
  };
  /**
   * HOW EXECUTION IS ACTUALLY PERFORMED, separate from any broker order stream.
   *
   * Present in every payload so the UI never has to decide whether an order-stream field applies.
   * When `simulated` is true, fills come from the backend's simulator and no broker confirmation
   * exists or is possible — a normal, healthy state, not a degraded one.
   */
  paper_execution: {
    simulated: boolean;
    /** The paper profile in force (e.g. `paper_latency`), or null under live. */
    profile: string | null;
    /** True only when depth has ACTUALLY been observed — never inferred from an open socket. */
    using_streamed_quotes: boolean;
    /** Backend-authored plain language. Render VERBATIM; the backend is the authority. */
    detail: string;
  };
  /** Ages of the evidence behind the decision. NULL = NEVER OBSERVED — must not render as 0. */
  evidence: {
    market_data_frame_age_ms: number | null;
    market_data_heartbeat_age_ms: number | null;
    market_data_depth_age_ms: number | null;
    order_stream_event_age_ms: number | null;
    /** WALL-CLOCK (epoch ms) stamps for display. NEVER the basis of an age. */
    market_data_last_frame_at: number | null;
    market_data_last_depth_at: number | null;
    /**
     * Which clock produced the market-data ages, so this UI can VERIFY the domains were not mixed
     * rather than trust that they were not. The backend defect this documents: monotonic stamps were
     * subtracted from a wall-clock `now`, producing ages of ~55 years that could only render as
     * garbage or as "never observed" — while ticks were in fact arriving normally.
     */
    market_data_age_clock: "monotonic";
  };
  reconciliation: {
    pending: boolean;
    blockers: ReadinessBlocker[];
  };
  /** NEW ENTRY. The UI must never present a permitted state while `permitted` is false. */
  entry: {
    permitted: boolean;
    reasons: ReadinessBlocker[];
  };
  /** REDUCING exposure, and its REAL limitations. `limitations` is contractually non-empty. */
  exposure_management: {
    exit_and_reduce: boolean;
    protective_cancel: boolean;
    manage_working_orders: boolean;
    blocked_reasons: ReadinessBlocker[];
    limitations: [string, ...string[]];
    open_positions: number;
    residual_legs: number;
    working_orders: number;
  };
}

/** One underlying the operator has forbidden new entry on. */
export interface ExcludedUnderlying {
  /** Uppercased and trimmed, as the board reports it (NIFTY, RELIANCE, M&M). */
  symbol: string;
  /** Bounded operator note, or null when none was recorded — never an empty string. */
  reason: string | null;
  /** The operator ROLE that excluded it. Never a token or session identifier. */
  excluded_by: string | null;
  excluded_at: number;
}

/**
 * GET /api/box/excluded-underlyings, and the `excluded_underlyings` block of GET /api/box/status.
 *
 * The load state is part of the contract on purpose. A blocklist that cannot be READ is not an empty
 * blocklist: `readable: false` REFUSES all new entry backend-side, so the UI must render it as the
 * reason nothing is trading rather than as "nothing is excluded".
 */
export interface BoxExcludedUnderlyings {
  /** False ⇒ the backend is refusing every new entry because it cannot confirm any name is allowed. */
  readable: boolean;
  /** False ⇒ no box persistence, so an exclusion cannot be stored and writes are refused. */
  persistent: boolean;
  load_state: "never_loaded" | "loaded" | "failed" | "unpersisted";
  error: string | null;
  max: number;
  /** Ordered by symbol. */
  excluded: ExcludedUnderlying[];
}

export interface BoxStatus {
  running: boolean;
  state: "SCANNING" | "MARKET_CLOSED" | "STOPPED";
  monitoring: boolean;
  market_open: boolean;
  indicative_at: number | null;
  indicative_priced: number;
  indicative_session_day: string | null;
  indicative_stale_legs: number;
  execution_mode: BoxExecutionMode;
  broker?: BrokerId;
  brokers_with_open_positions?: BrokerId[];
  authenticated: boolean;
  /**
   * ORDER-UPDATE STREAM STATUS — deliberately REQUIRED, not optional.
   *
   * Contract v1.3.0 pins this as a required property of box-status, and the backend always
   * emits it. Declaring it optional here would reproduce exactly the failure this file already
   * warns about further down: a shape that typechecks and passes tests while the panel stays
   * silently dark in production. A missing field must be a TYPE ERROR.
   *
   * This is NOT market-data health. A healthy tick feed is no evidence that fills are observed
   * promptly — Zerodha delivers order updates as text frames on the same socket that carries
   * binary ticks, and Dhan uses a separate order-update WebSocket.
   */
  order_stream: OrderStreamStatus;
  /**
   * MARKET-DATA transport state — REQUIRED (contract v1.5.0). This is the DRIVEN state machine
   * that gates NEW ENTRY on `READY`, distinct from both `order_stream` (fills) and the crude
   * `market_data_healthy`/`feed_healthy` booleans. Honesty rule #1: a live quote socket is not
   * evidence that fills are observed — the two are rendered separately.
   */
  market_data_state: MarketDataState;
  /** Market-data state-machine diagnostics: generation, per-instrument readiness, the four time facts, backlog. */
  market_data_health: MarketDataHealth;
  /**
   * THE ONE AUTHORITATIVE READINESS DECISION — REQUIRED (contract v1.6.0).
   *
   * Deliberately NOT optional, for the same reason `order_stream` is not: an optional field would
   * let the dashboard typecheck, build and pass its tests while silently rendering nothing — which
   * is how defect (b) survived. `market_data_state` and `order_stream` above are RAW FACTS; this is
   * the VERDICT. The UI renders this and does not recombine those facts into a second matrix.
   */
  operational_readiness: OperationalReadiness;
  /** The execution funnel — outcome counts with explicit denominators (execution vs economic, separately). */
  execution_funnel: ExecutionFunnelSnapshot;
  /** The last economic-admission decision (five distinct quantities), or null when no economic control is enabled. */
  economic_admission: EconomicAdmission | null;
  db_enabled: boolean;
  started_at: number | null;
  stopped_at: number | null;
  universe_built_at: number | null;
  underlyings: number;
  candidates: number;
  monitored_tokens: number;
  subscribed_option_tokens: number;
  subscribed_spot_tokens: number;
  hub_subscribed: number;
  /**
   * The SHARED/FUTURES board lane's socket.
   *
   * With `BOX_DEDICATED_MARKET_FEED=true` (the default) this is a DIFFERENT socket from the one
   * carrying box option depth, so it is NOT evidence that the box lane is connected. Rendering only
   * this field is why a connected board lane read as a healthy box feed while the box panel showed
   * zero frames. Use `box_lane_connected`.
   */
  hub_connected: boolean;
  /** The BOX lane's own socket — the one carrying the option depth this engine trades on. */
  box_lane_connected: boolean;
  /** True when the box lane is physically separate from the shared board feed. */
  box_lane_dedicated: boolean;
  /**
   * WHY THE SCANNER IS OR IS NOT EVALUATING.
   *
   * `underlyings` is `windows.size`, which is `0` both when the instrument master came back EMPTY
   * and when the market is merely quiet — they rendered identically, which is how a scanner with a
   * completely empty universe displayed SCANNING for a whole session. `stage` names the FIRST
   * unsatisfied stage of the real pipeline; `counts` republishes the figure behind each stage so the
   * verdict can be checked rather than trusted.
   */
  universe: UniverseReadiness;
  quotes: number;
  quote_updates: number;
  feed_age_ms: number | null;
  feed_healthy: boolean;
  exchange_lag_ms: {
    median_ms: number;
    p95_ms: number;
    last_ms: number;
    samples: number;
  } | null;
  strike_level: number;
  /**
   * The operator blocklist of underlyings that may never be ENTERED, in any execution mode.
   *
   * `readable: false` is the field that matters: it means the backend could not READ the durable
   * list, which refuses ALL new entry (readiness blocker `underlying_exclusions_unreadable`). Render
   * that as the REASON nothing is trading — never as an empty blocklist.
   */
  excluded_underlyings: BoxExcludedUnderlyings;
  open_positions: number;
  day_pnl?: BoxDayPnl;
  skipped_for_budget: number;
  skipped_symbols: string[];
  skipped_indicative_cap?: number;
  skipped_indicative_symbols?: string[];
  indicative_max_underlyings?: number;
  scanner: {
    ticksApplied: number;
    evaluations: number;
    prefilterPasses: number;
    qualifyAttempts: number;
    executionsAttempted: number;
    entriesOpened: number;
    rejectedStale: number;
    rejectedLiquidity: number;
    rejectedNetProfit: number;
    rejectedExecution: number;
    rejectedDuplicate: number;
    lastEvaluationAt: number | null;
    simulated_entries_attempted: number;
    simulated_entries_filled: number;
    simulated_entries_failed: number;
    active_execution_pipelines: number;
  };
  monitor: {
    cycles: number;
    exitsTriggered: number;
    exitsSkippedLiquidity: number;
    exitsFailedExecution?: number;
    lastCycleAt: number | null;
    running: boolean;
  };
  charges: { calls: number; hits: number; misses: number; failures: number; inFlight: number };
  reconciliation?: {
    queued: number;
    completed: number;
    failed: number;
    skipped: number;
    warnings: number;
    max_abs_diff: number;
    last_abs_diff: number | null;
    last_pct_diff: number | null;
    pending: number;
    in_flight: number;
    enabled: boolean;
    warn_pct: number;
  };
  metrics?: BoxMetricsSnapshot;
  last_error: string | null;
  config: BoxConfigView;
}

export interface BoxDayPnl {
  day: string;
  open_count: number;
  open_running_net_pnl: number;
  open_running_gross_pnl: number;
  closed_count: number;
  closed_realised_net_pnl: number;
  closed_realised_gross_pnl: number;
  total_net_pnl: number;
  total_gross_pnl: number;
  open_margin_used?: number;
  closed_margin_used?: number;
  /** @deprecated Identical to `cumulative_trade_margin`; kept for older dashboards. */
  total_margin_used?: number;
  cumulative_trade_margin?: number;
  peak_concurrent_margin?: number | null;
  margin_unknown_count?: number;
  cache_enabled: boolean;
  last_cached_at: string | null;
}

/** A rolling distribution summary from a bounded ring buffer. */
export interface RingSummary {
  samples: number;
  count: number;
  last: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface BoxMetricsSnapshot {
  execution: {
    attempted: number;
    completed: number;
    successful: number;
    partial_recovered: number;
    partial_unresolved: number;
    failed: number;
    aborted: number;
    retries: number;
    /** @deprecated Alias for `successful`, kept for older dashboards. */
    filled: number;
    failure_rate: number;
    success_rate: number;
    rejection_categories: Record<string, number>;
    /** @deprecated Alias for `rejection_categories`. */
    failures_by_reason: Record<string, number>;
    decision_deterioration: RingSummary | null;
    execution_slippage: RingSummary | null;
    /** @deprecated Legacy detection-touch comparison; prefer `execution_slippage`. */
    entry_slippage: RingSummary | null;
    exit_slippage: RingSummary | null;
    decision_to_fill_ms: RingSummary | null;
    qualification_to_fill_ms: RingSummary | null;
    latency: {
      detection_to_decision_ms: RingSummary | null;
      decision_to_order_send_ms: RingSummary | null;
      simulated_or_real_order_latency_ms: RingSummary | null;
      order_send_to_ack_ms: RingSummary | null;
      ack_to_fill_ms: RingSummary | null;
      detection_to_fill_ms: RingSummary | null;
    };
    terminal_conflicts: number;
  };
  latency: {
    receive_to_evaluation_ms: RingSummary | null;
    event_loop_lag_ms: RingSummary | null;
  };
  throughput: {
    evaluations_per_sec: number;
    ws_updates_per_sec: number;
    ticks_per_sec: number;
    evaluations_total: number;
    ws_updates_total: number;
  };
  charges: {
    reconciliations: number;
    failed_reconciliations: number;
    warnings: number;
    discrepancy_rupees: RingSummary | null;
    discrepancy_pct: RingSummary | null;
  };
  legging?: {
    outcomes: {
      "4_of_4": number;
      "3_of_4": number;
      "2_of_4": number;
      "1_of_4": number;
      "0_of_4": number;
      total: number;
      aborts: number;
    };
    fill_rate_4_of_4: number;
    failure_rate_3_of_4: number;
    failure_rate_2_of_4: number;
    failure_rate_1_of_4: number;
    legging_net_loss: RingSummary | null;
    first_to_last_fill_ms: RingSummary | null;
    most_failing_role: { role: string; count: number } | null;
    failing_roles: Record<string, number>;
    expected_vs_realised_net: RingSummary | null;
  };
}

/** A paper_legging execution attempt that did not open a box. */
export interface BoxExecutionAttempt {
  candidate_key: string;
  direction: BoxDirection;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  execution_mode: BoxExecutionMode;
  leg_execution_mode: "parallel" | "sequential" | null;
  detected_at: string;
  resolved_at: string;
  detected_gross_edge: number | null;
  expected_net_profit: number | null;
  filled_leg_count: number;
  failed_legs: string[];
  failure_reason: string | null;
  failure_detail: string | null;
  partial_entry_charges: number | null;
  unwind_charges: number | null;
  gross_abort_pnl: number | null;
  net_abort_pnl: number | null;
}

/** One live open box position with its current exit arithmetic. */
export interface BoxOpenPosition {
  /** OPAQUE string id — do not parse. */
  id: string;
  key: string;
  execution_mode: BoxExecutionMode;
  broker?: BrokerId;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  direction: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;
  opened_at: string;
  margin: number | null;
  /**
   * WHICH model produced `margin` — broker-specific margin provenance.
   *
   * `kite_basket` and `dhan_multi` are position-aware NETTED figures.
   * `dhan_per_leg_fallback` is a summed per-leg UPPER bound that materially over-states a
   * hedged four-leg Box, so it must never be read as a basket margin. `unavailable` means
   * a figure was requested and none obtained. `null` means the trade predates provenance
   * capture — deliberately distinct from `unavailable`.
   */
  margin_source?: "kite_basket" | "dhan_multi" | "dhan_per_leg_fallback" | "unavailable" | null;
  entry_box_cost: number;
  entry_gross_edge: number;
  entry_charges: number | null;
  estimated_exit_charges_at_entry: number | null;
  safety_buffer: number;
  entry_net_edge: number;
  expected_net_profit: number | null;
  entry_execution_cost: number | null;
  charge_origin: BoxChargeOrigin;
  entry_legs: {
    role: BoxLegRole;
    side: BoxSide;
    tradingsymbol: string;
    strike: number;
    instrument_type: "CE" | "PE";
    entry_price: number;
  }[];
  exit_legs: {
    role: BoxLegRole;
    side: BoxSide;
    tradingsymbol: string;
    price: number | null;
    bid: number;
    bid_qty: number;
    ask: number;
    ask_qty: number;
    age_ms: number | null;
    executable: boolean;
    fresh: boolean;
  }[];
  exit_box_value: number | null;
  gross_pnl: number | null;
  current_exit_charges: number | null;
  total_charges: number | null;
  net_pnl: number | null;
  realisable_net_pnl: number | null;
  estimated_execution_cost: number;
  remaining_edge: number | null;
  entry_edge: number;
  captured_edge: number | null;
  captured_pct: number | null;
  time_in_trade_ms: number | null;
  convergence_threshold: number;
  min_exit_net_pnl: number;
  profit_capture_target: number;
  min_captured_pct: number;
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  exit_eligible: boolean;
  exit_reason: BoxExitReason | null;
  exit_rule_reason: BoxExitReason | null;
  blocked_reason: string | null;
  exit_blocked_reason: string | null;
  expiry_safety: boolean;
  status: "open";
}

/** One leg of a persisted box trade. */
export interface BoxTradeLeg {
  role: BoxLegRole;
  token: number;
  tradingsymbol: string;
  exchange: string;
  strike: number;
  instrument_type: "CE" | "PE";
  side: BoxSide;
  entry_price: number;
  entry_bid: number;
  entry_bid_qty: number;
  entry_ask: number;
  entry_ask_qty: number;
  entry_quote_at: string | null;
  detected_price?: number | null;
  entry_slippage?: number | null;
  exit_price: number | null;
  exit_bid: number | null;
  exit_bid_qty: number | null;
  exit_ask: number | null;
  exit_ask_qty: number | null;
  exit_quote_at: string | null;
  exit_detected_price?: number | null;
  exit_slippage?: number | null;
}

/** The verdict of an asynchronous broker charge reconciliation. */
export interface BoxChargeReconciliation {
  status: "pending" | "verified" | "failed";
  local_total: number | null;
  reconciled_total: number | null;
  abs_diff: number | null;
  pct_diff: number | null;
  at: string | null;
  error: string | null;
}

/** A persisted box trade (open or closed). */
export interface BoxTrade {
  /** OPAQUE string id — do not parse. */
  id: string;
  execution_mode: BoxExecutionMode;
  broker?: BrokerId;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  direction: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  status: "open" | "closed" | "error";
  legs: BoxTradeLeg[];
  box_width: number;
  margin: number | null;
  /** Broker-specific margin provenance. See BoxOpenPosition.margin_source. */
  margin_source?: "kite_basket" | "dhan_multi" | "dhan_per_leg_fallback" | "unavailable" | null;
  entry_box_cost: number;
  entry_gross_edge: number;
  entry_charges: TradeCharges | null;
  estimated_exit_charges: TradeCharges | null;
  safety_buffer: number;
  entry_net_edge: number;
  expected_net_profit: number | null;
  entry_execution_cost: number | null;
  charge_origin: BoxChargeOrigin;
  entry_charge_reconciliation: BoxChargeReconciliation | null;
  exit_charge_reconciliation: BoxChargeReconciliation | null;
  opened_at: string;
  current_remaining_edge: number | null;
  current_captured_edge: number | null;
  current_captured_pct: number | null;
  exit_box_value: number | null;
  exit_charges: TradeCharges | null;
  gross_pnl: number | null;
  total_charges: number | null;
  net_pnl: number | null;
  realised_net_pnl?: number | null;
  closed_at: string | null;
  exit_reason: BoxExitReason | null;
  exit_blocked_reason: string | null;
  expiry_safety: boolean;
  error: string | null;
}

/** One side of a strike row in the ATM±3 box chain. */
export interface BoxChainSide {
  token: number;
  tradingsymbol: string;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  age_ms: number | null;
  marks: string[];
}

export interface BoxChain {
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lot_size: number;
  quantity: number;
  atm_strike: number;
  strike_step: number;
  spot: number;
  spot_age_ms: number;
  strikes: {
    strike: number;
    is_atm: boolean;
    ce: BoxChainSide | null;
    pe: BoxChainSide | null;
  }[];
}

export interface BoxChainSymbol {
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
}

/** Which tier of the backend's closed-trade store answered a history request. */
export type BoxHistorySource = "memory" | "postgres" | "none";

export interface BoxHistoryResponse {
  dbEnabled: boolean;
  trades: BoxTrade[];
  scope?: "today" | "all";
  source?: BoxHistorySource;
  day?: string;
  cacheEnabled?: boolean;
  lite?: boolean;
}

/** What the backend returns after a successful Box trade deletion. */
export interface BoxDeleteResult {
  /** OPAQUE string id of the removed trade. */
  deleted_id: string;
  status: BoxStatus;
  open: BoxOpenPosition[];
  closed_today: {
    trades: BoxTrade[];
    source?: BoxHistorySource;
    day?: string;
    lite?: boolean;
  };
}

/** The payload of a `snapshot` frame on the box stream. */
export interface BoxSnapshot {
  status: BoxStatus;
  opportunities: BoxOpportunity[];
  open_trades: BoxOpenPosition[];
}

/* ============================ Box execution control =========================== */

/** Which execution model is selected. `live` is not runtime-selectable. */
export type BoxExecutionSelection =
  | "paper_latency"
  | "paper_legging"
  | "paper_legging_live_parity"
  | "live";

export interface BoxExecutionBlocker {
  code: string;
  detail: string;
}

export type BoxSessionState =
  | "IDLE"
  | "ARMED"
  | "ENTRY_IN_PROGRESS"
  | "POSITION_OPEN"
  | "EXIT_IN_PROGRESS"
  | "COMPLETED"
  | "BLOCKED"
  | "RECOVERY";

export interface BoxSessionView {
  enforcing: boolean;
  write_failed: boolean;
  state: BoxSessionState;
  /** OPAQUE string id or null. */
  session_id: string | null;
  armed: boolean;
  armed_at: number | null;
  armed_by: string | null;
  max_completed_trades: number;
  completed_trades: number;
  consumed_cycles: number;
  remaining_trades: number | null;
  /** OPAQUE string id or null. */
  current_trade_id: string | null;
  in_flight_trade_ids: string[];
  aborted_attempts: number;
  /**
   * Entry attempts STARTED by this armed session, counted at ADMISSION before any broker POST — so a
   * failed or recovered attempt still spends budget.
   *
   * DISTINCT from `aborted_attempts`, which counts only attempts that ended with no Box and gates
   * nothing, and from `consumed_cycles`, which counts attempts that SUCCEEDED. This is the counter
   * that bounds RISK-TAKING: an attempt that submitted orders, partially filled and was then unwound
   * took real exposure and paid real charges, and under the cycle budget alone it was free.
   */
  entry_attempts: number;
  /** The arm-time attempt ceiling snapshot. 0 = unbounded (the control is off). */
  max_entry_attempts: number;
  /** Attempts still permitted, or null when the attempt bound is not configured for this session. */
  remaining_entry_attempts: number | null;
  arm_count: number;
  block_reason: string | null;
  readable: boolean;
}

export interface BoxActiveUnderlying {
  underlying: string;
  kinds: string[];
}

export interface BoxExecutionControl {
  execution_mode: "paper_touch" | "paper_latency" | "paper_legging" | "live";
  paper_execution_profile: "standard" | "live_parity" | "stress";
  broker: BrokerId;
  deployment_live_capable: boolean;
  live_capability_detail: string;
  live_runtime_armed: boolean;
  entry_enabled: boolean;
  emergency_flatten_enabled: boolean;
  mode: {
    selection: BoxExecutionSelection;
    label: string;
    runtime_selectable: BoxExecutionSelection[];
    live_requires_restart: boolean;
    transition_blockers: BoxExecutionBlocker[];
  };
  session: BoxSessionView;
  risk: {
    max_box_capital_rupees: number;
    max_box_capital_metric: string;
    paper_max_box_capital_rupees: number;
    max_box_capital_enforced: boolean;
    capital: {
      enabled: boolean;
      configured_max_rupees: number;
      last_calculated_rupees: number | null;
      last_stage: string | null;
      last_allowed: boolean | null;
      last_at: number | null;
    };
    one_active_box_per_underlying: boolean;
    active_underlyings: BoxActiveUnderlying[];
    claimed_underlyings: string[];
    /**
     * `BOX_LIVE_MAX_OPEN_BOXES`. LIVE ONLY, and read from a count refreshed only AFTER a position
     * exists — so it cannot refuse the second of two entries admitted in the same instant, and no
     * paper rehearsal exercises it. Prefer `max_open_boxes_all_modes` when reporting a guarantee.
     */
    max_open_boxes: number;
    /**
     * `BOX_MAX_OPEN_BOXES` — the MODE-INDEPENDENT inventory ceiling, enforced at admission in every
     * execution mode and before any exposure exists. 0 = unlimited.
     */
    max_open_boxes_all_modes: number;
    /**
     * What that ceiling currently counts: open positions + unresolved residual attempts + distinct
     * underlyings with unresolved order intents. May exceed `open_boxes` while a partial entry is
     * unresolved, because a half-filled box is still capital at risk.
     */
    box_inventory_held: number;
    open_boxes: number;
    residual_legs: number;
    daily_loss_limit: number;
    realised_pnl_today: number | null;
  };
  execution: {
    live_entry_submit_concurrency: number;
    max_concurrent_executions: number;
    effective_broker_min_interval_ms: number;
    effective_broker_order_min_interval_ms: number;
    broker_order_interval_floor_ms: number;
    broker_order_interval_source: string;
    broker_pacing_rationale: string;
    pacing_source_of_truth: "adapter" | "config_projection";
    four_leg_burst_pacing_budget_ms: number;
    entry_burst: {
      configured_entry_submit_concurrency: number;
      base_concurrency: number;
      peak_entry_submissions_in_flight: number;
      burst_slot_grants: number;
      base_in_flight: number;
      burst_in_flight: number;
      /** OPAQUE string id or null. */
      entry_attempt_in_flight: string | null;
    } | null;
    queued: number;
    in_flight: number;
    circuit: string;
    artificial_latency_applied_to_live: boolean;
    paper_only_simulated_decision_ms: number;
    paper_only_simulated_latency_ms: number;
  };
  arm: {
    preconditions: Record<string, boolean | number>;
    entry: { ok: boolean; blockers?: BoxExecutionBlocker[] };
    exposure_management: { ok: boolean; blockers?: BoxExecutionBlocker[] };
    emergency_flatten: { ok: boolean; blockers?: BoxExecutionBlocker[] };
  };
  block_reason: string | null;
  block_detail: string | null;
}

/** The verdict of a requested execution-mode change, WITHOUT applying it. */
export type BoxModeTransitionVerdict =
  | { outcome: "allowed"; from: BoxExecutionSelection; to: BoxExecutionSelection }
  | {
      outcome: "restart_required";
      from: BoxExecutionSelection;
      to: BoxExecutionSelection;
      detail: string;
      envChanges: string[];
      blockers: BoxExecutionBlocker[];
    }
  | {
      outcome: "refused";
      from: BoxExecutionSelection;
      to: BoxExecutionSelection;
      blockers: BoxExecutionBlocker[];
    };

/* =============================== Broker status =============================== */

/** One reason a broker switch was refused. */
export interface BrokerSwitchBlocker {
  reason: string;
  detail: string;
}

/** Session state of one broker. NEVER contains a token. */
export interface BrokerSession {
  broker: BrokerId;
  authenticated: boolean;
  /** A redacted client identity, never the raw account number. */
  client_id: string | null;
  client_name: string | null;
  token_expires_at: number | null;
  token_expired: boolean;
  login_day: string | null;
  login_at: number | null;
}

export interface BrokerHealth {
  broker: BrokerId;
  authenticated: boolean;
  token_expires_at: number | null;
  token_expired: boolean;
  data_ready: boolean;
  trading_ready: boolean;
  /** null for brokers with no such requirement (Zerodha) — not false. */
  static_ip_configured: boolean | null;
  feed_connected: boolean;
  feed_age_ms: number | null;
  problems: string[];
}

export interface DhanStaticIpState {
  ready: boolean;
  declared: boolean;
  configured_ip: string | null;
  api_verified: boolean | null;
  primary_ip: string | null;
  secondary_ip: string | null;
  checked_at: number | null;
  error: string | null;
}

export interface FeedHealthView {
  state: "DOWN" | "CONNECTING" | "CONNECTED_NO_SUBSCRIPTIONS" | "LIVE" | "STALE";
  connected: boolean;
  subscribed: number;
  universe: number | null;
  feed_age_ms: number | null;
  last_tick_at: number | null;
  detail: string;
}

/**
 * One broker's redacted session, as published inside GET /api/broker/status.
 *
 * VERIFIED AGAINST THE RUNNING BACKEND. This replaces an earlier `BrokerSession` shape
 * (`authenticated`, `client_id`, `client_name`, `token_expires_at`, `token_expired`,
 * `login_day`, `login_at`) that the backend never sends: the backend deliberately
 * RE-PROJECTS its internal state so a future internal field cannot silently become
 * public.
 *
 * `account_label` is already redacted by the backend (last four characters, rest
 * masked). There is no token, ciphertext, IV or auth-tag field to render, by design.
 */
export interface BrokerSessionView {
  broker: BrokerId;
  connected: boolean;
  /** waiting | ready | standby | expired — "standby" means a valid token, not active. */
  state: "waiting" | "ready" | "standby" | "expired";
  account_label: string | null;
  established_at: string | null;
  expires_at: string | null;
}

/** One broker's health, as published inside GET /api/broker/status. */
export interface BrokerHealthView {
  broker: BrokerId;
  authenticated: boolean;
  /** Quote/instrument access is usable. */
  data_ready: boolean;
  /** Live order placement is permitted AND possible. */
  trading_ready: boolean;
  /** Operator-facing reasons, e.g. "Static IP not configured". */
  problems: string[];
}

/**
 * GET /api/broker/status.
 *
 * The previous shape here described a SINGLE broker with required `dhan_configured`,
 * `dhan_instruments` and `dhan_instruments_loaded_at` fields — a response the backend does
 * not produce. It actually returns BOTH brokers in an array, which is what makes "active vs
 * standby" renderable at all. Because the old fields were required-but-absent they were
 * `undefined` at runtime while still typechecking.
 *
 * Verified against a real response; see `tests/fixtures/broker-status.json`.
 */
export interface BrokerStatus {
  active_broker: BrokerId;
  /** Monotonic durable broker generation. Never resets, not even across a restart. */
  generation: number;
  /** Exactly one entry per supported broker. */
  brokers: { broker: BrokerId; session: BrokerSessionView; health: BrokerHealthView }[];
}

/** GET /api/broker/switch-blockers?broker=… — an empty list means the switch is allowed. */
export interface BrokerSwitchBlockersResponse {
  broker: BrokerId;
  /** Machine-readable reasons, e.g. "broker_not_configured", "open_position". */
  blockers: string[];
}

/** POST /api/broker/select — `ok: false` carries the exact refusal reasons. */
export interface BrokerSelectResponse {
  ok: boolean;
  broker: BrokerId;
  blockers: string[];
}

/* ============================= In-app broker login ============================= */

/**
 * POST /api/broker/{broker}/login/start.
 *
 * `login_url` is the BROKER'S OWN consent page, built server-side. The frontend never
 * constructs it: doing so would mean shipping broker hostnames (and an api key) into a
 * public bundle, which the origin scan in CI correctly forbids. The client's only job is
 * to navigate to whatever the backend returns.
 *
 * `expires_at` is when the pending-login attempt stops being claimable, so the UI can say
 * "that sign-in attempt lapsed, start again" instead of leaving a dead button.
 *
 * There is no token, consent secret or nonce to store here — the nonce round-trips through
 * the broker and is verified server-side, so the browser holds NOTHING between the two legs
 * of the flow. That is why no `localStorage` write is needed (and none is permitted).
 */
export interface BrokerLoginStart {
  broker: BrokerId;
  login_url: string;
  expires_at: string;
}

/** POST /api/broker/{broker}/logout — scoped to ONE broker; the other is untouched. */
export interface BrokerLogoutResponse {
  ok: boolean;
  broker: BrokerId;
}

/**
 * Why an in-app login round-trip ended without a session.
 *
 * These are the backend's STABLE codes, arriving on the workspace URL as
 * `?broker_login={broker}&status=failed&reason={code}`. They are a closed set so the UI can
 * explain each one in the operator's terms; an unrecognised value is still rendered (as
 * itself) rather than swallowed, because a silent failure is worse than an ugly one.
 */
export type BrokerLoginFailureReason =
  | "no_pending_login"
  | "login_expired"
  | "state_mismatch"
  | "state_missing"
  | "not_ready"
  | "not_configured"
  | "broker_denied"
  | "missing_credential"
  | "exchange_failed";

/** The outcome of a login round-trip, as read off the workspace URL after the redirect. */
export interface BrokerLoginOutcome {
  broker: BrokerId;
  status: "connected" | "failed";
  /** Present only when `status === "failed"`. */
  reason: string | null;
}

/* ======================= Runtime + export status readouts ===================== */

/**
 * The whole-system readiness readout (GET /api/runtime/status).
 *
 * Every field is optional and defensively typed: it drives the plain-language state
 * banners the operator sees ("waiting for today's token", "instruments loading",
 * "PostgreSQL persistence unavailable", …) and must degrade gracefully on an older backend
 * that omits a field. NO secret name or value ever appears here.
 */
/**
 * Per-broker token/feed state, as published inside GET /api/runtime/status.
 *
 * VERIFIED AGAINST THE RUNNING BACKEND, not inferred. The previous version of this file
 * described a shape the backend never sent (`token_waiting`, `instruments_loading`,
 * `websocket_connecting`, `depth_ready`, `postgres_available`, `live_entry_blocked`,
 * `recovery_active`) and every field was optional — so it typechecked, built and passed
 * tests while every readiness banner silently stayed dark in production. The field names
 * below are copied from an actual response; see `tests/fixtures/runtime-status.json`.
 *
 * NO SECRET APPEARS HERE. `last_error` is bounded and redacted by the backend, and there
 * is deliberately no token, passcode or ciphertext field to render.
 */
export interface BrokerTokenRuntime {
  broker: BrokerId;
  /** waiting | polling | ready | invalid | configuration_error */
  token_state: "waiting" | "polling" | "ready" | "invalid" | "configuration_error";
  /** The IST trading day the state refers to, e.g. "2026-09-08". */
  ist_day: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  /** Short, redacted. Never a token or a passcode. */
  last_error: string | null;
  feed_connected: boolean;
  wanted_token_count: number;
  subscribed_token_count: number;
  /** Age of the newest authoritative depth, or null when none has arrived. */
  last_depth_age_ms: number | null;
  reconnect_count: number;
}

/**
 * Whole-system readiness (GET /api/runtime/status).
 *
 * The banners are DERIVED from these fields rather than read from pre-computed booleans,
 * because the backend reports facts and the UI decides how to phrase them. Notably
 * `live_entry.reasons` is a real list the backend supplies — the old shape had nowhere to
 * put it, so the operator was told "live entry is blocked" without being told why.
 */
export interface RuntimeStatus {
  brokers: BrokerTokenRuntime[];
  active_broker: BrokerId | null;
  /** PostgreSQL — the authoritative operational store — is up. */
  pg_ready: boolean;
  migration_state: { applied: number; pending: number };
  /** Restart recovery and reconciliation have completed. */
  recovery_ready: boolean;
  live_entry: { blocked: boolean; reasons: string[] };
  /** Unresolved/unknown broker orders are being reconciled. */
  recovery_pending: boolean;
  /** A partial fill left legs outstanding. */
  residual_exposure: boolean;
}

/**
 * The async reporting-replica status (GET /api/export/status).
 *
 * MongoDB Atlas is a NON-authoritative reporting replica fed asynchronously from the
 * PostgreSQL outbox, so a backlog here is expected and non-fatal — the UI reports it
 * without alarm. A DEAD-LETTERED row is different: it means a projection gave up, and the
 * old shape had no field for it, so it was invisible.
 *
 * Field names verified against a real response; see `tests/fixtures/export-status.json`.
 */
export interface ExportStatus {
  /** False when MONGO_EXPORT_ENABLED=false or MONGODB_URI is unset. */
  enabled: boolean;
  /** Whether the projector currently holds a live Mongo connection. */
  connected: boolean;
  /** Unpublished, non-dead-lettered rows still waiting to drain. */
  backlog_count: number;
  /** Age of the oldest pending row, or null when the backlog is empty. */
  oldest_pending_age_ms: number | null;
  last_success_at: string | null;
  /** Bounded and secret-free. */
  last_error: string | null;
  /** Rows that exhausted their attempt budget. Non-zero needs an operator. */
  dead_letter_count: number;
}
