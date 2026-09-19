/**
 * STATUS INTEGRITY — the three ways a correct backend answer still gets displayed wrongly.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS (SECTION 7)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Unifying the permission decision fixes WHAT the backend says. It does nothing about three
 * failure modes that live entirely on this side of the wire, each of which turns a correct answer
 * into a false display:
 *
 *   1. OUT-OF-ORDER RESPONSES. `box_status` arrives from five places on this page — the initial
 *      REST load, the opportunities fetch, the SSE snapshot flush, and the responses to the
 *      scanner and strike-level mutations. They are independent requests over one connection pool,
 *      so they can and do resolve out of order. A slow older response landing after a newer one
 *      silently rewinds the dashboard: a stale "entry permitted" can overwrite a fresh
 *      "entry blocked". `acceptDecision` refuses that using the backend's monotonic
 *      `decision_generation`.
 *
 *   2. A FAILED OR EXPIRED REFRESH THAT LEAVES STALE DATA LOOKING CURRENT. The runtime poll used
 *      `.catch(() => {})`. So when the endpoint started failing, the last good snapshot simply
 *      stayed on screen — indistinguishable from a healthy system, for as long as the failure
 *      lasted. `RefreshTracker` makes the age and the failure explicit so the UI can go
 *      stale/unknown rather than confidently wrong.
 *
 *   3. DOUBLE-SUBMITTED MUTATIONS. Guards written as `disabled={busy !== null}` read `busy` from
 *      the render closure. React state updates are asynchronous, so two clicks in the same frame
 *      BOTH observe the pre-update value and BOTH fire the request. `ControlRequests` tracks
 *      in-flight requests in a ref-friendly, SYNCHRONOUS map, so the second click is refused
 *      before it reaches the network.
 *
 * PURE: no React, no fetch, no globals, no clock except an injected `now`. That is what lets the
 * component logic be tested directly under `node:test` (this project's harness cannot render TSX),
 * and it is the SAME code the components run — not a parallel copy.
 */

import type { OperationalReadiness } from "../api/types.ts";

/* ═══════════════════════════ 1. OUT-OF-ORDER RESPONSES ═══════════════════════════ */

/**
 * Should an incoming readiness decision be APPLIED, or IGNORED as out-of-order?
 *
 * The rule is strict monotonicity on the backend's own `decision_generation`, which the backend
 * increments once per decision. Equal is also refused: re-applying the same generation cannot add
 * information, and treating it as new would reset any "this is fresh" timer built on top.
 *
 * Wall-clock timestamps are deliberately NOT used for this. `decided_at` comes from the server, the
 * comparison would be against a client clock, and a client whose clock is a few seconds off would
 * either accept every stale response or reject every fresh one. A monotonic counter minted by the
 * one authority that orders these decisions has neither problem.
 *
 * @param current  the generation already rendered, or null when nothing has been rendered yet.
 * @param incoming the generation of the response that just arrived.
 */
export function acceptDecision(current: number | null, incoming: number): boolean {
  if (!Number.isFinite(incoming)) return false; // a malformed generation is not evidence
  if (current === null) return true;
  return incoming > current;
}

/**
 * The generation carried by a status payload, or null when it carries none.
 *
 * Tolerant on purpose: this runs against whatever actually arrived, including an older backend or a
 * truncated body. A payload with no generation is treated as "cannot be ordered", and the caller
 * must then refuse it rather than guess — see `acceptStatus`.
 */
export function decisionGenerationOf(
  status: { operational_readiness?: Pick<OperationalReadiness, "decision_generation"> } | null | undefined,
): number | null {
  const gen = status?.operational_readiness?.decision_generation;
  return typeof gen === "number" && Number.isFinite(gen) ? gen : null;
}

/**
 * The guard the components actually call: accept this status, or ignore it?
 *
 * An UNORDERABLE payload (no generation at all) is accepted ONLY when nothing has been rendered
 * yet, so a first paint still works against an older backend. Once an ordered decision is on
 * screen, an unorderable one can no longer replace it — because there is no way to know it is not
 * older, and "possibly older" must not overwrite "known current".
 */
export function acceptStatus(
  currentGeneration: number | null,
  incoming: { operational_readiness?: Pick<OperationalReadiness, "decision_generation"> } | null | undefined,
): boolean {
  if (!incoming) return false;
  const gen = decisionGenerationOf(incoming);
  if (gen === null) return currentGeneration === null;
  return acceptDecision(currentGeneration, gen);
}

/* ═══════════════════════════ 2. REFRESH FRESHNESS ═══════════════════════════ */

