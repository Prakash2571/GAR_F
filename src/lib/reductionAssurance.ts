/**
 * THE ONLY PLACE THE UI IS ALLOWED TO SAY ANYTHING ABOUT EXITING AN OPEN POSITION.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Five separate messages asserted, unconditionally, that open positions could still be reduced:
 *
 *   runtimeBanners    "Live entry is blocked — … Open positions are still monitored and can still
 *                      exit."
 *   runtimeBanners    "The zerodha token was rejected. … can still exit."
 *   runtimeBanners    "Recovery is in progress — … Reduction continues; new entry is closed."
 *   BoxSessionControl "A consumed cycle could not be persisted. … Exit and residual flattening are
 *                      unaffected."
 *   BoxSessionControl "Durable session state is unreadable. … Exit, residual flattening and
 *                      reconciliation continue normally."
 *
 * Every one was written for the ordinary case — entry stopped by a flag or a budget — where the
 * claim is true. But the last two fire precisely when a DURABLE WRITE OR READ HAS FAILED, and the
 * first three also fire during a store outage. In that state GAR_B reports `exit_and_reduce`,
 * `protective_cancel` and `manage_working_orders` ALL FALSE: every reduction needs a durable write
 * before anything reaches the broker, so exits are refused, not queued.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND THEN A SECOND, SUBTLER VERSION OF THE SAME BUG: TWO SNAPSHOTS, FETCHED SEPARATELY
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Deriving the claim from `operational_readiness` was necessary but NOT sufficient, because the
 * dashboard fetches its two sources INDEPENDENTLY, on separate timers, with separate failure modes:
 *
 *   GET /api/runtime/status  → `RuntimeStatus`        (`pg_ready`, `live_entry.reasons`)
 *   GET /api/box/status      → `OperationalReadiness` (`exposure_management`, blockers)
 *
 * So they can and do disagree. The reproducing case:
 *
 *   FRESH runtime      live_entry.reasons = ["durable_store_unavailable"], pg_ready = true
 *   OLDER readiness    exit_and_reduce / protective_cancel / manage_working_orders ALL true
 *
 * Reading only `readiness` produced a single WARN banner that named the outage in its first clause
 * and then contradicted itself in the second:
 *
 *   "Live entry is blocked — the durable order-intent store cannot be written, so nothing can reach
 *    the broker. Open positions are still monitored, and the backend confirms exiting, reducing and
 *    protective cancellation all remain available."
 *
 * No outage banner at all, WARN rather than ERROR, and a promise of an exit route in the same
 * sentence that said nothing can reach the broker.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULES, AND WHY EACH ONE IS FAIL-CLOSED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 1. The outage is derived from BOTH sources. Whichever source reports it, it is reported.
 * 2. A durable-store outage from EITHER source yields `blocked`, overriding any "all three true"
 *    claim from the other. This is not a guess: an unwritable journal provably blocks all three
 *    permissions, because every reduction performs a durable write BEFORE the broker POST.
 * 3. Disagreement is never resolved in favour of the reassuring source. There is no ordering
 *    information in the payloads that would justify it — `RuntimeStatus` carries no timestamp or
 *    generation at all — so `observedAt` (client-side, optional) is used only to WORD the message
 *    more precisely, never to relax the verdict.
 * 4. A stale or never-successful refresh cannot produce `available`. It degrades to `unknown`.
 * 5. `unknown` is deliberately not folded into `available` or `blocked`. The absence of a verdict is
 *    not evidence of safety and must not read like it.
 * 6. Entry-only conditions are NOT treated as reduction problems. A disarmed
 *    `BOX_LIVE_TRADING_ENABLED` blocks entry and nothing else, and saying otherwise would train
 *    operators to ignore the sentence. Only the codes in `REDUCTION_BLOCKING_REASONS` override.
 */

import type {
  BoxExecutionControl,
  OperationalReadiness,
  RuntimeStatus,
} from "../api/types.ts";
import type { RefreshState } from "./statusIntegrity.ts";

export type ReductionAssurance = {
  state: "available" | "blocked" | "unknown";
  /** Safe to append to ANY message that reports entry being stopped. Never over-promises. */
  sentence: string;
  /** True when the durable store is reported unwritable by EITHER source. */
  outage: boolean;
  /** True when the two snapshots disagree and the display has failed closed as a result. */
  conflict: boolean;
  /** One sentence naming the disagreement, or null. Rendered as its own banner. */
  conflictDetail: string | null;
};

