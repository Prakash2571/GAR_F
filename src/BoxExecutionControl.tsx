/**
 * THE EXECUTION PANEL — what this deployment is actually doing, and what it is allowed to do.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THIS COMPONENT MUST NOT BREAK
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * THE BACKEND IS THE AUTHORITY. Every value shown here is a REPORT, never a belief. In
 * particular `deployment_live_capable` is a STARTUP fact on the server — it depends on
 * BOX_EXECUTION_MODE, BOX_LIVE_TRADING_ENABLED and whether a mutation-capable broker adapter
 * was even constructed — so no click in this file can change it. When it is false, LIVE is
 * shown as UNAVAILABLE and cannot be selected, and the backend refuses independently anyway.
 *
 * This component therefore never renders a control that cannot work. Crossing the paper/live
 * boundary requires an environment change and a restart, and it says so in those words rather
 * than offering a selector that silently fails.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE THREE LIVE PERMISSIONS ARE SEPARATE BUTTONS
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 *   LIVE ORDERS      may manage (reduce) existing exposure: exits, cancels, residual flatten.
 *   ENTRY            may open NEW exposure. The dangerous one.
 *   EMERGENCY FLATTEN the operator's brake.
 *
 * They are independent, and arming one never implies another. Presenting them as one "go live"
 * switch would make it impossible to keep the brake available while entry is off — which is
 * exactly the state an operator wants during an incident.
 *
 * Only ENTRY arming asks for confirmation, because it is the only one that can create new risk.
 * The confirmation is UX only; the backend validates every precondition itself.
 */

import { useRef, useState } from "react";
import {
  previewBoxExecutionMode,
  setBoxLiveControl,
  setBoxPaperProfile,
  type BoxExecutionControl as ExecutionControlView,
  type BoxExecutionSelection,
  type BoxModeTransitionVerdict,
} from "./api";
// SECTION 7: distinct control classes plus a SYNCHRONOUS single-flight guard, so a double-click
// cannot double-submit and an unrelated in-flight request cannot disable the emergency control.
import { ControlRequests, runOnce, type ControlClass } from "./lib/statusIntegrity.ts";

/** ₹ in Indian digit grouping, e.g. 120000 -> "₹1,20,000". */
function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

/** The paper profile implied by a selection, or null for live. */
function profileFor(selection: BoxExecutionSelection): "standard" | "live_parity" | null {
  if (selection === "paper_legging_live_parity") return "live_parity";
  if (selection === "paper_legging") return "standard";
  return null;
}

const SELECTIONS: { value: BoxExecutionSelection; label: string; hint: string }[] = [
  {
    value: "paper_latency",
    label: "PAPER · LATENCY",
    hint: "Simulated fills after a modelled decision + arrival delay. No broker orders.",
  },
  {
    value: "paper_legging",
    label: "PAPER · LEGGING",
    hint: "Four independent simulated leg orders on the standard profile.",
  },
  {
    value: "paper_legging_live_parity",
    label: "PAPER · LEGGING LIVE-PARITY",
    hint:
      "Four simulated leg orders calibrated from MEASURED live timing, mirroring the live " +
      "scheduling policy. Still simulated: only the timing model is paper-specific.",
  },
  {
    value: "live",
    label: "LIVE",
    hint: "REAL broker orders against a real account.",
  },
];

