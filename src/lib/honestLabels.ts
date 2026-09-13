/**
 * HONEST LABELLING — the wording that must change when the system's mode does.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT INLINE STRINGS (SECTION 7)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Three of the display defects in this section are one defect: a sentence hardcoded at a point where
 * the system's actual mode was not consulted.
 *
 *   • "Box arbitrage · paper trading, one lot" sat in the page header as a literal. Under
 *     BOX_EXECUTION_MODE=live it kept saying "paper trading" — the single most dangerous label a
 *     trading UI can get wrong, because it invites an operator to press a button they would not
 *     press if it said LIVE.
 *   • Scanner STOP said "no new boxes will be opened" but not, unambiguously, whether existing
 *     positions were still being watched. The difference between "stopped scanning" and "stopped
 *     caring about my open box" is the difference between a routine pause and an emergency.
 *   • An UNKNOWN P&L rendered through a numeric formatter becomes ₹0 — a specific, false claim of
 *     break-even, made at exactly the moment the system does not know.
 *
 * Putting the wording in pure functions means the mode is a required ARGUMENT: a label cannot be
 * produced without stating which mode it describes, so this class of defect cannot be reintroduced
 * by forgetting a conditional. Every function here is pure and directly unit-tested.
 */

import type { BoxStatus, OperationalReadiness } from "../api/types.ts";

/* ═══════════════════════════ 1. MODE LABELS ═══════════════════════════ */

export interface ModeLabel {
  /** Short badge text, e.g. "LIVE — real orders" or "paper trading". */
  badge: string;
  /** The subtitle line under the product name. */
  subtitle: string;
  /** True when real broker orders can be produced by this deployment. */
  live: boolean;
  /** One sentence stating what this mode does and does not do. */
  detail: string;
}

/**
 * The mode label, from the backend's OWN `execution_mode` — never a constant.
 *
 * `live` is decided by the mode string alone. `live_runtime_armed` is deliberately NOT part of it:
 * a live deployment with its runtime controls disarmed is still a LIVE deployment, one toggle away
 * from real orders, and labelling it "paper" for as long as it is disarmed is exactly the
 * reassurance that gets someone to press the toggle.
 */
export function modeLabel(executionMode: string | null | undefined): ModeLabel {
  const mode = (executionMode ?? "").trim();
  if (mode === "") {
    // Unknown mode ⇒ say so. Defaulting to "paper" would be a guess in the dangerous direction.
    return {
      badge: "mode unknown",
      subtitle: "Four-leg box arbitrage · NSE F&O · execution mode UNKNOWN, one lot",
      live: false,
      detail:
        "The backend has not reported an execution mode. Do not assume this is paper: treat every " +
        "control as potentially live until the mode is known.",
    };
  }
  if (mode === "live") {
    return {
      badge: "LIVE — real orders",
      subtitle: "Four-leg box arbitrage · NSE F&O · LIVE, real money, one lot",
      live: true,
      detail:
        "This deployment can place REAL orders with REAL money at the configured broker. Nothing " +
        "here is a simulation, and no fill, four-leg completion or maximum loss is guaranteed.",
    };
  }
  // Every non-live mode is a simulation, but they are not interchangeable, so the mode is named.
  const pretty = mode.replace(/_/g, " ");
  return {
    badge: `paper — ${pretty}`,
    subtitle: `Four-leg box arbitrage · NSE F&O · paper trading (${pretty}), one lot`,
    live: false,
    detail:
      `This deployment is running the ${pretty} simulation. No order reaches any broker. Simulated ` +
      `fills are modelled, not promised, and they are not evidence of live behaviour.`,
  };
}

/* ═══════════════════════════ 2. SCANNER STOP ═══════════════════════════ */

export interface ScannerStopExplanation {
  headline: string;
  /** Explicit, separate statements about entry and about existing positions. */
  entryEffect: string;
  positionsEffect: string;
  /** True when the backend's decision confirms exposure is still manageable. */
  positionsManageable: boolean;
}

/**
 * What stopping the scanner ACTUALLY does — entry and existing positions stated SEPARATELY.
 *
 * The two statements are deliberately never merged into one sentence. "Scanner stopped" answers a
 * question about ENTRY; whether an open box is still watched and still exitable is a different fact,
 * and it comes from the backend's `exposure_management`, not from the scanner state.
 *
 * When the decision is absent the positions answer is UNKNOWN rather than reassuring: telling an
 * operator their position is safe on no evidence is the worst possible way to be wrong here.
 */