/**
 * Runtime `live_entry.reasons` codes that provably affect REDUCTION, not merely entry.
 *
 * Deliberately tiny, and it must stay that way. Every reduction — an exit, an emergency flatten, the
 * working-order cancel sweep, reconciliation — performs or reads the durable order-intent journal
 * BEFORE anything reaches the broker, so an unwritable/unreadable store blocks all three
 * permissions. Nothing else in that list has that property: `box_live_trading_disabled`,
 * `market_closed`, `scanner_stopped` and the rest stop ENTRY only, and treating them as reduction
 * problems would make the assurance useless in the ordinary case.
 */
export const REDUCTION_BLOCKING_REASONS: ReadonlySet<string> = new Set([
  "durable_store_unavailable",
  "postgres_unavailable",
]);

/** The readiness blocker code GAR_B raises when the durable store cannot be written. */
export const DURABLE_STORE_BLOCKER = "durable_store_unavailable";

const UNKNOWN_SENTENCE =
  "Whether open positions can still be exited is UNKNOWN — no readiness decision has been read, " +
  "so this is not a statement that they can. Verify at the broker before relying on it.";

const AVAILABLE_SENTENCE =
  "Open positions are still monitored, and the backend confirms exiting, reducing and protective " +
  "cancellation all remain available.";

const STALE_SENTENCE =
  "Whether open positions can still be exited is UNKNOWN — the readiness reading on screen is not " +
  "current, and a reduction permission read from a stale snapshot is not a permission. Verify at " +
  "the broker before relying on it.";

/** Shared tail for a blocked verdict: what is unavailable, why, and the one remaining route. */
function blockedSentence(missing: readonly string[], why: string): string {
  return (
    `REDUCTION IS NOT FULLY AVAILABLE — the backend reports ${missing.join(", ")} as unavailable. ` +
    `${why} Open exposure is unchanged and still owned; if it cannot wait, reduce it from the ` +
    `broker terminal.`
  );
}

/** All three, named individually — the wording used when the store itself is unwritable. */
const ALL_THREE = ["exiting and reducing", "protective cancellation", "managing working orders"];

/* ══════════════════════════ reading each source ══════════════════════════ */

/** Every blocker the readiness decision is currently raising, entry and reduction alike. */
function readinessBlockers(readiness: OperationalReadiness | null | undefined) {
  if (!readiness) return [];
  return [
    ...readiness.entry.reasons,
    ...readiness.exposure_management.blocked_reasons,
    ...readiness.reconciliation.blockers,
  ];
}

/** Does the BOX READINESS snapshot report the durable store as unwritable? */
export function readinessReportsOutage(readiness: OperationalReadiness | null | undefined): boolean {
  return readinessBlockers(readiness).some((b) => b.code === DURABLE_STORE_BLOCKER);
}

/**
 * Does the RUNTIME snapshot report the durable store as unwritable?
 *
 * `pg_ready === false` is a STARTUP outage. `live_entry.reasons` is what catches a MID-SESSION one,
 * because `pg_ready` is a startup latch: it records whether PostgreSQL answered at boot and stays
 * `true` for the rest of the day after a store dies. Checking only the latch is why a mid-session
 * failure showed no outage banner at all.
 */
export function runtimeReportsOutage(runtime: RuntimeStatus | null | undefined): boolean {
  if (!runtime) return false;
  if (runtime.pg_ready === false) return true;
  return (runtime.live_entry?.reasons ?? []).some((code) => REDUCTION_BLOCKING_REASONS.has(code));
}

/** Does the readiness snapshot claim all three reduction permissions? */
function readinessClaimsAvailable(readiness: OperationalReadiness | null | undefined): boolean {
  if (!readiness) return false;
  const e = readiness.exposure_management;
  return e.exit_and_reduce && e.protective_cancel && e.manage_working_orders;
}

/* ══════════════════════════ the combined verdict ══════════════════════════ */

export interface ReductionSources {
  runtime: RuntimeStatus | null | undefined;
  readiness: OperationalReadiness | null | undefined;
  /**
   * When each snapshot was OBSERVED by this client, if the caller tracks it.
   *
   * ONLY used to word the conflict message ("the readiness snapshot is N s older"). It can never
   * make a disagreement resolve in favour of the reassuring source — see rule 3 in the header.
   * `RuntimeStatus` carries no timestamp or generation of its own, so there is no payload-level
   * ordering to appeal to.
   */
  observedAt?: { runtime?: number | null; readiness?: number | null };
  /** Freshness of the polling loop. A non-fresh reading cannot yield `available`. */
  refresh?: RefreshState;
}

/**
 * THE combined verdict, derived from both snapshots.
 *
 * Fail-closed at every branch. The only path to `available` requires: a readiness decision present,
 * all three permissions true, NEITHER source reporting an outage, and a fresh refresh.
 */
