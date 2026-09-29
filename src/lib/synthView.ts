/**
 * Pure display logic of the Synthetic page. No React, no fetch: unit-tested directly.
 *
 * Nothing here DECIDES anything the backend decides (eligibility, fills, P&L, limits). It only
 * labels, filters and checks what the backend published, and turns the operator's typed input
 * into a value the backend will validate again.
 */

import type {
  SynthDepth,
  SynthDirection,
  SynthOpenPosition,
  SynthOpportunity,
  SynthSetting,
  SynthSettingValue,
  SynthSide,
  SynthTrade,
  SynthTradeLeg,
} from "../api/synth.ts";

export const ENTRY_BLOCK_LABEL: Record<string, string> = {
  paper_off: "auto-entry off",
  no_db: "storage not ready",
  feed_stale: "feed stale",
  calendar_uncovered: "calendar year not covered",
  position_open: "underlying already open",
  entering: "entering…",
  cooldown: "re-entry cooldown",
  expiry_cutoff: "expiry-day cutoff",
  session_warmup: "after-open warm-up",
  session_cutoff: "before-close cutoff",
  max_open: "max open reached",
  token_budget: "token budget full",
  confirming: "confirming on new books",
};

export const REJECT_LABEL: Record<string, string> = {
  no_quote: "no book",
  stale_quote: "stale book",
  missing_bid: "no bid",
  missing_ask: "no ask",
  insufficient_qty: "thin at touch",
  below_expected_net_profit: "below net gate",
  market_closed: "market closed",
  no_close: "no last-session price",
  crossed_book: "crossed book",
};

export const EXIT_REASON_LABEL: Record<string, string> = {
  EDGE_CONVERGED: "Edge converged",
  PROFIT_CAPTURE: "Profit capture",
  EXPIRY_SAFETY: "Expiry safety",
  EXPIRED: "Settled at expiry",
  MANUAL: "Manual close",
};

export function label(map: Record<string, string>, code: string | null | undefined): string {
  if (!code) return "";
  return map[code] ?? code.replace(/_/g, " ");
}

/** CSS class for a signed money figure. */
export function pnlClass(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0 || Number.isNaN(v)) return "";
  return v > 0 ? "is-pos" : "is-neg";
}

export function ageText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function offsetLabel(offset: number): string {
  if (offset === 0) return "ATM";
  return offset > 0 ? `ATM+${offset}` : `ATM${offset}`;
}

export interface RowFilter {
  direction: "all" | SynthDirection;
  bestOnly: boolean;
  positiveOnly: boolean;
  search: string;
}

/** Filter published rows. The backend already sorts best-first, so "best" keeps the first per symbol. */
export function filterRows(rows: SynthOpportunity[], f: RowFilter): SynthOpportunity[] {
  const q = f.search.trim().toUpperCase();
  const seen = new Set<string>();
  return rows.filter((o) => {
    if (f.direction !== "all" && o.direction !== f.direction) return false;
    if (f.positiveOnly && !((o.gross_edge ?? 0) > 0)) return false;
    if (q && !o.underlying.includes(q)) return false;
    if (f.bestOnly) {
      if (seen.has(o.underlying)) return false;
      seen.add(o.underlying);
    }
    return true;
  });
}

/* ------------------------------ fill evidence ------------------------------ */

function flip(side: SynthSide): SynthSide {
  return side === "BUY" ? "SELL" : "BUY";
}

/**
 * Whether a fill is supported by the book recorded with it: the limit equals the best level on
 * the side it takes, the whole quantity rested there, and the book was not crossed.
 * null = no book was recorded.
 */
export function checkAgainstBook(
  price: number | null,
  side: SynthSide,
  depth: SynthDepth | null | undefined,
  quantity: number,
): boolean | null {
  if (price === null || !depth || (depth.bids.length === 0 && depth.asks.length === 0)) return null;
  const top = side === "BUY" ? depth.asks[0] : depth.bids[0];
  const bid = depth.bids[0];
  const ask = depth.asks[0];
  const crossed = bid !== undefined && ask !== undefined && bid.price >= ask.price;
  return top !== undefined && Math.abs(price - top.price) < 1e-6 && top.qty >= quantity && !crossed;
}

