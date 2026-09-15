/**
 * AUTO-GENERATED FROM THE VENDORED BACKEND CONTRACT — DO NOT HAND-EDIT.
 *
 * Source: contract/schemas/**.schema.json  (pinned by contract/BACKEND_CONTRACT.json).
 * Generator: contract/generate-types.mjs.  Regenerate with `npm run contract:types`.
 *
 * Every edit here will be overwritten. To change a shape, change the backend serializer,
 * update the schema, re-vendor and re-pin (see contract/README.md), then regenerate.
 * CI regenerates this file and fails on any diff, so a hand-edit or a stale commit is caught.
 */

/* eslint-disable */
/** Protocol constants from contract/protocol.json (single source of truth — do not hardcode copies). */
export const CSRF_COOKIE_SUFFIX = "_csrf" as const;
export const CSRF_HEADER = "x-csrf-token" as const;
export const SESSION_COOKIE_DEFAULT = "gts_session" as const;

/** GET /api/access/status (200) (from contract/schemas/access-status.schema.json) */
export type AccessStatusContract = { authenticated: false; } | ({ authenticated: true; role: "full" | "trade"; expires_at: string; csrf_token?: string; });

/** POST /api/access/verify (200 success) (from contract/schemas/access-verify.schema.json) */
export interface AccessVerifyContract { authenticated: true; role: "full" | "trade"; csrf_token: string; expires_at: string; }

/** A live-arm verdict (from contract/schemas/arm-verdict.schema.json) */
export interface ArmVerdictContract { ok: boolean; blockers: { code: string; detail: string; }[]; }

/** One side (CE or PE) of a chain strike row (from contract/schemas/box-chain-quote.schema.json) */
export interface BoxChainQuoteContract { token: number; tradingsymbol: string; bid: number; bid_qty: number; ask: number; ask_qty: number; last: number; age_ms: number | null; marks: string[]; }

/** GET /api/box/chains (200) (from contract/schemas/box-chains.schema.json) */
export type BoxChainsContract = { chains: { underlying: string; name: string; is_index: boolean; expiry: string; }[]; } | ({ underlying: string; name: string; is_index: boolean; expiry: string; lot_size: number; quantity: number; atm_strike: number | null; strike_step: number | null; spot: number | null; spot_age_ms: number | null; strikes: ({ strike: number; is_atm: boolean; ce: BoxChainQuoteContract | null; pe: BoxChainQuoteContract | null; })[]; });

/** GET /api/box/config (200) (from contract/schemas/box-config.schema.json) */
export interface BoxConfigContract { min_expected_net_profit: number; min_gross_edge: number; min_net_edge: number; execution_mode: string; simulated_decision_ms: number; simulated_latency_ms: number; expected_entry_slippage: number; expected_exit_slippage: number; enable_short_box: boolean; directions: ("LONG_BOX" | "SHORT_BOX")[]; min_captured_pct: number; reconcile_charges: boolean; charge_reconcile_warn_pct: number; require_priced_charges: boolean; safety_buffer: number; quote_max_age_ms: number; feed_max_age_ms: number; underlying_max_age_ms: number; strikes_each_side: number; strike_level: number; max_strikes: number; max_candidates_per_underlying: number; prefilter_gross_threshold: number; convergence_floor: number; convergence_pct: number; min_exit_net_pnl: number; profit_capture_pct: number; expiry_safety_minutes: number; max_subscribed_tokens: number; lots: number; universe: string; indicative_discovery: boolean; closed_cache_enabled: boolean; tunable: { min_expected_net_profit: { min: number; max: number; }; safety_buffer: { min: number; max: number; }; }; }

/** A per-leg quote snapshot in the decision ledger (from contract/schemas/box-event-leg.schema.json) */
export interface BoxEventLegContract { role: "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe"; side: "BUY" | "SELL"; token: number; tradingsymbol: string; price: number | null; bid: number | null; bid_qty: number | null; ask: number | null; ask_qty: number | null; quote_at: string | null; age_ms: number | null; }

