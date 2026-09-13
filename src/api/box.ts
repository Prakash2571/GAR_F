/**
 * Every backend call the GTS Box UI makes.
 *
 * All of these go through the single `request` wrapper in `http.ts`, so they share one
 * behaviour: same-origin cookie credentials, an in-memory CSRF token echoed as the
 * `x-csrf-token` header on mutating calls, honest JSON error messages, and a single 401
 * handler. There is no SESSION token to pass — the session is the HttpOnly cookie; the CSRF
 * token lives only in the transport's process memory.
 */

import { apiUrl, request } from "./http.ts";
import type {
  BoxChain,
  BoxDeleteResult,
  BoxExecutionAttempt,
  BoxExecutionControl,
  BoxHistoryResponse,
  BoxModeTransitionVerdict,
  BoxOpenPosition,
  BoxOpportunity,
  BoxStatus,
  BoxConfigView,
  BoxExecutionSelection,
  BoxSessionView,
  BrokerId,
  BrokerStatus,
  BrokerSwitchBlockersResponse,
  BrokerSelectResponse,
  ExportStatus,
  RuntimeStatus,
} from "./types.ts";

/* --------------------------------- box status -------------------------------- */

export async function fetchBoxStatus(): Promise<BoxStatus> {
  return request<BoxStatus>("/api/box/status", "Failed to load the box scanner status");
}

export async function fetchBoxExecutionAttempts(limit = 100): Promise<BoxExecutionAttempt[]> {
  const body = await request<{ attempts: BoxExecutionAttempt[] }>(
    `/api/box/execution-attempts?limit=${limit}`,
    "Failed to load box execution attempts",
  );
  return body.attempts ?? [];
}

export async function fetchBoxConfig(): Promise<BoxConfigView> {
  return request<BoxConfigView>("/api/box/config", "Failed to load box configuration");
}

/* --------------------------------- scanner ----------------------------------- */

export async function startBoxScanner(): Promise<BoxStatus> {
  const body = await request<{ ok?: boolean; status: BoxStatus }>(
    "/api/box/start",
    "Failed to start the box scanner",
    { method: "POST" },
  );
  return body.status;
}

export async function stopBoxScanner(): Promise<BoxStatus> {
  const body = await request<{ ok?: boolean; status: BoxStatus }>(
    "/api/box/stop",
    "Failed to stop the box scanner",
    { method: "POST" },
  );
  return body.status;
}

export async function setBoxStrikeLevel(level: 1 | 2 | 3): Promise<BoxStatus> {
  const body = await request<{ ok?: boolean; strike_level: number; status: BoxStatus }>(
    "/api/box/strike-level",
    "Failed to set the box strike level",
    { method: "POST", body: { level } },
  );
  return body.status;
}

/* ------------------------------ opportunities -------------------------------- */

export async function fetchBoxOpportunities(
  limit?: number,
): Promise<{ opportunities: BoxOpportunity[]; status: BoxStatus }> {
  const qs = limit ? `?limit=${limit}` : "";
  return request<{ opportunities: BoxOpportunity[]; status: BoxStatus }>(
    `/api/box/opportunities${qs}`,
    "Failed to load box opportunities",
  );
}

/* ---------------------------------- chain ------------------------------------ */

export async function fetchBoxChain(underlying: string): Promise<BoxChain> {
  return request<BoxChain>(
    `/api/box/chains?underlying=${encodeURIComponent(underlying)}`,
    "Failed to load box option chain",
  );
}

/* --------------------------------- history ----------------------------------- */

/**
 * Closed box trades.
 *
 * `scope: "today"` is the FAST path — the backend answers it from memory/Redis, never with
 * a full-book scan of the authoritative store. The page asks for that first so the current
 * session appears immediately, then fetches the whole book in the background.
 */
export async function fetchBoxHistory(
  limit = 300,
  scope: "today" | "all" = "all",
): Promise<BoxHistoryResponse> {
  const qs =
    scope === "today" ? "?scope=today" : `?scope=all&limit=${encodeURIComponent(limit)}`;
  return request<BoxHistoryResponse>(
    `/api/box/trades/history${qs}`,
    "Failed to load box trade history",
  );
}

/* --------------------------------- settings ---------------------------------- */

export async function saveBoxSettings(patch: {
  min_expected_net_profit?: number;
  safety_buffer?: number;
}): Promise<{ config: BoxConfigView; status: BoxStatus }> {
  return request<{ ok?: boolean; config: BoxConfigView; status: BoxStatus }>(
    "/api/box/settings",
    "Failed to save the box settings",
    { method: "POST", body: patch },
  );
}

/* ------------------------------ trade actions -------------------------------- */

/**
 * Close an open box at the current executable touch. POST to match the backend's CORS
 * allow-list. The `id` is an OPAQUE string — passed through, never parsed.
 */
export async function closeBoxTrade(id: string): Promise<BoxOpenPosition[]> {
  const body = await request<{ ok?: boolean; open: BoxOpenPosition[] }>(
    `/api/box/trades/${encodeURIComponent(id)}/close`,
    "Failed to close the box position",
    { method: "POST" },
  );
  return body.open ?? [];
}