export interface FillView {
  role: SynthTradeLeg["role"];
  name: string;
  side: SynthSide;
  price: number | null;
  bid: number | null;
  ask: number | null;
  qtyAtTouch: number | null;
  ageMs: number | null;
  depth: SynthDepth | null;
  atBest: boolean | null;
}

export function legName(l: { instrument_type: string; strike: number }): string {
  return l.instrument_type === "FUT" ? "FUT" : `${l.strike} ${l.instrument_type}`;
}

export function fillOf(l: SynthTradeLeg, phase: "entry" | "exit", quantity: number): FillView {
  const entry = phase === "entry";
  const side = entry ? l.side : flip(l.side);
  const price = entry ? l.entry_price : l.exit_price;
  const depth = (entry ? l.entry_depth : l.exit_depth) ?? null;
  return {
    role: l.role,
    name: legName(l),
    side,
    price,
    bid: (entry ? l.entry_bid : l.exit_bid) ?? null,
    ask: (entry ? l.entry_ask : l.exit_ask) ?? null,
    qtyAtTouch: (entry ? l.entry_qty_at_touch : l.exit_qty_at_touch) ?? null,
    ageMs: (entry ? l.entry_age_ms : l.exit_age_ms) ?? null,
    depth,
    atBest: checkAgainstBook(price, side, depth, quantity),
  };
}

/** true = every leg at the best price; false = one was not; null = not recorded. */
export function fillVerdict(legs: SynthTradeLeg[], phase: "entry" | "exit", quantity: number): boolean | null {
  const checks = legs.map((l) => fillOf(l, phase, quantity).atBest);
  if (checks.some((c) => c === false)) return false;
  if (checks.length === 0 || checks.some((c) => c === null)) return null;
  return true;
}

/* ------------------------------ open positions ----------------------------- */

/** Why an open position is not closing, so the page never looks asleep. */
export function heldText(p: SynthOpenPosition, money: (v: number | null) => string): string {
  if (!p.linked) {
    return "Held: its contracts are not resolved on the active broker yet, so it cannot be priced. It re-links automatically and still settles at expiry.";
  }
  if (p.held_reason === "auto_exit_off") {
    return "Exit rules are met, but automatic exits are OFF in Settings. Close it manually or turn them back on.";
  }
  if (p.exit_blocked_reason === "insufficient_exit_liquidity") {
    return p.expiry_safety
      ? "Held: expiry safety is closing this position whatever its P&L, but not every leg shows the full quantity at the touch."
      : "Held: the exit rules are met, but not every leg shows the full quantity at the touch.";
  }
  if (p.net_pnl === null) {
    return "Held: a leg has no closing price (no book yet, or the market is shut). No fill is invented.";
  }
  if (p.held_reason === "confirming") return "Exit conditions met: confirming on new books.";
  if (p.net_pnl <= 0) {
    return `Held: closing now would realise ${money(p.net_pnl)} after charges. The lock pays at expiry, so it waits to converge in profit.`;
  }
  const converged = p.remaining_edge !== null && p.remaining_edge <= p.convergence_threshold;
  if (!converged && p.net_pnl < p.profit_capture_target) {
    return `Held: ${money(p.net_pnl)} after charges, but the edge has not converged (remaining ${money(p.remaining_edge)} > ${money(p.convergence_threshold)}) and profit is below the ${money(p.profit_capture_target)} capture level.`;
  }
  if (p.net_pnl < p.min_exit_net_pnl) {
    return `Held: net ${money(p.net_pnl)} is below the ${money(p.min_exit_net_pnl)} minimum for an early exit.`;
  }
  return "Held: waiting for the next evaluation.";
}