/** GET /api/box/events (200) (from contract/schemas/box-events.schema.json) */
export interface BoxEventsContract { events: Record<string, never>[]; }

/** GET /api/box/execution-attempts (200) (from contract/schemas/box-execution-attempts.schema.json) */
export interface BoxExecutionAttemptsContract { dbEnabled: boolean; attempts: Record<string, never>[]; }

/** GET /api/box/execution-control (200) (from contract/schemas/box-execution-control.schema.json) */
export interface BoxExecutionControlContract { execution_mode: string; paper_execution_profile: string; broker: "zerodha" | "dhan"; deployment_live_capable: boolean; live_capability_detail: string; live_runtime_armed: boolean; entry_enabled: boolean; emergency_flatten_enabled: boolean; mode: { selection: string; label: string; runtime_selectable: string[]; live_requires_restart: boolean; transition_blockers: unknown[]; }; session: { state: string; session_id: string | null; armed: boolean; armed_at: string | number | null; armed_by: string | null; max_completed_trades: number; completed_trades: number; consumed_cycles: number; remaining_trades: number | null; current_trade_id: string | null; in_flight_trade_ids: string[]; aborted_attempts: number; entry_attempts: number; max_entry_attempts: number; remaining_entry_attempts: number | null; arm_count: number; block_reason: string | null; readable: boolean; enforcing: boolean; write_failed: boolean; }; risk: { max_box_capital_rupees: number; paper_max_box_capital_rupees: number; max_box_capital_enforced: boolean; max_box_capital_metric: string; capital: Record<string, never>; one_active_box_per_underlying: boolean; active_underlyings: unknown[]; claimed_underlyings: unknown[]; max_open_boxes: number; open_boxes: number; residual_legs: number; daily_loss_limit: number; realised_pnl_today: number | null; }; execution: { live_entry_submit_concurrency: number; max_concurrent_executions: number; effective_broker_min_interval_ms: number; effective_broker_order_min_interval_ms: number; broker_order_interval_floor_ms: number; broker_order_interval_source: string; broker_pacing_rationale: string; pacing_source_of_truth: string; four_leg_burst_pacing_budget_ms: number; entry_burst: Record<string, never> | null; queued: number; in_flight: number; circuit: string; artificial_latency_applied_to_live: false; paper_only_simulated_decision_ms: number; paper_only_simulated_latency_ms: number; }; arm: { preconditions: { deploymentLiveCapable: boolean; brokerAuthenticated: boolean; reconciliationHealthy: boolean; reconciliationComplete: boolean; feedHealthy: boolean; feedWarmedUp: boolean; circuitClosed: boolean; recoveryActive: boolean; unknownOrders: number; durableReservationsAvailable: boolean; }; entry: ArmVerdictContract; exposure_management: ArmVerdictContract; emergency_flatten: ArmVerdictContract; }; block_reason: string | null; block_detail: string | null; }

/** A per-leg quote evaluation (from contract/schemas/box-leg-evaluation.schema.json) */
export interface BoxLegEvaluationContract { role: "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe"; side: "BUY" | "SELL"; token: number; tradingsymbol: string; strike: number; instrument_type: "CE" | "PE"; price: number | null; qty_at_touch: number | null; bid: number | null; bid_qty: number | null; ask: number | null; ask_qty: number | null; quote_at: number | null; exchange_at: number | null; age_ms: number | null; fresh: boolean; executable: boolean; }

