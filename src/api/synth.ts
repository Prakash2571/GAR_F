/**
 * The synthetic-futures arbitrage API: the gts-synth Go service behind /api/synth.
 *
 * gts-synth is self-contained. It has its OWN access gate (passcode → HttpOnly session cookie
 * scoped to /api/synth → CSRF token), its own Zerodha/Dhan logins and its own tables. So this
 * module keeps its own session state:
 *
 *   • the synth CSRF token lives only in memory here (never in storage), seeded by verify or by
 *     an authenticated status call, and sent on every synth mutation via `csrfToken`;
 *   • a 401 from gts-synth ends only the SYNTH session (`onSynthUnauthorized`), never the rest of
 *     the app: every call is `suppressUnauthorized`;
 *   • every request still goes through the one transport (`request()`), so it keeps the
 *     whole-reply deadline, same-origin URL building and error types.
 *
 * The backend is the authority on everything (eligibility, fills, P&L, what a setting may be).
 * These types are hand-written; the Go service is not part of the vendored contract/.
 */

import { ApiError, apiUrl, request, type RequestOptions } from "./http.ts";

/* ------------------------------ synth session ----------------------------- */

let synthCsrf: string | null = null;
const unauthorizedListeners = new Set<() => void>();

/** Called when gts-synth answers 401: the synth session is gone. Returns an unsubscribe. */
export function onSynthUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export function notifySynthUnauthorized(): void {
  synthCsrf = null;
  for (const fn of [...unauthorizedListeners]) fn();
}

/** Test seam: whether a synth CSRF token is held (never exposes it). */
export function hasSynthCsrfToken(): boolean {
  return synthCsrf !== null;
}

async function synthRequest<T>(path: string, what: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await request<T>(path, what, { ...options, suppressUnauthorized: true, csrfToken: synthCsrf ?? "" });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) notifySynthUnauthorized();
    throw err;
  }
}

export type SynthAccessRole = "full" | "read";

export interface SynthAccessStatus {
  authenticated: boolean;
  role?: SynthAccessRole;
  csrf_token?: string;
  expires_at?: string;
}

/** Is there a live synth session? Seeds the in-memory CSRF token when there is. */
export async function synthAccessStatus(): Promise<SynthAccessStatus> {
  const s = await request<SynthAccessStatus>("/api/synth/access/status", "Failed to check the synthetic session", {
    suppressUnauthorized: true,
  });
  synthCsrf = s.authenticated && s.csrf_token ? s.csrf_token : s.authenticated ? synthCsrf : null;
  return s;
}

export class SynthPasscodeRejectedError extends Error {}

/**
 * Unlock the synthetic workspace. The only public synth mutation: it MINTS the CSRF token, so
 * it carries none (`csrfExempt`), and its 401 means "wrong passcode", not "session expired".
 */
export async function synthVerify(passcode: string): Promise<SynthAccessStatus> {
  try {
    const s = await request<SynthAccessStatus>("/api/synth/access/verify", "Failed to unlock the synthetic workspace", {
      method: "POST",
      body: { passcode },
      csrfExempt: true,
      suppressUnauthorized: true,
    });
    synthCsrf = s.csrf_token ?? null;
    return s;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw new SynthPasscodeRejectedError("That passcode is not correct.");
    throw err;
  }
}

/** End the synth session (best effort: a dead session has nothing to protect). */
export async function synthLogout(): Promise<void> {
  try {
    await request("/api/synth/access/logout", "Failed to lock the synthetic workspace", {
      method: "POST",
      csrfToken: synthCsrf ?? "",
      csrfBestEffort: true,
      suppressUnauthorized: true,
    });
  } finally {
    synthCsrf = null;
  }
}

export type SynthDirection = "CONVERSION" | "REVERSAL";
export type SynthRole = "fut" | "ce" | "pe";
export type SynthSide = "BUY" | "SELL";
export type SynthRowStatus = "ELIGIBLE" | "OPEN" | "WATCHING" | "REJECTED" | "INDICATIVE";
export type SynthBrokerId = "zerodha" | "dhan";

/**
 * How a decision becomes fills. Four paper modes (they never reach a broker's order API) and
 * live (real LIMIT orders: needs the server's environment consent AND an operator's ARM).
 */