/** How much to trust what is currently on screen. */
export type Freshness = "fresh" | "stale" | "unknown";

export interface RefreshState {
  /** `fresh` = a recent success. `stale` = a success, but too old. `unknown` = never succeeded. */
  freshness: Freshness;
  /** Age of the last SUCCESSFUL refresh, or null when there has never been one. */
  ageMs: number | null;
  /** Consecutive failures since the last success. 0 when the last attempt succeeded. */
  consecutiveFailures: number;
  /** The last failure message, bounded by the caller. Null when the last attempt succeeded. */
  lastError: string | null;
  /** One sentence for the operator. Always populated. */
  detail: string;
}

/**
 * Tracks whether what is on screen is still worth believing.
 *
 * NOT a cache and NOT a retry policy — it holds no data and issues no requests. It records the
 * outcome of refreshes the caller performs and answers one question: is the displayed data fresh,
 * stale, or unknown? The distinction between STALE (we had an answer, it is now too old) and
 * UNKNOWN (we have never had an answer) is kept because they call for different operator actions,
 * and collapsing them is how "never loaded" ends up looking like "loaded and fine".
 */
export class RefreshTracker {
  private lastOkAt: number | null = null;
  private failures = 0;
  private error: string | null = null;
  /**
   * Age (ms) after which a successful refresh stops counting as fresh.
   *
   * Declared as an explicit field and assigned in the body rather than as a constructor parameter
   * property: this project's test harness runs `node --experimental-strip-types`, which strips types
   * but performs no transform, and a parameter property REQUIRES one. Keeping the module
   * strip-compatible is what lets the tests exercise this exact code instead of a copy of it.
   */
  private readonly maxAgeMs: number;

  constructor(maxAgeMs: number) {
    this.maxAgeMs = maxAgeMs;
  }

  /** Record a SUCCESSFUL refresh at `at`. Clears the failure streak. */
  recordSuccess(at: number): void {
    this.lastOkAt = at;
    this.failures = 0;
    this.error = null;
  }

  /**
   * Record a FAILED refresh. The last successful timestamp is deliberately preserved: the data on
   * screen is still whatever that success delivered, and its true age is what matters. What must
   * NOT happen — and what `.catch(() => {})` did — is for the failure to leave no trace at all.
   */
  recordFailure(message: string): void {
    this.failures += 1;
    this.error = message;
  }

  /** The current verdict, evaluated at `now`. */
  state(now: number): RefreshState {
    const ageMs = this.lastOkAt === null ? null : Math.max(0, now - this.lastOkAt);
    const freshness: Freshness =
      ageMs === null ? "unknown" : ageMs <= this.maxAgeMs && this.failures === 0 ? "fresh" : "stale";
    return {
      freshness,
      ageMs,
      consecutiveFailures: this.failures,
      lastError: this.error,
      detail: describeRefresh(freshness, ageMs, this.failures, this.error),
    };
  }
}

function describeRefresh(
  freshness: Freshness,
  ageMs: number | null,
  failures: number,
  error: string | null,
): string {
  if (freshness === "unknown") {
    return failures > 0
      ? `This has never loaded successfully (${failures} failed attempt(s)${error ? `: ${error}` : ""}). ` +
          `Nothing here is a current reading.`
      : "This has not loaded yet. Nothing here is a current reading.";
  }
  if (freshness === "stale") {
    const age = ageMs === null ? "unknown" : `${Math.round(ageMs / 1000)}s`;
    return failures > 0
      ? `The last ${failures} refresh(es) FAILED${error ? ` (${error})` : ""}. What is shown is ${age} old ` +
          `and may no longer be true.`
      : `The last successful refresh was ${age} ago, past the freshness limit. Treat this as stale.`;
  }
  return `Refreshed ${ageMs === null ? "just now" : `${Math.round(ageMs / 1000)}s ago`}.`;
}

/**
 * The band a freshness verdict should be RENDERED in.
 *
 * Stale and unknown never render as `ready`. This is the mechanical guarantee behind "an expired or
 * failed status refresh visibly becomes stale/unknown": the band, and therefore the colour and the
 * glyph, change without the component having to remember to check.
 */
export function freshnessBand(freshness: Freshness): "ready" | "paused" | "unknown" {
  switch (freshness) {
    case "fresh":
      return "ready";
    case "stale":
      return "paused";
    case "unknown":
      return "unknown";
  }
}

/* ═══════════════════════════ 3. SINGLE-FLIGHT CONTROL REQUESTS ═══════════════════════════ */