/** A live open Box position with current exit arithmetic (from contract/schemas/box-open-position.schema.json) */
export interface BoxOpenPositionContract { id: string; key: string; execution_mode: string; broker: "zerodha" | "dhan"; underlying: string; name: string; is_index: boolean; expiry: string; direction: "LONG_BOX" | "SHORT_BOX"; lower_strike: number; upper_strike: number; box_width: number; lot_size: number; quantity: number; opened_at: string; margin: number | null; entry_box_cost: number | null; entry_gross_edge: number | null; entry_charges: number | null; estimated_exit_charges_at_entry: number | null; safety_buffer: number; entry_net_edge: number | null; expected_net_profit: number | null; entry_execution_cost: number | null; charge_origin: string; entry_legs: ({ role: "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe"; side: "BUY" | "SELL"; tradingsymbol: string; strike: number; instrument_type: "CE" | "PE"; entry_price: number | null; })[]; exit_legs: ({ role: "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe"; side: "BUY" | "SELL"; tradingsymbol: string; price: number | null; bid: number | null; bid_qty: number | null; ask: number | null; ask_qty: number | null; age_ms: number | null; executable: boolean; fresh: boolean; })[]; exit_box_value: number | null; gross_pnl: number | null; current_exit_charges: number | null; total_charges: number | null; net_pnl: number | null; realisable_net_pnl: number | null; estimated_execution_cost: number | null; remaining_edge: number | null; entry_edge: number | null; captured_edge: number | null; captured_pct: number | null; time_in_trade_ms: number | null; convergence_threshold: number | null; min_exit_net_pnl: number | null; profit_capture_target: number | null; min_captured_pct: number | null; liquidity_ok: boolean; worst_age_ms: number | null; exit_eligible: boolean; exit_reason: string | null; exit_rule_reason: string | null; blocked_reason: string | null; exit_blocked_reason: string | null; expiry_safety: boolean; status: "open"; }

/** GET /api/box/trades and /api/box/trades/open (200) (from contract/schemas/box-open-trades.schema.json) */
export interface BoxOpenTradesContract { dbEnabled: boolean; open: BoxOpenPositionContract[]; trades?: BoxTradeContract[]; }

/** GET /api/box/opportunities (200) (from contract/schemas/box-opportunities.schema.json) */
export interface BoxOpportunitiesContract { opportunities: BoxOpportunityContract[]; status: BoxStatusContract; }

/** A single Box opportunity (wire shape) (from contract/schemas/box-opportunity.schema.json) */
export interface BoxOpportunityContract { key: string; underlying: string; name: string; is_index: boolean; expiry: string; direction: "LONG_BOX" | "SHORT_BOX"; lower_strike: number; upper_strike: number; box_width: number; lot_size: number; quantity: number; entry_box_cost: number | null; gross_edge: number | null; entry_charges: number | null; estimated_exit_charges: number | null; execution_cost: number; safety_buffer: number; projected_net_edge: number | null; expected_net_profit: number | null; min_expected_net_profit: number; charge_origin: string; entry_sides: ({ role: "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe"; side: "BUY" | "SELL"; tradingsymbol: string; })[]; liquidity_ok: boolean; depth_ok: boolean; worst_age_ms: number | null; price_source: "touch" | "last_close"; status: "WATCHING" | "INDICATIVE" | "UNPRICED" | "ELIGIBLE" | "PAPER_OPENED" | "LIVE_OPENED" | "OPEN" | "REJECTED"; reject: string | null; legs: BoxLegEvaluationContract[]; updated_at: number; }

/** The Box SSE 'snapshot' event payload (from contract/schemas/box-sse-snapshot.schema.json) */
export interface BoxSseSnapshotContract { status: BoxStatusContract; opportunities: BoxOpportunityContract[]; open_trades: BoxOpenPositionContract[]; }