export type SynthExecutionMode =
  | "paper_touch"
  | "paper_latency"
  | "paper_legging"
  | "paper_legging_live_parity"
  | "live";

export type SynthPhase = "entry" | "exit" | "unwind" | "residual";

export type SynthLegStatus =
  | "FILLED"
  | "PARTIAL"
  | "TIMED_OUT"
  | "CANCELLED"
  | "REJECTED"
  | "NOT_SENT"
  | "FAILED"
  | "UNKNOWN";

export interface SynthFill {
  price: number;
  qty: number;
  at: number;
  version?: number;
  generation?: number;
}

/** The terminal record of one order (paper-simulated or live). Times are epoch ms. */
export interface SynthLegOutcome {
  role: SynthRole;
  side: SynthSide;
  tradingsymbol: string;
  token: number;
  client_order_id: string;
  broker_order_id?: string;
  qty: number;
  filled: number;
  avg_price: number | null;
  ref_price: number;
  limit_price: number;
  status: SynthLegStatus;
  reason?: string;
  submit_at: number | null;
  ack_at: number | null;
  first_fill_at: number | null;
  last_fill_at: number | null;
  resolved_at: number | null;
  cancel_requested_at?: number | null;
  /** Quantity filled while a cancel was in flight (the race was lost). */
  raced_qty?: number;
  fills: SynthFill[];
  /** ₹ worse than the reference touch over the filled quantity (negative = better). */
  slippage: number | null;
}

/** One execution run: every leg's outcome, in transport order. */
export interface SynthRun {
  mode: SynthExecutionMode;
  phase: SynthPhase;
  sequential: boolean;
  detected_at: number;
  sent_at: number;
  completed_at: number;
  legs: SynthLegOutcome[];
  refused?: string;
  aborted?: string;
  /** Live only: a broker outcome is not proven. */
  uncertain?: boolean;
  latency_source?: string;
}

/** One order that filled something: the trade's P&L ledger. */
export interface SynthExecution {
  client_order_id: string;
  phase: SynthPhase;
  role: SynthRole;
  side: SynthSide;
  qty: number;
  avg_price: number;
  at: number;
}

export interface SynthLegEval {
  role: SynthRole;
  side: SynthSide;
  token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "FUT" | "CE" | "PE";
  price: number | null;
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  age_ms: number | null;
  fresh: boolean;
  executable: boolean;
  reject: string | null;
  version?: number;
  received_at_ms?: number | null;
  exchange_time?: SynthTimestamp | null;
  timestamp_issue?: string;
}

export interface SynthTimestamp {
  at_ms: number;
  resolution_ms: number;
  source: string;
  semantics: "exchange_snapshot";
}

export interface SynthOpportunity {
  key: string;
  underlying: string;
  is_index: boolean;
  expiry: string;
  days_to_expiry: number;
  strike: number;
  atm_strike: number;
  atm_offset: number;
  strike_step: number;
  lot_size: number;
  lots: number;
  quantity: number;
  direction: SynthDirection;
  future_price: number | null;
  synthetic_price: number | null;
  mid_basis: number | null;
  mispricing_per_unit: number | null;
  carry_per_unit: number;
  gross_per_unit: number | null;
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  expected_slippage: number;
  safety_buffer: number;
  expected_net_profit: number | null;
  min_expected_net_profit: number;
  rf_pct: number;
  depth_ok: boolean;
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  coherent?: boolean;
  dispersion_ms?: number | null;
  timestamp_source?: string;
  price_source: "touch" | "last_close";
  status: SynthRowStatus;
  reject: string | null;
  entry_blocked: string | null;
  position_id: string | null;
  legs: SynthLegEval[];
  updated_at: number;
}

export interface SynthLevel {
  price: number;
  qty: number;
}

export interface SynthDepth {
  bids: SynthLevel[];
  asks: SynthLevel[];
}