/**
 * The DISTINCT control classes. Keeping them separate is a safety requirement, not tidiness.
 *
 * A single shared `busy` flag had two failure modes, in opposite directions:
 *   - it let a rapid double-click through (React state is asynchronous, so both clicks read the
 *     stale `busy === null`), and
 *   - while any one request was in flight it disabled EVERYTHING — including `emergency`. Blocking
 *     an emergency action because someone had just clicked "arm entry" is strictly worse than
 *     allowing it.
 *
 * So each class gets its own in-flight slot:
 *   entry_arming            arming/disarming NEW-ENTRY permission
 *   live_order_management   the live order path (modify/chase/cancel authority)
 *   emergency               emergency flatten — never queued behind another control
 *   session_arming          arming/disarming the supervised trading SESSION and its budget
 *   scanner                 starting/stopping the opportunity scanner
 *   mode                    execution-mode / paper-profile changes
 *   broker                  switching the active broker
 *   trade                   a per-trade action (close/delete), keyed per trade id
 */
export type ControlClass =
  | "entry_arming"
  | "live_order_management"
  | "emergency"
  | "session_arming"
  | "scanner"
  | "mode"
  | "broker"
  | "trade"
  // Operator CONFIGURATION writes. Its own class, not folded into "mode" or "trade", because a
  // configuration PATCH carries an optimistic-concurrency version: two concurrent writes would have
  // the second refused as stale, and the operator would see a spurious failure for a change they
  // only submitted once. Single-flighting it makes the double-click a no-op instead.
  | "configuration";

/** Human label per control class, so a refusal names the control the operator actually pressed. */
export const CONTROL_LABEL: Readonly<Record<ControlClass, string>> = Object.freeze({
  configuration: "configuration",
  entry_arming: "entry arming",
  live_order_management: "live-order management",
  emergency: "emergency action",
  session_arming: "session arming",
  scanner: "scanner",
  mode: "execution mode",
  broker: "broker switch",
  trade: "trade action",
});

/**
 * SYNCHRONOUS single-flight registry for control mutations.
 *
 * `begin` returns false when a request for that key is ALREADY in flight, and the caller must then
 * not send. Because the map is mutated synchronously inside the click handler — not stored in React
 * state — the second of two clicks in the same frame sees the first one's entry and is refused.
 * That is the whole point: a guard that depends on a re-render cannot prevent a double-submit that
 * happens before the re-render.
 *
 * Keys are `class` or `class:id`, so two DIFFERENT trades can be closed concurrently while the same
 * trade cannot be closed twice — and an emergency action is never blocked by an unrelated control.
 */
export class ControlRequests {
  private readonly inFlight = new Set<string>();

  static key(cls: ControlClass, id?: string): string {
    return id === undefined || id === "" ? cls : `${cls}:${id}`;
  }

  /** Claim the slot. False ⇒ a request is already in flight and this one MUST NOT be sent. */
  begin(cls: ControlClass, id?: string): boolean {
    const key = ControlRequests.key(cls, id);
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  /** Release the slot. Always call this, including on failure, or the control stays stuck. */
  end(cls: ControlClass, id?: string): void {
    this.inFlight.delete(ControlRequests.key(cls, id));
  }

  isPending(cls: ControlClass, id?: string): boolean {
    return this.inFlight.has(ControlRequests.key(cls, id));
  }

  /** Any request at all in flight — for a page-level "saving…" hint, never for disabling controls. */
  anyPending(): boolean {
    return this.inFlight.size > 0;
  }

  pendingKeys(): string[] {
    return [...this.inFlight];
  }
}

/**
 * Run a mutation at most once per in-flight key.
 *
 * Returns `{ sent: false }` when a duplicate was refused, so the caller can say so instead of
 * silently doing nothing. The backend remains the authority for whether the action is ALLOWED — this
 * only prevents the same authorised action being submitted twice. A UI guard is not a security
 * boundary, and this one does not pretend to be: it is a double-submit guard.
 */
export async function runOnce<T>(
  requests: ControlRequests,
  cls: ControlClass,
  fn: () => Promise<T>,
  id?: string,
): Promise<{ sent: true; result: T } | { sent: false; reason: string }> {
  if (!requests.begin(cls, id)) {
    return {
      sent: false,
      reason: `A ${CONTROL_LABEL[cls]} request is already in flight. Waiting for the backend to answer it.`,
    };
  }
  try {
    return { sent: true, result: await fn() };
  } finally {
    requests.end(cls, id);
  }
}