/** GET /api/box/status (200) (from contract/schemas/box-status.schema.json) */
export interface BoxStatusContract { running: boolean; state: "SCANNING" | "MARKET_CLOSED" | "STOPPED"; monitoring: boolean; market_open: boolean; indicative_at: number | null; indicative_priced: number | null; indicative_session_day: string | null; indicative_stale_legs: number | null; execution_mode: string; broker: "zerodha" | "dhan"; brokers_with_open_positions: string[]; authenticated: boolean; broker_auth_healthy: boolean | null; broker_orders_api_healthy: boolean | null; broker_positions_api_healthy: boolean | null; market_data_healthy: boolean; order_stream: OrderStreamStatusContract; execution_funnel: Record<string, never>; economic_admission: Record<string, never> | null; market_data_state: "DISABLED" | "CONNECTING" | "AUTHENTICATING" | "SYNCHRONIZING" | "READY" | "DEGRADED" | "DISCONNECTED" | "AUTH_EXPIRED"; market_data_health: Record<string, never>; operational_readiness: OperationalReadinessContract; database_healthy: boolean; daily_risk_seed_healthy: boolean | null; reconciliation_complete: boolean; unknown_orders: number; recovery_active: boolean; circuit_state: string; live_manager: Record<string, never> | null; db_enabled: boolean; started_at: number | null; stopped_at: number | null; universe_built_at: number | null; strike_level: number; underlyings: number; candidates: number; monitored_tokens: number; subscribed_option_tokens: number; subscribed_spot_tokens: number; hub_subscribed: number; hub_connected: boolean; quotes: number; quote_updates: number; feed_age_ms: number | null; raw_tick_age_ms: number | null; book_observation_age_ms: number | null; executable_books: number; executable_book_diagnostics: Record<string, never>; feed_healthy: boolean; exchange_lag_ms: number | null; open_positions: number; degraded: boolean; pending_unpersisted_fills: number; owned_unpersisted: number; residual_exposure_count: number; residual_exposure_legs: number; residual_flatten_in_flight: number; risk_bookkeeping: Record<string, never>; partially_exited_positions: number; day_pnl: Record<string, never>; skipped_for_budget: number; skipped_symbols: string[]; skipped_indicative_cap: number; skipped_indicative_symbols: string[]; indicative_max_underlyings: number; scanner: Record<string, never>; monitor: Record<string, never>; charges: Record<string, never>; reconciliation: Record<string, never>; metrics: Record<string, never>; last_error: string | null; config: BoxConfigContract; }

/** One leg of a serialized Box trade (from contract/schemas/box-trade-leg.schema.json) */
export interface BoxTradeLegContract { role: "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe"; token: number; tradingsymbol: string; exchange: string; strike: number; instrument_type: "CE" | "PE"; side: "BUY" | "SELL"; entry_price: number | null; entry_bid: number | null; entry_bid_qty: number | null; entry_ask: number | null; entry_ask_qty: number | null; entry_quote_at: string | null; entry_depth: Record<string, never> | null; detected_price: number | null; entry_slippage: number | null; exit_price: number | null; exit_bid: number | null; exit_bid_qty: number | null; exit_ask: number | null; exit_ask_qty: number | null; exit_quote_at: string | null; exit_depth: Record<string, never> | null; exit_detected_price: number | null; exit_slippage: number | null; }

/** A serialized Box trade (wire shape) (from contract/schemas/box-trade.schema.json) */
export interface BoxTradeContract { id: string; execution_mode: string; broker: "zerodha" | "dhan"; underlying: string; name: string; is_index: boolean; expiry: string; direction: "LONG_BOX" | "SHORT_BOX"; lower_strike: number; upper_strike: number; lot_size: number; quantity: number; status: string; legs: BoxTradeLegContract[]; box_width: number; margin: number | null; margin_source: "kite_basket" | "dhan_multi" | "dhan_per_leg_fallback" | "unavailable" | null; entry_box_cost: number | null; entry_gross_edge: number | null; entry_charges: number | null; estimated_exit_charges: number | null; safety_buffer: number; entry_net_edge: number | null; expected_net_profit: number | null; entry_execution_cost: number | null; charge_origin: string; charge_rate_version: string | null; entry_charge_reconciliation: Record<string, never> | null; exit_charge_reconciliation: Record<string, never> | null; entry_execution: Record<string, never> | null; entry_legging: Record<string, never> | null; exit_execution: Record<string, never> | null; opened_at: string; current_remaining_edge: number | null; current_captured_edge: number | null; current_captured_pct: number | null; exit_box_value: number | null; exit_charges: number | null; gross_pnl: number | null; total_charges: number | null; net_pnl: number | null; realised_net_pnl: number | null; closed_at: string | null; exit_reason: string | null; exit_blocked_reason: string | null; expiry_safety: boolean; scanner_config_snapshot: Record<string, never>; error: string | null; }