export function reductionAssurance(sources: ReductionSources): ReductionAssurance {
  const { runtime, readiness, refresh } = sources;

  const runtimeOutage = runtimeReportsOutage(runtime);
  const readinessOutage = readinessReportsOutage(readiness);
  const claimsAvailable = readinessClaimsAvailable(readiness);
  const outage = runtimeOutage || readinessOutage;

  /*
   * THE OVERRIDE, and the whole point of this function taking both snapshots.
   *
   * An unwritable durable store blocks ALL THREE permissions, so a snapshot claiming otherwise is
   * either older than the outage or simply wrong. Either way the safe reading is the restrictive
   * one, and it is not a guess: it is what GAR_B does.
   */
  if (outage) {
    const conflict = claimsAvailable;
    const why =
      readinessBlockers(readiness).find((b) => b.code === DURABLE_STORE_BLOCKER)?.detail ??
      "The durable order-intent store cannot be written, so no order can be recorded before it is sent.";
    return {
      state: "blocked",
      sentence: blockedSentence(ALL_THREE, why),
      outage: true,
      conflict,
      conflictDetail: conflict ? describeConflict(sources, "runtime") : null,
    };
  }

  // No outage reported by either source. Now the readiness decision decides, if there is one.
  if (!readiness) {
    return { state: "unknown", sentence: UNKNOWN_SENTENCE, outage: false, conflict: false, conflictDetail: null };
  }

  const e = readiness.exposure_management;
  const missing: string[] = [];
  if (!e.exit_and_reduce) missing.push("exiting and reducing");
  if (!e.protective_cancel) missing.push("protective cancellation");
  if (!e.manage_working_orders) missing.push("managing working orders");

  if (missing.length > 0) {
    return {
      state: "blocked",
      sentence: blockedSentence(missing, e.blocked_reasons[0]?.detail ?? "See the readiness panel for the cause."),
      outage: false,
      conflict: false,
      conflictDetail: null,
    };
  }

  /*
   * All three permissions are true and no outage is reported. This is the ONLY path to `available`,
   * and it still has to clear freshness: a permission read from a stale snapshot is not a
   * permission, and the reading may simply predate a failure the next poll will reveal.
   */
  if (refresh && refresh.freshness !== "fresh") {
    return {
      state: "unknown",
      sentence: STALE_SENTENCE,
      outage: false,
      conflict: false,
      conflictDetail: null,
    };
  }

  return { state: "available", sentence: AVAILABLE_SENTENCE, outage: false, conflict: false, conflictDetail: null };
}

/** One sentence naming which source reported the outage and how far apart the snapshots are. */
function describeConflict(sources: ReductionSources, authority: "runtime" | "readiness"): string {
  const rt = sources.observedAt?.runtime ?? null;
  const rd = sources.observedAt?.readiness ?? null;
  const gap =
    rt !== null && rd !== null && Number.isFinite(rt) && Number.isFinite(rd)
      ? ` The Box readiness snapshot was read ${Math.max(0, Math.round((rt - rd) / 1000))}s before the runtime one.`
      : " The two snapshots are fetched independently and carry no shared ordering, so which is newer" +
        " cannot be established from the payloads.";
  const which =
    authority === "runtime"
      ? "the runtime status reports the durable store as unwritable while the Box readiness snapshot still lists all three reduction permissions as available"
      : "the Box readiness snapshot reports the durable store as unwritable while the runtime status does not";
  return (
    `CONFLICTING READINESS SNAPSHOTS: ${which}.${gap} The display has FAILED CLOSED and is showing ` +
    `the restrictive reading — an unwritable store blocks exiting, protective cancellation and ` +
    `working-order management alike, so the permissive snapshot cannot be acted on. Verify at the ` +
    `broker terminal.`
  );
}

/**
 * The same judgement from the EXECUTION-CONTROL arm verdict (`control.arm.exposure_management`).
 *
 * A second entry point rather than a second implementation: the control panels hold
 * `BoxExecutionControl` and never see `operational_readiness` or `RuntimeStatus`, and the payloads
 * express the verdict differently — the arm verdict is one `ok` boolean with blockers rather than
 * three named permissions. It cannot attribute the loss to a specific permission, and it does not
 * pretend to. Both paths produce the SAME sentence for the same situation.
 */
export function armReductionAssurance(
  control: BoxExecutionControl | null | undefined,
): ReductionAssurance {
  const verdict = control?.arm?.exposure_management;
  const base = { outage: false, conflict: false, conflictDetail: null } as const;
  if (!verdict) return { state: "unknown", sentence: UNKNOWN_SENTENCE, ...base };
  if (verdict.ok) return { state: "available", sentence: AVAILABLE_SENTENCE, ...base };

  const why = verdict.blockers?.[0]?.detail ?? "See the readiness panel for the cause.";
  return { state: "blocked", sentence: blockedSentence(["reducing exposure"], why), ...base };
}
