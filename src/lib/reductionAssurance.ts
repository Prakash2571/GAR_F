/**
 * THE ONLY PLACE THE UI IS ALLOWED TO SAY ANYTHING ABOUT EXITING AN OPEN POSITION.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Five separate messages asserted, unconditionally, that open positions could still be reduced:
 *
 *   runtimeBanners   "Live entry is blocked — … Open positions are still monitored and can still exit."
 *   runtimeBanners   "The zerodha token was rejected. … can still exit."
 *   runtimeBanners   "Recovery is in progress — … Reduction continues; new entry is closed."
 *   BoxSessionControl "A consumed cycle could not be persisted. … Exit and residual flattening are
 *                      unaffected."
 *   BoxSessionControl "Durable session state is unreadable. … Exit, residual flattening and
 *                      reconciliation continue normally."
 *
 * Every one was written for the ordinary case — entry stopped by a flag or a budget — where the
 * claim is true. But the last two fire precisely when a DURABLE WRITE OR READ HAS FAILED, and the
 * first three also fire during a store outage. In that state GAR_B reports `exit_and_reduce`,
 * `protective_cancel` and `manage_working_orders` ALL FALSE: every reduction needs a durable write
 * before anything reaches the broker, so exits are refused, not queued. The UI was reassuring
 * operators at the exact moment the reassurance was false and the broker terminal was the only route
 * left.
 *
 * Scattering the fix across five call sites would have left five things to keep in step. This module
 * is the single derivation, so a sixth message cannot be written without going through it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The assurance is DERIVED, or it is not made. THREE states, never two — "unknown" is deliberately
 * not folded into either "available" or "blocked", because the absence of a backend verdict is not
 * evidence of safety and must not read like it.
 */

import type { BoxExecutionControl, OperationalReadiness } from "../api/types.ts";

export type ReductionAssurance = {
  state: "available" | "blocked" | "unknown";
  /** Safe to append to ANY message that reports entry being stopped. Never over-promises. */
  sentence: string;
};

const UNKNOWN_SENTENCE =
  "Whether open positions can still be exited is UNKNOWN — no readiness decision has been read, " +
  "so this is not a statement that they can. Verify at the broker before relying on it.";

const AVAILABLE_SENTENCE =
  "Open positions are still monitored, and the backend confirms exiting, reducing and protective " +
  "cancellation all remain available.";

/** Shared tail for a blocked verdict: what is unavailable, why, and the one remaining route. */
function blockedSentence(missing: readonly string[], why: string): string {
  return (
    `REDUCTION IS NOT FULLY AVAILABLE — the backend reports ${missing.join(", ")} as unavailable. ` +
    `${why} Open exposure is unchanged and still owned; if it cannot wait, reduce it from the ` +
    `broker terminal.`
  );
}

/**
 * Derived from THE ONE authoritative readiness decision (`box_status.operational_readiness`).
 *
 * The three permissions are named INDIVIDUALLY because they fail independently and an operator's
 * next move differs: losing `manage_working_orders` while `exit_and_reduce` holds is a very
 * different afternoon from the reverse. Collapsing them into one boolean is what made the old
 * blanket sentence possible in the first place.
 */
export function reductionAssurance(
  readiness: OperationalReadiness | null | undefined,
): ReductionAssurance {
  if (!readiness) return { state: "unknown", sentence: UNKNOWN_SENTENCE };

  const e = readiness.exposure_management;
  const missing: string[] = [];
  if (!e.exit_and_reduce) missing.push("exiting and reducing");
  if (!e.protective_cancel) missing.push("protective cancellation");
  if (!e.manage_working_orders) missing.push("managing working orders");

  if (missing.length === 0) return { state: "available", sentence: AVAILABLE_SENTENCE };

  return {
    state: "blocked",
    // The contract permits an empty reason list, so this must still read as a sentence.
    sentence: blockedSentence(missing, e.blocked_reasons[0]?.detail ?? "See the readiness panel for the cause."),
  };
}

/**
 * The same judgement from the EXECUTION-CONTROL arm verdict (`control.arm.exposure_management`).
 *
 * A second entry point rather than a second implementation: the control panels hold
 * `BoxExecutionControl` and never see `operational_readiness`, and the two payloads express the
 * verdict differently — the arm verdict is one `ok` boolean with blockers rather than three named
 * permissions. It cannot therefore attribute the loss to a specific permission, and it does not
 * pretend to: `ok === false` yields the blocked wording without naming which of the three is gone.
 * Both paths produce the SAME sentence for the same situation, which is the point.
 */
export function armReductionAssurance(
  control: BoxExecutionControl | null | undefined,
): ReductionAssurance {
  const verdict = control?.arm?.exposure_management;
  if (!verdict) return { state: "unknown", sentence: UNKNOWN_SENTENCE };
  if (verdict.ok) return { state: "available", sentence: AVAILABLE_SENTENCE };

  const why = verdict.blockers?.[0]?.detail ?? "See the readiness panel for the cause.";
  return { state: "blocked", sentence: blockedSentence(["reducing exposure"], why) };
}
