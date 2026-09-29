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

export interface SynthAccessStatus {
  authenticated: boolean;
  role?: string;
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
}

export interface SynthTrade {
  id: string;
  status: "open" | "closed";
  key: string;
  broker: SynthBrokerId;
  execution_mode: "paper_touch";
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

export interface SynthStatus {
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
  execution_mode: "paper_touch";
  /** Always false: gts-synth has no order-placement code. */
  live_orders: boolean;
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
  error?: string;
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

export function closeSynthTrade(
  id: string,
): Promise<{ trade: SynthTrade; open: SynthOpenPosition[]; status: SynthStatus }> {
  return synthRequest(`${BASE}/trades/${encodeURIComponent(id)}/close`, "Failed to close the synthetic position", {
    method: "POST",
  });
}

export function closeAllSynthTrades(): Promise<{
  results: SynthCloseAllResult[];
  open: SynthOpenPosition[];
  status: SynthStatus;
}> {
  return synthRequest(`${BASE}/trades/close-all`, "Failed to close the synthetic positions", { method: "POST" });
}

/**
 * Delete a PAPER trade (soft delete, kept as an audit row). `expectedStatus` is what the
 * confirmation showed: a trade that changed state meanwhile is refused (409). Safe to retry.
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