/** Merge closed trades by id, newest-closed first, never re-adding a deleted one. */
export function mergeClosed(prev: SynthTrade[], incoming: SynthTrade[], deleted: ReadonlySet<string>): SynthTrade[] {
  const byId = new Map(prev.map((t) => [t.id, t]));
  for (const t of incoming) if (!deleted.has(t.id)) byId.set(t.id, t);
  return [...byId.values()]
    .filter((t) => !deleted.has(t.id))
    .sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? ""));
}

/** IST calendar day (YYYY-MM-DD) of an ISO time. */
export function istDay(iso: string | null): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  return new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export function groupByDay(trades: SynthTrade[]): { day: string; trades: SynthTrade[]; net: number; gross: number; fees: number }[] {
  const m = new Map<string, SynthTrade[]>();
  for (const t of trades) {
    const d = istDay(t.closed_at ?? t.opened_at);
    const g = m.get(d);
    if (g) g.push(t);
    else m.set(d, [t]);
  }
  return [...m.entries()]
    .sort(([a], [b]) => (a === "unknown" ? 1 : b === "unknown" ? -1 : b.localeCompare(a)))
    .map(([day, list]) => ({
      day,
      trades: list,
      net: list.reduce((s, t) => s + (t.net_pnl ?? 0), 0),
      gross: list.reduce((s, t) => s + (t.gross_pnl ?? 0), 0),
      fees: list.reduce((s, t) => s + (t.total_charges ?? 0), 0),
    }));
}

/* --------------------------------- settings -------------------------------- */

export const GROUP_LABEL: Record<string, string> = {
  broker: "Broker",
  scanner: "Scanner",
  entry: "Entry",
  exit: "Exit",
  charges: "Charges",
  calendar: "Calendar",
};

export function groupSettings(settings: SynthSetting[], groups: string[]): { group: string; settings: SynthSetting[] }[] {
  return groups
    .map((g) => ({ group: g, settings: settings.filter((s) => s.group === g) }))
    .filter((g) => g.settings.length > 0);
}

export type ParseResult = { ok: true; value: SynthSettingValue } | { ok: false; error: string };

/** Turn a typed draft into a value. The backend validates again; this only catches typos early. */
export function parseDraft(s: SynthSetting, text: string): ParseResult {
  if (s.kind === "list") {
    const items = text
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (s.list_item === "symbol" ? x.toUpperCase() : x));
    if (s.list_item === "date") {
      const bad = items.find((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
      if (bad) return { ok: false, error: `${bad} is not a YYYY-MM-DD date` };
    }
    return { ok: true, value: [...new Set(items)] };
  }
  if (s.kind === "enum") {
    return s.options?.includes(text) ? { ok: true, value: text } : { ok: false, error: "choose one of the options" };
  }
  if (s.kind === "bool") return { ok: true, value: text === "true" };
  const trimmed = text.trim();
  const v = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(v)) return { ok: false, error: "must be a number" };
  if (s.kind === "int" && !Number.isInteger(v)) return { ok: false, error: "must be a whole number" };
  if (s.min !== undefined && v < s.min) return { ok: false, error: `minimum ${s.min}` };
  if (s.max !== undefined && v > s.max) return { ok: false, error: `maximum ${s.max}` };
  return { ok: true, value: v };
}

export function draftOf(s: SynthSetting): string {
  if (Array.isArray(s.value)) return s.value.join(", ");
  return String(s.value);
}

export function sameValue(a: SynthSettingValue, b: SynthSettingValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function formatSettingValue(s: SynthSetting, v: SynthSettingValue): string {
  if (Array.isArray(v)) return v.length === 0 ? "(empty)" : v.join(", ");
  if (typeof v === "boolean") return v ? "on" : "off";
  if (s.unit === "₹" && typeof v === "number") return `₹${v.toLocaleString("en-IN")}`;
  return s.unit ? `${v} ${s.unit}` : String(v);
}

export const BROKER_MODE_LABEL: Record<string, string> = {
  follow_active: "Follow Box's broker",
  zerodha: "Zerodha",
  dhan: "Dhan",
};