export interface SynthTradeLeg {
  role: SynthRole;
  /** The ENTRY side; the closing side is the opposite. */
  side: SynthSide;
  instrument_type: "FUT" | "CE" | "PE";
  strike: number;
  tradingsymbol: string;
  token: number;
  entry_price: number;
  entry_bid: number;
  entry_ask: number;
  entry_bid_qty: number | null;
  entry_ask_qty: number | null;
  entry_qty_at_touch: number | null;
  entry_age_ms: number | null;
  entry_depth: SynthDepth | null;
  exit_price: number | null;
  exit_bid: number | null;
  exit_ask: number | null;
  exit_bid_qty: number | null;
  exit_ask_qty: number | null;
  exit_qty_at_touch: number | null;
  exit_age_ms: number | null;
  exit_depth: SynthDepth | null;
  /** Filled entry quantity (0 on rows older than this field: then the trade's quantity). */
  qty: number;
  /** Quantity closed so far. */
  exit_qty: number;
}

export interface SynthTrade {
  id: string;
  status: "open" | "closed";
  key: string;
  broker: SynthBrokerId;
  account_id?: string;
  recovery_state?: "ready" | "required" | "";
  accounting_pending?: boolean;
  pnl_status?: "settlement_pending" | "confirmed_statement" | "execution_estimate" | "paper_estimate" | "estimated" | "";
  settlement_pending?: boolean;
  settlement_kind?: "cash" | "physical" | "";
  settlement_since_ms?: number | null;
  settlement_estimate_gross?: number | null;
  settlement_evidence?: SynthSettlementEvidence | null;
  execution_mode: SynthExecutionMode;
  order_type: "LIMIT";
  underlying: string;
  is_index: boolean;
  expiry: string;
  strike: number;
  atm_strike: number;
  atm_offset: number;
  direction: SynthDirection;
  lot_size: number;
  lots: number;
  quantity: number;
  opened_at: string;
  opened_day: string;
  legs: SynthTradeLeg[];
  entry_future_price: number;
  entry_synthetic_price: number;
  entry_lock_per_unit: number;
  entry_carry_per_unit: number;
  entry_edge: number;
  entry_gross_edge: number;
  entry_charges: number;
  estimated_exit_charges: number;
  entry_net_edge: number;
  expected_net_profit: number;
  min_expected_net_profit: number;
  safety_buffer: number;
  expected_slippage: number;
  rf_pct: number;
  option_rate_version: string;
  futures_rate_version: string;
  closed_at: string | null;
  closed_day: string | null;
  exit_reason: string | null;
  gross_pnl: number | null;
  exit_charges: number | null;
  total_charges: number | null;
  net_pnl: number | null;
  exit_note: string | null;
  margin: number | null;
  margin_source: string | null;
  margin_hedge_benefit: number | null;
  margin_at: string | null;
  margin_error: string | null;
  /* Execution record (every mode but paper_touch; null/empty otherwise). */
  executions: SynthExecution[] | null;
  entry_run: SynthRun | null;
  unwind_run: SynthRun | null;
  exit_runs: SynthRun[] | null;
  detected_net_profit: number | null;
  legging_pnl: number | null;
  /** An INCOMPLETE position (partial entry/exit): its outstanding legs are being flattened. */
  residual: boolean;
  residual_reason: string | null;
  /** Live: an order outcome is unproven; nothing automatic happens until reconciled. */
  quarantined: boolean;
  quarantine_reason: string | null;
  /** Live: the durable claim written before the first order. */
  entry_pending: boolean;
  entry_no_submit_proven?: boolean;
  close_reason: string | null;
  flatten_attempts: number;
  flatten_rejects: number;
  /** Flattening stopped after repeated broker rejections; the operator resumes it. */
  flatten_halted: boolean;
  reduction_seq: number;
}

export interface SynthExitLeg {
  role: SynthRole;
  /** The closing side. */
  side: SynthSide;
  tradingsymbol: string;
  token: number;
  entry_price: number;
  price: number | null;
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  ltp: number | null;
  age_ms: number | null;
  fresh: boolean;
  executable: boolean;
  reject: string | null;
}

/** An open position. gross_pnl / total_charges / net_pnl are "if closed now at the touch". */
export interface SynthOpenPosition extends SynthTrade {
  linked: boolean;
  closing: boolean;
  exit_legs: SynthExitLeg[];
  mtm_ltp: number | null;
  current_exit_charges: number | null;
  remaining_edge: number | null;
  captured_pct: number | null;
  convergence_threshold: number;
  profit_capture_target: number;
  min_exit_net_pnl: number;
  expiry_safety: boolean;
  exit_eligible: boolean;
  exit_rule_reason: string | null;
  exit_blocked_reason: string | null;
  held_reason: string | null;
}