export function BoxExecutionControl({
  control,
  canTrade,
  isFullAdmin,
  onChanged,
}: {
  control: ExecutionControlView | undefined;
  canTrade: boolean;
  isFullAdmin: boolean;
  onChanged: () => void;
}) {
  /**
   * SECTION 7 — PER-CONTROL-CLASS pending state, not one global flag.
   *
   * `busy` still drives the "…" label on the button that was pressed, but it no longer decides
   * whether OTHER controls are usable. The old single flag conflated four genuinely distinct
   * authorities — entry arming, live-order management, emergency actions and session arming — and
   * disabled all of them while any one request was in flight. Blocking the EMERGENCY control because
   * someone had just clicked "arm entry" is strictly more dangerous than allowing it.
   */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<BoxModeTransitionVerdict | null>(null);
  const [confirmEntry, setConfirmEntry] = useState(false);
  /**
   * The SYNCHRONOUS in-flight registry.
   *
   * Held in a ref because a `disabled={busy !== null}` guard cannot stop a double-click that happens
   * before React re-renders: both handlers read the same pre-update `busy` from their render
   * closure, and both fire. `ControlRequests.begin` mutates a Set immediately, so the second click
   * is refused here rather than at the broker.
   */
  const requests = useRef(new ControlRequests());

  if (!canTrade || !control) return null;

  const isLive = control.execution_mode === "live";
  const liveCapable = control.deployment_live_capable;
  const session = control.session;
  const risk = control.risk;
  const exec = control.execution;

  /**
   * Run one control mutation, at most once per control class in flight.
   *
   * `cls` is the DISTINCT authority being exercised; `key` is only the label shown on the pressed
   * button. A refused duplicate reports itself instead of silently doing nothing — a button that
   * appears to do nothing is how an operator ends up clicking it a third time.
   *
   * The backend re-authorises every one of these calls. This guard is a double-submit guard and
   * nothing more: a UI restriction is not a security boundary.
   */
  async function run(
    cls: ControlClass,
    key: string,
    fn: () => Promise<unknown>,
    okNote?: string,
  ) {
    const outcome = await runOnce(requests.current, cls, async () => {
      setBusy(key);
      setError(null);
      setNote(null);
      try {
        await fn();
        if (okNote) setNote(okNote);
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "The request failed.");
      } finally {
        setBusy(null);
      }
    });
    if (!outcome.sent) setNote(outcome.reason);
  }

  async function selectMode(selection: BoxExecutionSelection) {
    if (selection === control!.mode.selection) return;
    // ALWAYS ask the backend first. It owns the decision, and its answer is what the operator
    // needs to see — including "restart required" and the exact env vars.
    setPreview(null);
    setError(null);
    setNote(null);
    try {
      const verdict = await previewBoxExecutionMode(selection);
      setPreview(verdict);
      if (verdict.outcome !== "allowed") return;
      const profile = profileFor(selection);
      if (profile === null) {
        // `paper_latency` and `live` are MODES, not paper profiles, and `BOX_EXECUTION_MODE` is a
        // startup-only construction boundary. Saying so beats the previous behaviour of returning
        // silently, which left the operator clicking a button that never did anything.
        setError(
          selection === "live"
            ? "LIVE cannot be selected at runtime: it requires BOX_EXECUTION_MODE=live, " +
              "BOX_LIVE_TRADING_ENABLED=true and a restart."
            : "PAPER · LATENCY is a different execution MODE, not a paper profile. Switching to it " +
              "requires BOX_EXECUTION_MODE=paper_latency and a restart — only the two paper " +
              "LEGGING profiles can be changed at runtime.",
        );
        return;
      }
      await run(
        "mode",
        "profile",
        () => setBoxPaperProfile(profile),
        `Execution profile changed. ${selection === "paper_legging_live_parity"
          ? "Paper now mirrors the live scheduling policy; only the timing model is simulated."
          : "Paper is back on the standard profile."}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change the execution mode.");
    }
  }

  return (
    <section className="box-exec">
      {/* ── the headline: what is running, stated so it cannot be misread ── */}
      <header className="box-exec-head">
        <span
          className={`box-exec-mode ${isLive ? "box-exec-mode--live" : "box-exec-mode--paper"}`}
          title={
            isLive
              ? "REAL broker orders. Fills are real money, gated by the fail-closed durable order manager."
              : "Simulated fills. No broker order can be placed from a paper deployment."
          }
        >
          {control.mode.label}
        </span>

        {/* A persistent, unmissable badge while real orders are possible. */}
        {isLive && (
          <span className="box-exec-badge box-exec-badge--danger" title="This deployment places REAL broker orders.">
            REAL ORDERS
          </span>
        )}

        {/* The three status badges the specification asks for, shown only when the
            corresponding control is actually in force — a badge for a disabled limit
            would be noise that trains the operator to ignore badges. */}
        {session.max_completed_trades === 1 && (
          <span className="box-exec-badge" title="One complete Box lifecycle (ENTRY → HOLD → EXIT → FLAT) is permitted.">
            1 BOX SESSION
          </span>
        )}
        {session.max_completed_trades > 1 && (
          <span className="box-exec-badge" title="Bounded number of complete Box lifecycles per armed session.">
            {session.max_completed_trades} BOX SESSION
          </span>
        )}
        {risk.one_active_box_per_underlying && (
          <span
            className="box-exec-badge"
            title="At most one active Box per underlying, regardless of strike pair, expiry or direction."
          >
            1 ACTIVE / UNDERLYING
          </span>
        )}
        {risk.max_box_capital_rupees > 0 && (
          <span
            className="box-exec-badge"
            title={
              `Maximum ${risk.max_box_capital_metric} for one four-leg Box. This is GROSS ` +
              "option-order notional from the bounded LIMIT requests — NOT broker margin."
            }
          >
            MAX {rupees(risk.max_box_capital_rupees)} / BOX
          </span>
        )}
      </header>

      {/* ── the status grid the specification enumerates ── */}
      <dl className="box-exec-grid">
        <div className="box-exec-cell">
          <dt>MODE</dt>
          <dd>{control.mode.label}</dd>
        </div>
        <div className="box-exec-cell">
          <dt>BROKER</dt>
          <dd>{control.broker.toUpperCase()}</dd>
        </div>
        <div className="box-exec-cell">
          <dt>ENTRY STATE</dt>
          <dd className={control.entry_enabled ? "ok" : "warn"}>
            {control.entry_enabled ? "ENABLED" : "DISABLED"}
            {control.block_reason ? ` · ${control.block_reason}` : ""}
          </dd>
        </div>
        <div className="box-exec-cell">
          <dt>LIVE ORDERS</dt>
          <dd className={control.live_runtime_armed ? "ok" : "warn"}>
            {liveCapable ? (control.live_runtime_armed ? "ARMED" : "NOT ARMED") : "UNAVAILABLE"}
          </dd>
        </div>
        <div className="box-exec-cell">
          <dt>SESSION LIMIT</dt>
          <dd>
            {session.max_completed_trades === 0
              ? "unlimited"
              : `${session.completed_trades}/${session.max_completed_trades} complete · ${session.consumed_cycles} consumed`}
          </dd>
        </div>
        {/* ATTEMPT BUDGET, shown beside the cycle budget because they bound DIFFERENT things and the
            difference is the whole point. SESSION LIMIT counts boxes that were ESTABLISHED, so an
            attempt that submitted orders, partially filled and was then unwound spends none of it —
            it took real exposure and paid real charges for free. This cell is the bound that stops a
            run of such attempts. Rendered only when configured, so an unbounded deployment is not
            given a reassuring-looking counter that means nothing. */}
        {session.max_entry_attempts > 0 && (
          <div className="box-exec-cell">
            <dt>ATTEMPT BUDGET</dt>
            <dd className={session.remaining_entry_attempts === 0 ? "warn" : undefined}>
              {`${session.entry_attempts}/${session.max_entry_attempts} started`}
              {session.remaining_entry_attempts === null
                ? ""
                : ` · ${session.remaining_entry_attempts} remaining`}
            </dd>
          </div>
        )}
        <div className="box-exec-cell">
          <dt>MAX ₹ / BOX</dt>
          <dd title="Gross entry-order notional, NOT broker margin.">
            {risk.max_box_capital_rupees > 0 ? rupees(risk.max_box_capital_rupees) : "disabled"}
          </dd>
        </div>
        <div className="box-exec-cell">
          <dt>SAME-UNDERLYING</dt>
          <dd>{risk.one_active_box_per_underlying ? "one active per underlying" : "per-contract only"}</dd>
        </div>
        <div className="box-exec-cell">
          <dt>CIRCUIT</dt>
          <dd className={exec.circuit === "closed" ? "ok" : "warn"}>{exec.circuit.toUpperCase()}</dd>
        </div>
        <div className="box-exec-cell">
          <dt>RECONCILIATION</dt>
          <dd className={control.arm.preconditions.reconciliationComplete ? "ok" : "warn"}>
            {control.arm.preconditions.reconciliationComplete ? "COMPLETE" : "INCOMPLETE"}
          </dd>
        </div>
        <div className="box-exec-cell">
          <dt>FEED</dt>
          <dd className={control.arm.preconditions.feedHealthy ? "ok" : "warn"}>
            {control.arm.preconditions.feedHealthy ? "HEALTHY" : "UNHEALTHY"}
          </dd>
        </div>
        <div className="box-exec-cell">
          <dt>OPEN BOXES</dt>
          <dd>
            {risk.open_boxes}
            {risk.max_open_boxes > 0 ? ` / ${risk.max_open_boxes}` : ""}
            {risk.residual_legs > 0 ? ` · ${risk.residual_legs} residual leg(s)` : ""}
          </dd>
        </div>
        <div className="box-exec-cell">
          <dt>QUEUE</dt>
          <dd>
            {exec.in_flight} in flight · {exec.queued} queued
          </dd>
        </div>
      </dl>

      {/* ── mode selection ── */}
      <div className="box-exec-modes">
        {SELECTIONS.map((option) => {
          const active = option.value === control.mode.selection;
          const isLiveOption = option.value === "live";
          const unavailable = isLiveOption && !liveCapable;
          const needsRestart = isLiveOption && liveCapable;
          return (
            <button
              key={option.value}
              type="button"
              className={`box-exec-mode-btn${active ? " is-active" : ""}${unavailable ? " is-unavailable" : ""}`}
              // A live-capable deployment still cannot switch from here, so the button reports
              // rather than pretends. An incapable deployment cannot select LIVE at all.
              // Only the two paper LEGGING profiles are switchable at runtime. Everything else is a
              // report, so it is rendered inert rather than as a control that cannot work.
              disabled={
                busy === "mode" ||
                unavailable ||
                !isFullAdmin ||
                active ||
                profileFor(option.value) === null
              }
              aria-current={active}
              onClick={() => void selectMode(option.value)}
              title={
                unavailable
                  ? `LIVE UNAVAILABLE — deployment gate disabled: ${control.live_capability_detail}`
                  : needsRestart
                    ? "Crossing the paper/live boundary requires an environment change and a restart."
                    : option.hint
              }
            >
              <span className="box-exec-mode-btn-label">{option.label}</span>
              {unavailable && <span className="box-exec-mode-btn-note">LIVE UNAVAILABLE</span>}
              {needsRestart && !active && <span className="box-exec-mode-btn-note">restart required</span>}
            </button>
          );
        })}
      </div>

      {!liveCapable && (
        <p className="box-exec-msg box-exec-msg--info">
          <strong>LIVE UNAVAILABLE — deployment gate disabled.</strong>{" "}
          {control.live_capability_detail}. This cannot be changed from the UI: it requires{" "}
          <code>BOX_EXECUTION_MODE=live</code> and <code>BOX_LIVE_TRADING_ENABLED=true</code> in the
          deployment environment, and a restart.
        </p>
      )}

      {preview && preview.outcome !== "allowed" && (
        <div className="box-exec-msg box-exec-msg--warn">
          {preview.outcome === "restart_required" ? (
            <>
              <strong>Restart required.</strong> {preview.detail}
              {preview.envChanges.length > 0 && (
                <> Set: {preview.envChanges.map((v) => <code key={v}>{v}</code>)}</>
              )}
            </>
          ) : (
            <>
              <strong>Refused.</strong> The mode cannot change right now:
              <ul className="box-exec-blockers">
                {preview.blockers.map((b) => (
                  <li key={b.code}>{b.detail}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* ── the live arm flow: independent permissions, entry last ── */}
      {liveCapable && (
        <div className="box-exec-arm">
          <h4 className="box-exec-arm-h">Live arming</h4>
          <p className="box-exec-arm-note">
            Each permission is armed independently. Enabling one never enables another — the
            emergency brake stays available while entry is off, which is the state you want during
            an incident.
          </p>

          <div className="box-exec-arm-row">
            <button
              type="button"
              className="btn btn--sm"
              disabled={!isFullAdmin || busy === "live_orders"}
              onClick={() =>
                void run(
                  "live_order_management",
                  "live_orders",
                  () => setBoxLiveControl("box_live_order_enabled", !control.live_runtime_armed),
                )
              }
              title="Permits management of EXISTING exposure: exits, protective cancels, residual flattening."
            >
              {control.live_runtime_armed ? "Disarm live orders" : "Arm live orders"}
            </button>
            <span className="box-exec-arm-state">
              {control.live_runtime_armed ? "ARMED" : "not armed"}
              {!control.arm.exposure_management.ok && control.arm.exposure_management.blockers && (
                <em> · {control.arm.exposure_management.blockers.map((b) => b.detail).join("; ")}</em>
              )}
            </span>
          </div>

          <div className="box-exec-arm-row">
            <button
              type="button"
              className="btn btn--sm"
              disabled={!isFullAdmin || busy === "flatten"}
              onClick={() =>
                void run(
                  "emergency",
                  "flatten",
                  () => setBoxLiveControl("box_emergency_flatten", !control.emergency_flatten_enabled),
                )
              }
              title="Permits an operator-triggered emergency flatten. Deliberately separate from entry."
            >
              {control.emergency_flatten_enabled ? "Disarm emergency flatten" : "Arm emergency flatten"}
            </button>
            <span className="box-exec-arm-state">
              {control.emergency_flatten_enabled ? "ARMED" : "not armed"}
            </span>
          </div>

          <div className="box-exec-arm-row">
            <button
              type="button"
              className={`btn btn--sm${control.entry_enabled ? "" : " btn--danger"}`}
              disabled={!isFullAdmin || busy === "entry" || (!control.entry_enabled && !control.arm.entry.ok)}
              onClick={() => {
                if (control.entry_enabled) {
                  void run("entry_arming", "entry", () => setBoxLiveControl("box_entry_enabled", false));
                } else {
                  setConfirmEntry(true);
                }
              }}
              title="Permits opening NEW exposure. The only permission that can create new risk."
            >
              {control.entry_enabled ? "Disable entry" : "Enable entry (real orders)"}
            </button>
            <span className="box-exec-arm-state">
              {control.entry_enabled ? "ENABLED" : "disabled"}
              {!control.arm.entry.ok && control.arm.entry.blockers && (
                <em> · {control.arm.entry.blockers.map((b) => b.detail).join("; ")}</em>
              )}
            </span>
          </div>
        </div>
      )}

      {/* ── the entry-arming confirmation. UX only; the backend is the authority. ── */}
      {confirmEntry && (
        <div className="box-exec-confirm" role="dialog" aria-label="Confirm live entry arming">
          <h4>Enable REAL Box entry?</h4>
          <p>The next qualifying candidate will place four real broker orders.</p>
          <dl className="box-exec-confirm-grid">
            <div>
              <dt>BROKER</dt>
              <dd>{control.broker.toUpperCase()}</dd>
            </div>
            <div>
              <dt>MAX ₹ / BOX</dt>
              <dd>
                {risk.max_box_capital_rupees > 0 ? rupees(risk.max_box_capital_rupees) : "no limit"}
                <small> gross entry-order notional, not broker margin</small>
              </dd>
            </div>
            <div>
              <dt>ONE ACTIVE / UNDERLYING</dt>
              <dd>{risk.one_active_box_per_underlying ? "ON" : "OFF"}</dd>
            </div>
            <div>
              <dt>SESSION MAX TRADES</dt>
              <dd>
                {session.max_completed_trades === 0 ? "unlimited" : session.max_completed_trades}
                {session.armed ? "" : " · NO SESSION ARMED"}
              </dd>
            </div>
            <div>
              <dt>CURRENT EXPOSURE</dt>
              <dd>
                {risk.open_boxes} open Box(es) · {risk.residual_legs} residual leg(s)
              </dd>
            </div>
            <div>
              <dt>DAILY LOSS LIMIT</dt>
              <dd>
                {risk.daily_loss_limit > 0 ? rupees(risk.daily_loss_limit) : "disabled"}
                {risk.realised_pnl_today !== null && <small> realised today {rupees(risk.realised_pnl_today)}</small>}
              </dd>
            </div>
          </dl>
          {!session.armed && (
            <p className="box-exec-msg box-exec-msg--warn">
              No trading session is armed, so the backend will refuse every entry until one is.
              Arm a session below first.
            </p>
          )}
          <div className="box-exec-confirm-actions">
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={busy === "entry"}
              onClick={() => {
                setConfirmEntry(false);
                void run("entry_arming", "entry", () => setBoxLiveControl("box_entry_enabled", true), "Live entry ENABLED.");
              }}
            >
              Yes, enable real entry
            </button>
            <button type="button" className="btn btn--sm" onClick={() => setConfirmEntry(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Session state is SUMMARISED here because it gates entry, but the CONTROLS live only in
          BoxSessionControl. Rendering arm/disarm in both places gave two independently-busy
          button sets for the same action, which is how a double-arm gets clicked. */}
      <div className="box-exec-session">
        <h4 className="box-exec-arm-h">Trading session</h4>
        <div className="box-exec-arm-row">
          <span className={`box-exec-session-state box-exec-session-state--${session.state.toLowerCase()}`}>
            {session.state}
          </span>
          <span className="box-exec-arm-state">
            {session.armed
              ? `${session.consumed_cycles} consumed · ${session.completed_trades} complete` +
                (session.remaining_trades === null ? " · unlimited" : ` · ${session.remaining_trades} remaining`)
              : "no session armed"}
            {session.current_trade_id ? ` · current ${session.current_trade_id}` : ""}
          </span>
        </div>
        {session.block_reason && (
          <p className="box-exec-msg box-exec-msg--info">
            Entry blocked: <strong>{session.block_reason}</strong>
            {control.block_detail ? ` — ${control.block_detail}` : ""}
          </p>
        )}
      </div>

      {/* ── the latency distinction, stated where it cannot be missed ── */}
      <p className="box-exec-latency">
        <strong>Latency:</strong> live order mutations are paced at{" "}
        <strong>{exec.effective_broker_order_min_interval_ms}ms</strong> (floor{" "}
        {exec.broker_order_interval_floor_ms}ms, {exec.broker_order_interval_source}), reads and
        status polls at {exec.effective_broker_min_interval_ms}ms. Those are REAL broker rate limits.
        No artificial simulation latency is applied to live execution
        {exec.artificial_latency_applied_to_live ? " — REPORTED AS APPLIED, WHICH IS A BUG" : ""}; the
        simulated {exec.paper_only_simulated_decision_ms}ms decision and{" "}
        {exec.paper_only_simulated_latency_ms}ms arrival delays are PAPER-ONLY and are not consulted
        on the live path. Four-leg entry burst width {exec.live_entry_submit_concurrency} (pacing
        budget {exec.four_leg_burst_pacing_budget_ms}ms).
      </p>

      {error && <p className="box-exec-msg box-exec-msg--error">{error}</p>}
      {note && !error && <p className="box-exec-msg box-exec-msg--ok">{note}</p>}
    </section>
  );
}