/**
 * PERMANENTLY delete a PAPER box trade. The backend refuses a live trade with 409, and that
 * message is surfaced as-is. `id` is an OPAQUE string.
 */
export async function deleteBoxTrade(id: string, reason?: string): Promise<BoxDeleteResult> {
  return request<BoxDeleteResult>(
    `/api/box/trades/${encodeURIComponent(id)}`,
    "Failed to delete the box trade",
    { method: "DELETE", ...(reason ? { body: { reason } } : {}) },
  );
}

/* --------------------------- execution control ------------------------------- */

export async function fetchBoxExecutionControl(): Promise<BoxExecutionControl> {
  return request<BoxExecutionControl>(
    "/api/box/execution-control",
    "Failed to load the box execution control state",
  );
}

export async function previewBoxExecutionMode(
  selection: BoxExecutionSelection,
): Promise<BoxModeTransitionVerdict> {
  return request<BoxModeTransitionVerdict>(
    "/api/box/execution-mode/preview",
    "Failed to preview the execution mode change",
    { method: "POST", body: { selection } },
  );
}

export async function setBoxPaperProfile(
  profile: "standard" | "live_parity" | "stress",
): Promise<BoxExecutionControl> {
  const body = await request<{ ok?: boolean; execution: BoxExecutionControl }>(
    "/api/box/execution-mode/paper-profile",
    "Failed to change the paper execution profile",
    { method: "POST", body: { profile } },
  );
  return body.execution;
}

export async function armBoxSession(
  maxCompletedTrades?: number,
): Promise<{ session: BoxSessionView; execution: BoxExecutionControl }> {
  return request<{ ok?: boolean; session: BoxSessionView; execution: BoxExecutionControl }>(
    "/api/box/session/arm",
    "Failed to arm the box trading session",
    {
      method: "POST",
      body: maxCompletedTrades === undefined ? {} : { max_completed_trades: maxCompletedTrades },
    },
  );
}

export async function disarmBoxSession(): Promise<{
  session: BoxSessionView;
  execution: BoxExecutionControl;
}> {
  return request<{ ok?: boolean; session: BoxSessionView; execution: BoxExecutionControl }>(
    "/api/box/session/disarm",
    "Failed to disarm the box trading session",
    { method: "POST" },
  );
}

export async function setBoxLiveControl(
  control: "box_entry_enabled" | "box_live_order_enabled" | "box_emergency_flatten",
  enabled: boolean,
): Promise<BoxStatus> {
  const body = await request<{ ok?: boolean; status: BoxStatus }>(
    `/api/box/controls/${control}`,
    `Failed to set ${control}`,
    { method: "POST", body: { enabled } },
  );
  return body.status;
}

/* ------------------------------ SSE stream url ------------------------------- */

/**
 * The Box SSE URL.
 *
 * NO token in the query string — EventSource is opened with `withCredentials: true`, so the
 * same-origin HttpOnly session cookie authenticates the stream exactly like every REST call.
 * Putting a session token here would both leak it into logs and defeat the whole point of an
 * HttpOnly cookie.
 */
export function boxStreamUrl(): string {
  return apiUrl("/api/box/stream");
}

/* --------------------- runtime + export + broker status ---------------------- */

/** Whole-system readiness (token/instruments/feed/depth/persistence/recovery). */
export async function fetchRuntimeStatus(): Promise<RuntimeStatus> {
  return request<RuntimeStatus>("/api/runtime/status", "Failed to load the runtime status");
}

/** Async Mongo reporting-replica status. A lag is expected and non-fatal. */
export async function fetchExportStatus(): Promise<ExportStatus> {
  return request<ExportStatus>("/api/export/status", "Failed to load the export status");
}

/** The active broker plus BOTH stored broker sessions and their readiness. */
export async function fetchBrokerStatus(): Promise<BrokerStatus> {
  return request<BrokerStatus>("/api/broker/status", "Failed to load the broker status");
}

/** Why a switch to `broker` would be refused right now, without attempting it. */
export async function fetchBrokerSwitchBlockers(
  broker: BrokerId,
): Promise<BrokerSwitchBlockersResponse> {
  return request<BrokerSwitchBlockersResponse>(
    `/api/broker/switch-blockers?broker=${encodeURIComponent(broker)}`,
    "Failed to check the broker switch",
  );
}

/**
 * Switch the active broker. Throws with the backend's 409 message and attaches the blockers
 * so the UI can list every reason the switch was refused, not one at a time.
 */
export async function selectBroker(broker: BrokerId): Promise<BrokerSelectResponse> {
  try {
    return await request<BrokerSelectResponse>("/api/broker/select", "Failed to select the broker", {
      method: "POST",
      body: { broker },
    });
  } catch (err) {
    // The wrapper already parsed the JSON error message; re-throw as-is. Blockers, when the
    // backend attaches them to the body, are surfaced via a dedicated blockers fetch by the
    // panel, so a plain rethrow here is sufficient and keeps the message intact.
    throw err instanceof Error ? err : new Error(`Failed to select ${broker}.`);
  }
}