export interface SynthDayPnl {
  day: string;
  open_count: number;
  open_mtm_ltp: number;
  open_unmarked_count: number;
  open_running_gross_pnl: number;
  open_running_net_pnl: number;
  open_unpriced_count: number;
  closed_count: number;
  closed_realised_gross_pnl: number;
  closed_charges: number;
  closed_realised_net_pnl: number;
  total_net_pnl: number;
  total_gross_pnl: number;
  open_margin: number;
  open_margin_unknown: number;
  closed_margin: number;
  closed_margin_unknown: number;
}

export interface SynthBrokerSession {
  broker: SynthBrokerId;
  connected: boolean;
  reason?: string;
  identity?: { user_id?: string; user_name?: string };
  source?: "login" | "manual";
  login_date?: string;
  expires_at?: string;
  acquired_at?: string;
}

/** A broker as the Broker panel shows it. */
export interface SynthBrokerView extends SynthBrokerSession {
  /** The broker app credentials for the login redirect are configured on the server. */
  login_configured: boolean;
  /** A token can be pasted instead. */
  manual_token: boolean;
}

/** Recovery readiness is independent of market/feed/ARM and per-opportunity gates. */
export interface SynthHealth {
  service: "gts-synth";
  live: boolean;
  ready: boolean;
  state: "starting" | "recovering" | "unavailable" | "ready" | "degraded" | "shutting_down" | "stopped";
  recovery_complete: boolean;
  storage_ready: boolean;
  entry_permitted: boolean;
  entry_block: string | null;
}

export interface SynthStatus extends SynthHealth {
  running: boolean;
  market_open: boolean;
  calendar_covered: boolean;
  broker_mode: SynthBrokerId;
  broker: SynthBrokerId | "";
  authenticated: boolean;
  auth_reason?: string;
  brokers: Partial<Record<SynthBrokerId, SynthBrokerSession>>;
  feed_connected: boolean;
  feed_error?: string;
  feed_age_ms: number | null;
  feed_healthy: boolean;
  execution_mode: SynthExecutionMode;
  /** True only in live mode AND armed: new entries send real orders. */
  live_orders: boolean;
  live_armed: boolean;
  live_breaker: string | null;
  /** Why a live entry cannot start now (code + text), in live mode. */
  live_block: string | null;
  live_block_reason: string | null;
  live_busy: number;
  unresolved_intents: number;
  residual_count: number;
  quarantined_count: number;
  settlement_pending_count?: number;
  recovery_required_count?: number;
  in_flight: number;
  paper_trading: boolean;
  paper_blocked_reason: "disabled" | "loading" | null;
  store_ready: boolean;
  settings_version: number;
  strike_level: number;
  paired_underlyings: number;
  monitored_underlyings: number;
  skipped_for_budget: number;
  unbuilt_windows: number;
  subscribed_tokens: number;
  token_budget: number;
  ready_books: number;
  open_count: number;
  max_open_positions: number;
  unlinked_positions: number;
  day_pnl: SynthDayPnl;
  universe_at: number | null;
  evaluated_at: number | null;
  close_session_day: string | null;
  eligible_count: number;
  opportunity_count: number;
  last_error: string | null;
  server_time: number;
}

export interface SynthSnapshot {
  status: SynthStatus;
  opportunities: SynthOpportunity[];
  open_trades: SynthOpenPosition[];
}

export type SynthSettingKind = "number" | "int" | "bool" | "enum" | "list";
export type SynthSettingValue = number | boolean | string | string[];

export interface SynthSetting {
  key: string;
  group: string;
  label: string;
  help: string;
  kind: SynthSettingKind;
  default: SynthSettingValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: string[];
  /** Changing it can increase exposure or activity: the page asks for confirmation. */
  risk: boolean;
  list_item?: "symbol" | "date";
  value: SynthSettingValue;
}

export interface SynthSettings {
  version: number;
  persisted: boolean;
  groups: string[];
  settings: SynthSetting[];
}

export interface SynthHistory {
  store_ready: boolean;
  scope: "today" | "all";
  trades: SynthTrade[];
}

export interface SynthChainSide {
  token: number;
  tradingsymbol: string;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  age_ms: number | null;
}

