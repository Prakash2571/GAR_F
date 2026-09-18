/**
 * THE SESSION PANEL — the one-shot / bounded-cycle trading session, in detail.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * WHAT "ONE TRADE" MEANS, AND WHY THE PANEL SPELLS IT OUT
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * ONE COMPLETE LIFECYCLE: ENTRY → HOLD/MONITOR → EXIT → FLAT. Not "one broker order", and
 * emphatically not "stop the engine after the entry". The most likely operator misreading of a
 * one-shot control is that the system halts once the order goes in, so this panel states in
 * words that monitoring, auto-exit, partial-exit cleanup, residual flattening, reconciliation
 * and recovery all keep running, and that only NEW ENTRY is disabled.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * WHY TWO COUNTERS ARE SHOWN
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 *   CONSUMED  a full four-leg Box was established. This is what gates new entry.
 *   COMPLETE  that Box later reached fully FLAT. This is what makes the session COMPLETED.
 *
 * A single "completed" number cannot express one-shot: with max=1 the second candidate must be
 * refused while the first Box is still open, when nothing has yet completed. Showing only
 * "0/1 complete" next to a refused entry would look like a bug, so both are shown.
 *
 * A rejected, partially-filled-then-unwound, or economics-aborted entry consumes no COMPLETE
 * lifecycle; with the strict one-shot control it still consumes the separate ENTRY-ATTEMPT budget.
 */

import { useRef, useState } from "react";
import { armBoxSession, disarmBoxSession, type BoxExecutionControl } from "./api";
import { ControlRequests, runOnce } from "./lib/statusIntegrity.ts";

/** What each state means operationally, so the label is never cryptic. */
const STATE_HELP: Record<string, string> = {
  IDLE: "No session armed. New entry is refused until one is.",
  ARMED: "Armed and permitted to enter.",
  ENTRY_IN_PROGRESS: "An entry pipeline is running right now.",
  POSITION_OPEN: "An established Box is open and being monitored.",
  EXIT_IN_PROGRESS: "An exit is in flight.",
  COMPLETED:
    "Every permitted cycle has been consumed AND is fully flat. Terminal for this session: new " +
    "entry stays disabled until an operator deliberately re-arms.",
  BLOCKED: "Armed, but something is blocking new entry — the cycle budget, or an external gate.",
  RECOVERY: "Exposure is quarantined pending reconciliation. Entry is closed; reduction is not.",
};