export function explainScannerStop(
  monitoring: boolean,
  decision: OperationalReadiness | null | undefined,
): ScannerStopExplanation {
  const manageable = decision?.exposure_management.exit_and_reduce ?? false;
  const openPositions = decision?.exposure_management.open_positions ?? null;
  const residual = decision?.exposure_management.residual_legs ?? null;

  const positionsEffect = !decision
    ? "Whether open positions are still being monitored is UNKNOWN — the backend has published no " +
      "readiness decision. Verify directly before relying on it."
    : manageable
      ? `Existing positions ARE still monitored and can still be exited, reduced and protectively ` +
        `cancelled${openPositions === null ? "" : ` (${openPositions} open`}` +
        `${residual !== null && residual > 0 ? `, ${residual} residual leg(s)` : ""}` +
        `${openPositions === null ? "" : ")"}. Stopping the scanner stops ENTRY only.` +
        (monitoring ? "" : " The monitor loop is not reporting as running — verify before relying on auto-exit.")
      : `Existing positions are still held, but the backend reports that reducing them is currently ` +
        `BLOCKED: ${(decision.exposure_management.blocked_reasons[0]?.detail ?? "see the readiness panel")} ` +
        `This is not a consequence of stopping the scanner.`;

  return {
    headline: "Scanner stopped.",
    entryEffect: "No NEW box will be opened. This affects entry only.",
    positionsEffect,
    positionsManageable: manageable,
  };
}

/* ═══════════════════════════ 3. EXPOSURE AND UNKNOWN P&L ═══════════════════════════ */

/**
 * A money figure that may be UNKNOWN.
 *
 * `known: false` is not "zero". A box whose legs cannot currently be priced has an unknown mark, and
 * a formatter that turns that into "₹0" states break-even — a specific claim, made confidently, at
 * the one moment the system has no basis for it. So the unknown case carries its own display string
 * and its own reason.
 */
export interface MoneyView {
  known: boolean;
  /** Display text. "—" (with a reason) when unknown; never "₹0" for an unknown figure. */
  text: string;
  /** Why it is unknown. Empty when known. */
  reason: string;
}

/** Format rupees, or report the figure as unknown with a reason. Never fabricates a zero. */
export function moneyView(
  value: number | null | undefined,
  reasonWhenUnknown = "not currently priceable",
): MoneyView {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { known: false, text: "—", reason: `unknown — ${reasonWhenUnknown}` };
  }
  const sign = value < 0 ? "−" : "";
  return { known: true, text: `${sign}₹${Math.abs(Math.round(value)).toLocaleString("en-IN")}`, reason: "" };
}

export interface ExposureView {
  /** Boxes currently open, per the backend decision. */
  openPositions: number;
  /** Residual (partial-entry) legs still outstanding — exposure without a complete box. */
  residualLegs: number;
  /** Orders still working at the broker. */
  workingOrders: number;
  /** True when ANY exposure exists — open boxes, residual legs or working orders. */
  hasExposure: boolean;
  /** One sentence naming what is actually outstanding. */
  detail: string;
  /** The backend's real limitations on reducing it. Contractually non-empty when a decision exists. */
  limitations: readonly string[];
}

/**
 * REMAINING EXPOSURE, from the backend decision.
 *
 * Residual legs are counted and named separately from open boxes because they are the more dangerous
 * quantity: a residual leg is exposure WITHOUT the offsetting structure that made it acceptable.
 * Folding it into an "open positions" count would hide the difference.
 */
export function deriveExposure(decision: OperationalReadiness | null | undefined): ExposureView {
  if (!decision) {
    return {
      openPositions: 0,
      residualLegs: 0,
      workingOrders: 0,
      hasExposure: false,
      detail:
        "Remaining exposure is UNKNOWN — the backend has published no readiness decision. This is " +
        "not the same as flat.",
      limitations: [],
    };
  }
  const e = decision.exposure_management;
  const hasExposure = e.open_positions > 0 || e.residual_legs > 0 || e.working_orders > 0;
  const parts: string[] = [];
  if (e.open_positions > 0) parts.push(`${e.open_positions} open box(es)`);
  if (e.residual_legs > 0) parts.push(`${e.residual_legs} RESIDUAL leg(s) — exposure without a complete box`);
  if (e.working_orders > 0) parts.push(`${e.working_orders} working order(s) at the broker`);
  return {
    openPositions: e.open_positions,
    residualLegs: e.residual_legs,
    workingOrders: e.working_orders,
    hasExposure,
    detail: hasExposure
      ? `Outstanding: ${parts.join("; ")}.`
      : "No open box, residual leg or working order is currently reported.",
    limitations: e.limitations,
  };
}

/**
 * The running-P&L view for the day strip, with UNPRICED legs reported as unknown.
 *
 * `indicative_stale_legs` is the count the backend already publishes for legs it could not price in
 * the current session. When it is non-zero the running figure is INCOMPLETE, and saying so is the
 * difference between a number and a claim.
 */
export function deriveRunningPnl(
  status: Pick<BoxStatus, "day_pnl" | "indicative_stale_legs"> | null | undefined,
): { net: MoneyView; complete: boolean; detail: string } {
  const stale = status?.indicative_stale_legs ?? 0;
  const net = status?.day_pnl?.open_running_net_pnl;
  const complete = stale === 0;
  const view = complete
    ? moneyView(net, "no running mark is available")
    : { known: false, text: "—", reason: `unknown — ${stale} leg(s) could not be priced this session` };
  return {
    net: view,
    complete,
    detail: complete
      ? "Running net P&L on open boxes, marked at the current executable touch. A mark is not a fill."
      : `${stale} leg(s) could not be priced this session, so the running figure is INCOMPLETE and is ` +
        `reported as unknown rather than as a number that looks whole.`,
  };
}