export interface SynthChain {
  underlying: string;
  is_index: boolean;
  expiry: string;
  lot_size: number;
  atm_strike: number;
  strike_step: number;
  future: SynthChainSide;
  strikes: { strike: number; is_atm: boolean; ce: SynthChainSide; pe: SynthChainSide }[];
}

export interface SynthCloseAllResult {
  id: string;
  underlying: string;
  closed: boolean;
  /** The close is being worked by the trade's executor (execution modes). */
  started: boolean;
  error?: string;
}

/** A durable live order intent (written before the broker is called). */
export interface SynthIntent {
  client_order_id: string;
  trade_id: string;
  broker: SynthBrokerId;
  account_id?: string;
  evidence_version?: number;
  priced_qty?: number;
  priced_avg_price?: number;
  phase: SynthPhase;
  role: SynthRole;
  side: SynthSide;
  tradingsymbol: string;
  security_id?: string;
  token: number;
  qty: number;
  limit_price: number;
  tag: string;
  state: string;
  broker_order_id: string;
  filled: number;
  avg_price: number;
  reason: string;
  created_at: string;
  updated_at: string;
}

export type SynthOutcome =
  | "OPENED"
  | "REFUSED_BEFORE_SUBMIT"
  | "NO_FILL"
  | "PARTIAL_ENTRY_UNWOUND"
  | "PARTIAL_ENTRY_RESIDUAL"
  | "FILLED_THEN_ECONOMICS_ABORT"
  | "QUARANTINED_UNKNOWN";

/** One entry attempt in any execution mode, whatever its outcome. */
export interface SynthAttempt {
  id: string;
  at_ms: number;
  mode: SynthExecutionMode;
  broker: SynthBrokerId;
  underlying: string;
  key: string;
  direction: SynthDirection;
  strike: number;
  outcome: SynthOutcome | string;
  reason?: string;
  trade_id?: string;
  detected_net_profit: number | null;
  filled_net_profit: number | null;
  legging_pnl: number | null;
  entry?: SynthRun;
  unwind?: SynthRun;
}