export function BoxSessionControl({
  control,
  canTrade,
  isFullAdmin,
  onChanged,
}: {
  control: BoxExecutionControl | undefined;
  canTrade: boolean;
  isFullAdmin: boolean;
  onChanged: () => void;
}) {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Session arm/disarm resets or protects a durable risk budget. State updates cannot
  // prevent a same-frame double click, so reserve the action synchronously first.
  const requests = useRef(new ControlRequests());

  if (!canTrade || !control) return null;

  const session = control.session;
  const risk = control.risk;
  const customNum = Number(custom);
  // Validated here for a responsive form only. The backend validates 0..10000 independently, and
  // its answer is what decides — a UI check must never be the reason something is permitted.
  const customValid =
    custom.trim() !== "" && Number.isInteger(customNum) && customNum >= 0 && customNum <= 10_000;

  async function arm(maxCompletedTrades?: number, maxEntryAttempts?: number) {
    const outcome = await runOnce(requests.current, "session_arming", async () => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const next = await armBoxSession(maxCompletedTrades, maxEntryAttempts);
        const completed = next.session.max_completed_trades;
        const attempts = next.session.max_entry_attempts;
        setNote(
          `Session armed: ${completed === 0 ? "UNLIMITED" : completed} complete lifecycle(s) and ` +
            `${attempts === 0 ? "UNLIMITED" : attempts} entry attempt(s) permitted. ` +
            "Monitoring, exit and residual flattening are unaffected by these entry limits.",
        );
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to arm the session.");
      } finally {
        setBusy(false);
      }
    });
    if (!outcome.sent) setNote(outcome.reason);
  }

  async function disarm() {
    const outcome = await runOnce(requests.current, "session_arming", async () => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        await disarmBoxSession();
        setNote("Session disarmed. Counters are preserved, so re-arming still checks for live exposure.");
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to disarm the session.");
      } finally {
        setBusy(false);
      }
    });
    if (!outcome.sent) setNote(outcome.reason);
  }

  /** Why re-arming would be refused right now, in the operator's words. */
  const rearmBlocked =
    risk.open_boxes > 0
      ? `${risk.open_boxes} Box position(s) are still open`
      : risk.residual_legs > 0
        ? `${risk.residual_legs} residual leg(s) are unresolved`
        : session.consumed_cycles > session.completed_trades
          ? `${session.consumed_cycles - session.completed_trades} consumed cycle(s) have not reached FLAT`
          : null;

  return (
    <section className="box-session">
      <h4 className="box-session-h">Trading session</h4>

      <div className="box-session-state-row">
        <span
          className={`box-session-state box-session-state--${session.state.toLowerCase()}`}
          title={STATE_HELP[session.state] ?? session.state}
        >
          {session.state}
        </span>
        <span className="box-session-help">{STATE_HELP[session.state] ?? ""}</span>
      </div>

      <dl className="box-session-grid">
        <div>
          <dt>CONFIGURED MAX</dt>
          <dd>
            {session.max_completed_trades === 0 ? "unlimited" : session.max_completed_trades}
            <small>
              {session.max_completed_trades === 1 ? "one-shot" : "complete lifecycles per session"}
            </small>
          </dd>
        </div>
        <div>
          <dt>CONSUMED</dt>
          <dd title="A cycle is consumed when a full four-leg Box is ESTABLISHED. This is what gates new entry.">
            {session.consumed_cycles}
            <small>gates new entry</small>
          </dd>
        </div>
        <div>
          <dt>COMPLETE</dt>
          <dd title="A cycle is complete when that Box reaches fully FLAT.">
            {session.completed_trades}
            <small>reached FLAT</small>
          </dd>
        </div>
        <div>
          <dt>REMAINING</dt>
          <dd>
            {session.remaining_trades === null ? "unlimited" : session.remaining_trades}
          </dd>
        </div>
        <div>
          <dt>ENTRY ATTEMPTS</dt>
          <dd title="Started at admission before any broker POST. This is the risk-taking budget; a partial or rejected entry still spends it.">
            {session.max_entry_attempts === 0
              ? "unlimited"
              : `${session.entry_attempts}/${session.max_entry_attempts}`}
            <small>
              {session.remaining_entry_attempts === null
                ? "unbounded"
                : `${session.remaining_entry_attempts} remaining`}
            </small>
          </dd>
        </div>
        <div>
          <dt>CURRENT TRADE</dt>
          <dd>
            {session.current_trade_id ?? (session.in_flight_trade_ids.length > 1 ? `${session.in_flight_trade_ids.length} in flight` : "—")}
          </dd>
        </div>
        <div>
          <dt>ABORTED ATTEMPTS</dt>
          <dd title="Entries that ended with no Box. These consume NO cycle.">
            {session.aborted_attempts}
            <small>consume no cycle</small>
          </dd>
        </div>
        <div>
          <dt>ARMED BY</dt>
          <dd>
            {session.armed_by ?? "—"}
            {session.armed_at !== null && (
              <small>{new Date(session.armed_at).toLocaleTimeString("en-IN")}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>ARM COUNT</dt>
          <dd title="Monotonic count of explicit operator arms. An audit aid.">{session.arm_count}</dd>
        </div>
      </dl>

      {session.block_reason && (
        <p className="box-session-msg box-session-msg--info">
          <strong>Entry refused:</strong> {session.block_reason}
          {control.block_detail ? ` — ${control.block_detail}` : ""}
        </p>
      )}

      {!session.enforcing && (
        <p className="box-session-msg box-session-msg--info">
          The cycle budget is <strong>not being enforced</strong>: either
          <code> BOX_SESSION_MAX_COMPLETED_TRADES=0</code> (unlimited, the default) or this
          deployment has no durable Box persistence. Arming still records a session for visibility,
          but no entry will be refused on cycle count.
        </p>
      )}

      {session.write_failed && (
        <p className="box-session-msg box-session-msg--error">
          <strong>A consumed cycle could not be persisted.</strong> Entry stays closed until the
          write succeeds, because a restart would otherwise hand the spent cycle back. Run a live
          reconciliation once the database is reachable. Exit and residual flattening are unaffected.
        </p>
      )}

      {!session.readable && session.enforcing && (
        <p className="box-session-msg box-session-msg--error">
          <strong>Durable session state is unreadable.</strong> New entry fails CLOSED, because an
          unread session is not an unarmed one — treating it as a clean slate is exactly how
          restarting the process would hand back a spent one-shot budget. Exit, residual flattening
          and reconciliation continue normally.
        </p>
      )}

      {session.state === "COMPLETED" && (
        <p className="box-session-msg box-session-msg--ok">
          This session is <strong>COMPLETED</strong>: every permitted lifecycle ran and is fully flat.
          New entry stays disabled until an operator deliberately re-arms.
        </p>
      )}

      {isFullAdmin && (
        <div className="box-session-actions">
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void arm(1, 1)}>
            Arm one-shot (1 attempt / 1 box)
          </button>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void arm(0, 0)}>
            Arm unlimited
          </button>
          <label className="box-session-custom">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={10000}
              step={1}
              placeholder="N"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              disabled={busy}
              aria-invalid={custom.trim() !== "" && !customValid}
              aria-label="Custom maximum complete lifecycles"
            />
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy || !customValid}
              onClick={() => void arm(customNum, customNum)}
            >
              Arm N
            </button>
          </label>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || !session.armed}
            onClick={() => void disarm()}
          >
            Disarm
          </button>
        </div>
      )}

      {isFullAdmin && rearmBlocked && (
        <p className="box-session-msg box-session-msg--warn">
          Re-arming is currently refused: {rearmBlocked}. Arming resets the cycle counters, so
          allowing it while exposure is live would be a one-click way around the limit.
        </p>
      )}

      {!isFullAdmin && (
        <p className="box-session-msg box-session-msg--info">
          Arming a trading session requires full administrator access.
        </p>
      )}

      <p className="box-session-note">
        <strong>One-shot means both limits equal one:</strong> one entry attempt and one COMPLETE
        lifecycle — ENTRY → HOLD/MONITOR → EXIT → FLAT — not one broker order. Reaching either entry
        limit disables NEW ENTRY only: the engine keeps monitoring the open Box, keeps auto-exiting it,
        keeps cleaning up partial exits, keeps flattening residual legs and keeps reconciling. A rejected,
        partially-filled-then-unwound or economics-aborted entry spends the attempt budget even when it
        never establishes a Box.
      </p>

      {error && <p className="box-session-msg box-session-msg--error">{error}</p>}
      {note && !error && <p className="box-session-msg box-session-msg--ok">{note}</p>}
    </section>
  );
}