/** GET /api/box/trades/history (200) (from contract/schemas/box-trades-history.schema.json) */
export type BoxTradesHistoryContract = { dbEnabled: boolean; scope: "all"; source: string; cacheEnabled: boolean; lite: boolean; trades: BoxTradeContract[]; } | ({ dbEnabled: boolean; scope: "today"; source: "memory" | "postgres" | "none"; day: string | null; cacheEnabled: boolean; lite: boolean; trades: Record<string, never>[]; });

/** Redacted broker health descriptor (from contract/schemas/broker-health.schema.json) */
export interface BrokerHealthContract { broker: "zerodha" | "dhan"; authenticated: boolean; data_ready: boolean; trading_ready: boolean; problems: string[]; }

/** POST /api/broker/{broker}/login/start (200) (from contract/schemas/broker-login-start.schema.json) */
export interface BrokerLoginStartContract { broker: "zerodha" | "dhan"; login_url: string; expires_at: string; }

/** POST /api/broker/{broker}/logout (200) (from contract/schemas/broker-logout.schema.json) */
export interface BrokerLogoutContract { ok: true; broker: "zerodha" | "dhan"; }

/** Per-broker runtime status element (from contract/schemas/broker-runtime-status.schema.json) */
export interface BrokerRuntimeStatusContract { broker: "zerodha" | "dhan"; token_state: "waiting" | "polling" | "ready" | "invalid" | "configuration_error"; ist_day: string | null; last_attempt_at: string | null; last_success_at: string | null; last_error: string | null; feed_connected: boolean; wanted_token_count: number; subscribed_token_count: number; last_depth_age_ms: number | null; reconnect_count: number; }

/** POST /api/broker/select (409 refused) (from contract/schemas/broker-select-refusal.schema.json) */
export interface BrokerSelectRefusalContract { error: string; code: "switch_refused"; blockers: string[]; active_broker: "zerodha" | "dhan"; }

/** POST /api/broker/select (200 success) (from contract/schemas/broker-select-success.schema.json) */
export interface BrokerSelectSuccessContract { ok: true; active_broker: "zerodha" | "dhan"; generation: number; }

/** Redacted broker session descriptor (from contract/schemas/broker-session.schema.json) */
export interface BrokerSessionContract { broker: "zerodha" | "dhan"; connected: boolean; state: "waiting" | "expired" | "ready" | "standby"; account_label: string | null; established_at: string | null; expires_at: string | null; }

/** GET /api/broker/status (200) (from contract/schemas/broker-status.schema.json) */
export interface BrokerStatusContract { active_broker: "zerodha" | "dhan"; generation: number; brokers: ({ broker: "zerodha" | "dhan"; session: BrokerSessionContract; health: BrokerHealthContract; })[]; }

/** GET /api/broker/switch-blockers (200) (from contract/schemas/broker-switch-blockers.schema.json) */
export interface BrokerSwitchBlockersContract { broker: "zerodha" | "dhan"; blockers: string[]; }

/** GET /api/export/status (200) (from contract/schemas/export-status.schema.json) */
export interface ExportStatusContract { enabled: boolean; connected: boolean; backlog_count: number; oldest_pending_age_ms: number | null; last_success_at: string | null; last_error: string | null; dead_letter_count: number; }

/** Margin + provenance pair (as served on a Box trade) (from contract/schemas/margin-provenance.schema.json) */
export interface MarginProvenanceContract { margin: number | null; margin_source: "kite_basket" | "dhan_multi" | "dhan_per_leg_fallback" | "unavailable" | null; }