export interface SynthGate {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface SynthInFlight {
  kind: "entry" | "exit" | "residual";
  underlying: string;
  trade_id: string;
  mode: SynthExecutionMode;
  since_ms: number;
}

export interface SynthLiveView {
  broker: SynthBrokerId;
  /** The server's environment consents to live orders on this broker. */
  permitted: boolean;
  permitted_reason?: string;
  consent: { enabled: boolean; broker: boolean; static_ip_confirmed: boolean; max_margin_rupees: number };
  armed: boolean;
  armed_at: number | null;
  armed_by?: string;
  breaker: string | null;
  breaker_at: number | null;
  unresolved_intents: SynthIntent[];
  reconciling: boolean;
  busy: number;
  open_live_trades: number;
  quarantined_live_trades: number;
  /** Account/IST-day live risk; includes hidden closes and priced owning-account open marks. */
  day_net: number;
  ack_samples: number;
  cancel_samples: number;
  measured_ack_ms: number | null;
  measured_cancel_ms: number | null;
  entry_block: string | null;
  entry_block_reason: string | null;
  gates: SynthGate[];
  arm_phrase: string;
  reset_phrase: string;
}

export interface SynthExecutionView {
  mode: SynthExecutionMode;
  leg_execution_mode: "hedge_sequential" | "parallel";
  modes: SynthExecutionMode[];
  live: SynthLiveView;
  in_flight: SynthInFlight[];
  residual_count: number;
  quarantined_count: number;
  settlement_pending_count?: number;
  recovery_required_count?: number;
  attempts: SynthAttempt[];
}

export interface SynthAccountEvidence {
  account_id: string;
  evidence_id: string;
  source: string;
  note: string;
  confirm: "BIND ACCOUNT";
}

export interface SynthSettlementEvidence {
  evidence_id: string;
  source: string;
  account_id: string;
  kind: "cash" | "physical";
  obligations_resolved: boolean;
  delivery_resolved: boolean;
  gross_pnl: number;
  total_charges: number;
  legs: { role: SynthRole; tradingsymbol: string; qty: number }[];
  orders?: { client_order_id: string; broker_order_id: string; state: "COMPLETE" | "CANCELLED" | "REJECTED"; qty: number; filled: number; avg_price: number }[];
  note: string;
  confirm: "CONFIRM SETTLEMENT";
}

export interface SynthReconcileResult {
  examined: number;
  unresolved_intents: SynthIntent[];
  trades: string[] | null;
}

export interface SynthDeleteResult {
  deleted_id: string;
  deleted_from: "open" | "closed";
  already_deleted: boolean;
  status: SynthStatus;
  open: SynthOpenPosition[];
  closed_today: SynthTrade[];
}

const BASE = "/api/synth";

export function fetchSynthStatus(): Promise<SynthStatus> {
  return synthRequest<SynthStatus>(`${BASE}/status`, "Failed to load the synthetic scanner status");
}

export function fetchSynthOpportunities(): Promise<{ status: SynthStatus; opportunities: SynthOpportunity[] }> {
  return synthRequest(`${BASE}/opportunities`, "Failed to load synthetic opportunities");
}

export async function fetchSynthOpen(): Promise<SynthOpenPosition[]> {
  const body = await synthRequest<{ open: SynthOpenPosition[] }>(`${BASE}/trades/open`, "Failed to load open synthetic trades");
  return body.open ?? [];
}

export function fetchSynthHistory(scope: "today" | "all", limit = 500): Promise<SynthHistory> {
  const qs = new URLSearchParams({ scope, limit: String(limit) });
  return synthRequest<SynthHistory>(`${BASE}/trades/history?${qs.toString()}`, "Failed to load closed synthetic trades");
}

export async function startSynth(): Promise<SynthStatus> {
  const body = await synthRequest<{ status: SynthStatus }>(`${BASE}/start`, "Failed to start the synthetic scanner", {
    method: "POST",
  });
  return body.status;
}

export async function stopSynth(): Promise<SynthStatus> {
  const body = await synthRequest<{ status: SynthStatus }>(`${BASE}/stop`, "Failed to stop the synthetic scanner", {
    method: "POST",
  });
  return body.status;
}

export function fetchSynthSettings(): Promise<SynthSettings> {
  return synthRequest<SynthSettings>(`${BASE}/settings`, "Failed to load synthetic settings");
}

/** Apply changes atomically if `version` is still current (409 `stale_version` otherwise). */
export function patchSynthSettings(
  version: number,
  changes: Record<string, SynthSettingValue>,
): Promise<{ settings: SynthSettings; status: SynthStatus }> {
  return synthRequest(`${BASE}/settings`, "Failed to save synthetic settings", {
    method: "PATCH",
    body: { version, changes },
  });
}

/**
 * Close one position now. paper_touch closes at the touch at once (`async: false`, `trade` is
 * the CLOSED trade). Every other mode STARTS its executor (`async: true`, HTTP 202, `trade` is
 * still the open position): the orders take seconds and the outcome arrives on the stream.
 */
export function closeSynthTrade(
  id: string,
): Promise<{ async: boolean; trade: SynthTrade; open: SynthOpenPosition[]; status: SynthStatus }> {
  return synthRequest(`${BASE}/trades/${encodeURIComponent(id)}/close`, "Failed to close the synthetic position", {
    method: "POST",
  });
}

/* --------------------------------- execution -------------------------------- */

export function fetchSynthExecution(attempts = 50): Promise<SynthExecutionView> {
  return synthRequest(`${BASE}/execution?attempts=${attempts}`, "Failed to load the execution state");
}

export async function fetchSynthAttempts(limit = 100): Promise<SynthAttempt[]> {
  const body = await synthRequest<{ attempts: SynthAttempt[] }>(`${BASE}/attempts?limit=${limit}`, "Failed to load entry attempts");
  return body.attempts ?? [];
}

type LiveReply = { execution: SynthExecutionView; status: SynthStatus };

/** Arm live entries. The server re-checks every gate and needs the typed phrase. */
export function armSynthLive(confirm: string): Promise<LiveReply> {
  return synthRequest(`${BASE}/live/arm`, "Failed to arm live trading", { method: "POST", body: { confirm } });
}

/** Stop new live entries at once. Always allowed; exits and flattening continue. */
export function disarmSynthLive(): Promise<LiveReply> {
  return synthRequest(`${BASE}/live/disarm`, "Failed to disarm live trading", { method: "POST" });
}

/** Close the circuit breaker once nothing is unresolved. Live stays disarmed. */
export function resetSynthBreaker(confirm: string): Promise<LiveReply> {
  return synthRequest(`${BASE}/live/breaker/reset`, "Failed to reset the circuit breaker", { method: "POST", body: { confirm } });
}

/** Re-read every unresolved live order at the broker and rebuild the affected positions. */
export function reconcileSynthLive(): Promise<LiveReply & { reconcile: SynthReconcileResult; open: SynthOpenPosition[] }> {
  return synthRequest(`${BASE}/live/reconcile`, "Failed to reconcile live orders", { method: "POST" });
}

/** Explicit audited ownership attestation for legacy live rows; full role required. */
export function bindSynthAccount(id: string, evidence: SynthAccountEvidence): Promise<{ ok: boolean; open: SynthOpenPosition[]; status: SynthStatus }> {
  return synthRequest(`${BASE}/trades/${encodeURIComponent(id)}/account/bind`, "Failed to bind legacy account evidence", { method: "POST", body: evidence });
}

/** Final statement reconciliation; every cash/delivery obligation must be resolved. */
export function reconcileSynthSettlement(id: string, evidence: SynthSettlementEvidence): Promise<{ ok: boolean; trade: SynthTrade; open: SynthOpenPosition[]; status: SynthStatus }> {
  return synthRequest(`${BASE}/trades/${encodeURIComponent(id)}/settlement/reconcile`, "Failed to reconcile settlement evidence", { method: "POST", body: evidence });
}

export function closeAllSynthTrades(): Promise<{
  results: SynthCloseAllResult[];
  open: SynthOpenPosition[];
  status: SynthStatus;
}> {
  return synthRequest(`${BASE}/trades/close-all`, "Failed to close the synthetic positions", { method: "POST" });
}

/**
 * Delete a trade (soft delete, kept as an audit row). An OPEN live position is refused (409
 * `live_position`): it is real exposure. `expectedStatus` is what the confirmation showed: a
 * trade that changed state meanwhile is refused (409). Safe to retry.
 */
export function deleteSynthTrade(
  id: string,
  expectedStatus: "open" | "closed",
  reason?: string,
): Promise<SynthDeleteResult> {
  return synthRequest(`${BASE}/trades/${encodeURIComponent(id)}`, "Failed to delete the synthetic trade", {
    method: "DELETE",
    body: reason ? { reason, expected_status: expectedStatus } : { expected_status: expectedStatus },
  });
}

export function fetchSynthChain(underlying: string): Promise<SynthChain> {
  return synthRequest(`${BASE}/chain/${encodeURIComponent(underlying)}`, "Failed to load the chain");
}

/** SSE URL: relative, no token (the cookie rides on it). */
export function synthStreamUrl(): string {
  return apiUrl(`${BASE}/stream`);
}

/* ---------------------------------- brokers --------------------------------- */

export async function fetchSynthBrokers(): Promise<SynthBrokerView[]> {
  const body = await synthRequest<{ brokers: SynthBrokerView[] }>(`${BASE}/broker/status`, "Failed to load broker sessions");
  return body.brokers ?? [];
}

/** Start a broker login; the page then sends the browser to `login_url`. */
export function startSynthBrokerLogin(broker: SynthBrokerId): Promise<{ login_url: string; expires_at: string }> {
  return synthRequest(`${BASE}/broker/${broker}/login/start`, `Failed to start the ${broker} login`, { method: "POST" });
}

/** Store a pasted access token (the server validates it with the broker first). */
export async function saveSynthBrokerToken(
  broker: SynthBrokerId,
  accessToken: string,
  clientId?: string,
): Promise<SynthBrokerView[]> {
  const body = await synthRequest<{ brokers: SynthBrokerView[] }>(`${BASE}/broker/${broker}/token`, `Failed to save the ${broker} token`, {
    method: "POST",
    body: clientId ? { access_token: accessToken, client_id: clientId } : { access_token: accessToken },
  });
  return body.brokers ?? [];
}

export async function logoutSynthBroker(broker: SynthBrokerId): Promise<SynthBrokerView[]> {
  const body = await synthRequest<{ brokers: SynthBrokerView[] }>(`${BASE}/broker/${broker}/logout`, `Failed to disconnect ${broker}`, {
    method: "POST",
  });
  return body.brokers ?? [];
}