/** THE ONE authoritative readiness decision (box-status.operational_readiness) (from contract/schemas/operational-readiness.schema.json) */
export interface OperationalReadinessContract { decision_generation: number; instance: { instance_id: string | null; boot_ordinal: number | null; started_at: number | null; }; decision_version: string; decided_at: number; identity: { broker: "zerodha" | "dhan" | null; account_masked: string | null; account_present: boolean; execution_mode: string; live_runtime_armed: boolean; deployment_live_capable: boolean; }; market_data: { state: "DISABLED" | "CONNECTING" | "AUTHENTICATING" | "SYNCHRONIZING" | "READY" | "DEGRADED" | "DISCONNECTED" | "AUTH_EXPIRED"; generation: number; desired_instruments: number; ready_instruments: number; backlog: boolean; usable_for_entry: boolean; }; order_stream: { lifecycle: "DISABLED" | "CONNECTING" | "AUTHENTICATING" | "RECONCILING" | "READY" | "DEGRADED" | "DISCONNECTED" | "AUTH_EXPIRED"; published_state: "DISABLED" | "DOWN" | "CONNECTING" | "LIVE" | "DEGRADED" | "RECONNECTED_PENDING_RECONCILE" | "AUTH_EXPIRED"; wiring: "not_built" | "not_wired" | "gated_off" | "armed"; gate_enabled: boolean; connected: boolean; authorised: boolean; disconnects: number; }; fill_observation: { mechanism: "rest_polling_only" | "stream_primary_rest_reconcile"; stream_assisted: boolean; detail: string; }; evidence: { market_data_frame_age_ms: number | null; market_data_heartbeat_age_ms: number | null; market_data_depth_age_ms: number | null; order_stream_event_age_ms: number | null; }; reconciliation: { pending: boolean; blockers: ReadinessBlockerContract[]; }; entry: { permitted: boolean; reasons: ReadinessBlockerContract[]; }; exposure_management: { exit_and_reduce: boolean; protective_cancel: boolean; manage_working_orders: boolean; blocked_reasons: ReadinessBlockerContract[]; limitations: [string, ...string[]]; open_positions: number; residual_legs: number; working_orders: number; }; }

/** Order-update stream status (NOT market-data health) (from contract/schemas/order-stream-status.schema.json) */
export interface OrderStreamStatusContract { any_stream_live: boolean; market_data_health_is_not_order_stream_health: true; brokers: ({ broker: "zerodha" | "dhan"; wiring: "not_built" | "not_wired" | "gated_off" | "armed"; gate_env_var: string; gate_enabled: boolean; lifecycle: "DISABLED" | "CONNECTING" | "AUTHENTICATING" | "RECONCILING" | "READY" | "DEGRADED" | "DISCONNECTED" | "AUTH_EXPIRED" | null; health: { state: "DISABLED" | "DOWN" | "CONNECTING" | "LIVE" | "DEGRADED" | "RECONNECTED_PENDING_RECONCILE" | "AUTH_EXPIRED"; connected: boolean; authorised: boolean; lastEventAt: number | null; disconnects: number; reconcilePending: boolean; detail: string; lifecycle: "DISABLED" | "CONNECTING" | "AUTHENTICATING" | "RECONCILING" | "READY" | "DEGRADED" | "DISCONNECTED" | "AUTH_EXPIRED"; } | null; fills_observed_by: "rest_polling_only" | "stream_primary_rest_reconcile"; detail: string; })[]; }

/** One named reason something is not permitted (from contract/schemas/readiness-blocker.schema.json) */
export interface ReadinessBlockerContract { code: string; scope: "entry" | "reduction" | "both"; detail: string; }

/** GET /api/runtime/status (200) (from contract/schemas/runtime-status.schema.json) */
export interface RuntimeStatusContract { brokers: BrokerRuntimeStatusContract[]; active_broker: "zerodha" | "dhan" | null; pg_ready: boolean; migration_state: { applied: number; pending: number; }; recovery_ready: boolean; live_entry: { blocked: boolean; reasons: string[]; }; recovery_pending: boolean; residual_exposure: boolean; }

/** A parsed Box SSE frame (from contract/schemas/sse-envelope.schema.json) */
export interface SseEnvelopeContract { event: string; data: Record<string, never> | unknown[] | string | number | boolean | null; }
