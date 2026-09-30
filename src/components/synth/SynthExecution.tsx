/**
 * The Execution tab: how decisions become fills, and every control of LIVE trading.
 *
 *   • the execution mode (four paper modes, and live) and the paper legging leg order — both
 *     are runtime settings, confirmed first and validated again by the server;
 *   • LIVE: the server's environment consent (read-only here, by design), every gate the server
 *     checks, ARM / DISARM (arming needs the typed phrase), the circuit breaker, unresolved order
 *     intents and reconciliation, and the latency calibration the live-parity simulator uses;
 *   • the entry-attempt funnel of every mode, each with its per-leg run.
 *
 * Nothing here decides anything: the server re-checks every gate on every action.
 */

import { Fragment, useState } from "react";
import Button from "../ui/Button.tsx";
import Modal from "../ui/Modal.tsx";
import StatusBadge from "../ui/StatusBadge.tsx";
import { fmt, fmtMoney } from "../../format.ts";
import type {
  SynthExecutionMode,
  SynthExecutionView,
  SynthRun,
  SynthSetting,
  SynthSettingValue,
  SynthSettings,
} from "../../api/synth.ts";
import {
  LEG_STATUS_LABEL,
  MODE_HELP,
  MODE_LABEL,
  OUTCOME_LABEL,
  armGates,
  formatSettingValue,
  istTime,
  label,
  legTimeline,
  outcomeTone,
  pnlClass,
  runSummary,
} from "../../lib/synthView.ts";

/** Every leg of one run: the order, what filled, at what price, when, and why it stopped. */
export function SynthRunTable({ run, title }: { run: SynthRun; title: string }) {
  return (
    <div className="synth-run">
      <p className="synth-run-head">
        <strong>{title}</strong> · {MODE_LABEL[run.mode] ?? run.mode} · {run.sequential ? "one leg at a time" : "all legs at once"} ·{" "}
        {runSummary(run)}
        {run.latency_source ? <span className="synth-dim"> · latency {run.latency_source}</span> : null}
      </p>
      <div className="synth-table-wrap">
        <table className="synth-table synth-legs">
          <thead>
            <tr>
              <th>Leg</th>
              <th>Order</th>
              <th className="num">Filled</th>
              <th className="num">Limit</th>
              <th className="num">Avg fill</th>
              <th className="num">Ref</th>
              <th className="num">Slippage</th>
              <th>Status</th>
              <th>Timeline</th>
            </tr>
          </thead>
          <tbody>
            {run.legs.map((l) => (
              <tr key={l.client_order_id || l.role}>
                <td title={l.tradingsymbol}>{l.role.toUpperCase()}</td>
                <td>
                  <span className={`synth-side synth-side--${l.side === "BUY" ? "buy" : "sell"}`}>{l.side} LIMIT</span>
                  {l.broker_order_id ? <span className="synth-dim"> #{l.broker_order_id}</span> : null}
                </td>
                <td className="num">
                  {l.filled}/{l.qty}
                  {l.raced_qty ? <span className="synth-check synth-check--bad" title="Filled while the cancel was in flight"> +{l.raced_qty} raced</span> : null}
                </td>
                <td className="num">{l.limit_price ? fmt(l.limit_price) : "-"}</td>
                <td className="num">{l.avg_price === null ? "-" : fmt(l.avg_price)}</td>
                <td className="num synth-dim">{l.ref_price ? fmt(l.ref_price) : "-"}</td>
                <td className={`num ${pnlClass(l.slippage === null ? null : -l.slippage)}`}>{l.slippage === null ? "-" : fmtMoney(l.slippage)}</td>
                <td>
                  <span className={l.status === "FILLED" ? "synth-check synth-check--ok" : "synth-check synth-check--bad"}>
                    {label(LEG_STATUS_LABEL, l.status)}
                  </span>
                  {l.reason ? <div className="synth-dim synth-run-reason">{l.reason}</div> : null}
                </td>
                <td className="synth-dim synth-run-time">{legTimeline(l, run)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Confirming = "arm" | "reset" | null;

const KNOBS = [
  "paper_decision_ms",
  "paper_latency_ms",
  "paper_max_wait_ms",
  "leg_timeout_ms",
  "leg_chase_ticks",
  "unwind_chase_ticks",
  "queue_haircut_pct",
  "paper_cancel_latency_ms",
  "paper_latency_jitter_ms",
  "broker_min_interval_ms",
  "abort_after_fill",
  "flatten_interval_ms",
];

const LIVE_KNOBS = [
  "live_max_lots",
  "live_max_open_trades",
  "live_max_margin_per_trade",
  "live_daily_loss_limit",
  "live_require_funds",
  "live_ack_timeout_ms",
  "live_cancel_timeout_ms",
];

export default function SynthExecution({
  view,
  settings,
  busy,
  error,
  onRequestChange,
  onArm,
  onDisarm,
  onResetBreaker,
  onReconcile,
  onOpenSettings,
}: {
  view: SynthExecutionView | null;
  settings: SynthSettings | null;
  busy: boolean;
  error: string | null;
  onRequestChange: (s: SynthSetting, v: SynthSettingValue) => void;
  onArm: (phrase: string) => Promise<boolean>;
  onDisarm: () => void;
  onResetBreaker: (phrase: string) => Promise<boolean>;
  onReconcile: () => void;
  onOpenSettings: () => void;
}) {
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [phrase, setPhrase] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!view) {
    return (
      <section className="synth-section">
        {error ? <div className="banner banner--warn">{error}</div> : null}
        <p className="synth-empty">
          <span className="spinner" /> Loading the execution state…
        </p>
      </section>
    );
  }
  const byKey = new Map((settings?.settings ?? []).map((s) => [s.key, s]));
  const modeSetting = byKey.get("execution_mode");
  const legSetting = byKey.get("leg_execution_mode");
  const live = view.live;
  const gates = armGates(live);
  const isLive = view.mode === "live";
  const expected = confirming === "arm" ? live.arm_phrase : live.reset_phrase;
  const knob = (k: string): string => {
    const s = byKey.get(k);
    return s ? formatSettingValue(s, s.value) : "-";
  };

  const pick = (m: SynthExecutionMode) => {
    if (modeSetting && m !== view.mode) onRequestChange(modeSetting, m);
  };

  const submitPhrase = async () => {
    const ok = confirming === "arm" ? await onArm(phrase) : await onResetBreaker(phrase);
    if (ok) {
      setConfirming(null);
      setPhrase("");
    }
  };

  return (
    <section className="synth-section synth-exec">
      {error ? <div className="banner banner--warn">{error}</div> : null}

      <div className="synth-card">
        <div className="synth-card-head">
          <h2 className="synth-section-title">Execution mode</h2>
          <span className="synth-dim">Open trades keep the mode they were opened in.</span>
        </div>
        <div className="synth-modes" role="radiogroup" aria-label="Execution mode">
          {view.modes.map((m) => {
            const blocked = m === "live" && !live.permitted;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={view.mode === m}
                className={`synth-mode${view.mode === m ? " is-on" : ""}${m === "live" ? " synth-mode--live" : ""}`}
                disabled={busy || !modeSetting || blocked}
                title={blocked ? `Not permitted by the server: ${live.permitted_reason ?? ""}` : MODE_HELP[m]}
                onClick={() => pick(m)}
              >
                <span className="synth-mode-name">{MODE_LABEL[m] ?? m}</span>
                <span className="synth-mode-help">{blocked ? `Server: ${live.permitted_reason ?? "not permitted"}` : MODE_HELP[m]}</span>
              </button>
            );
          })}
        </div>
        <div className="synth-control" role="group" aria-label="Leg order">
          <span className="synth-control-k">Leg order (paper legging)</span>
          {(["hedge_sequential", "parallel"] as const).map((v) => (
            <Button
              key={v}
              size="sm"
              variant={view.leg_execution_mode === v ? "primary" : "secondary"}
              aria-pressed={view.leg_execution_mode === v}
              disabled={busy || !legSetting}
              onClick={() => legSetting && view.leg_execution_mode !== v && onRequestChange(legSetting, v)}
            >
              {v === "hedge_sequential" ? "Hedge-first, one at a time" : "All at once"}
            </Button>
          ))}
          <span className="synth-dim">Live always sends hedge-first, one leg at a time.</span>
        </div>
        <dl className="synth-kv synth-exec-knobs">
          {KNOBS.map((k) => {
            const s = byKey.get(k);
            return s ? (
              <Fragment key={k}>
                <dt>{s.label}</dt>
                <dd>{formatSettingValue(s, s.value)}</dd>
              </Fragment>
            ) : null;
          })}
        </dl>
        <div>
          <Button size="sm" variant="quiet" onClick={onOpenSettings}>
            Edit in Settings → Execution
          </Button>
        </div>
      </div>

      <div className={`synth-card${isLive ? " synth-card--live" : ""}`}>
        <div className="synth-card-head">
          <h2 className="synth-section-title">Live trading · {live.broker}</h2>
          <div className="synth-card-actions">
            <StatusBadge tone={live.armed ? "negative" : "neutral"}>{live.armed ? "ARMED" : "DISARMED"}</StatusBadge>
            {live.breaker ? <StatusBadge tone="negative">BREAKER OPEN</StatusBadge> : null}
            {live.armed ? (
              <Button variant="primary" disabled={busy} onClick={onDisarm} title="Stop new live entries at once">
                Disarm
              </Button>
            ) : (
              <Button
                variant="danger"
                disabled={busy || !isLive || !gates.ok}
                title={!isLive ? "Set the execution mode to live first" : gates.ok ? "Arm live entries" : `Not ready: ${gates.missing.join("; ")}`}
                onClick={() => {
                  setPhrase("");
                  setConfirming("arm");
                }}
              >
                Arm live…
              </Button>
            )}
          </div>
        </div>
        <p className="synth-dim">
          Consent comes from the server's environment and cannot be changed from a browser. Arming lasts until STOP, a
          restart, a mode or broker change, or Disarm. Exits, unwinds and flattening remain available while disarmed once
          the owning account and durable quantities are verified. Expired live obligations require statement reconciliation.
        </p>
        <dl className="synth-kv">
          <dt>SYNTH_LIVE_TRADING_ENABLED</dt>
          <dd className={live.consent.enabled ? "synth-check--ok" : "synth-check--bad"}>{live.consent.enabled ? "true" : "not true"}</dd>
          <dt>Broker enabled ({live.broker})</dt>
          <dd className={live.consent.broker ? "synth-check--ok" : "synth-check--bad"}>{live.consent.broker ? "true" : "not true"}</dd>
          <dt>Static IP confirmed</dt>
          <dd className={live.consent.static_ip_confirmed ? "synth-check--ok" : "synth-check--bad"}>
            {live.consent.static_ip_confirmed ? "operator confirmed" : "not confirmed"}
          </dd>
          <dt>Server margin ceiling</dt>
          <dd>{live.consent.max_margin_rupees > 0 ? `₹${live.consent.max_margin_rupees.toLocaleString("en-IN")}` : "not set"}</dd>
          {live.armed && live.armed_at ? (
            <>
              <dt>Armed</dt>
              <dd>
                {istTime(live.armed_at)}
                {live.armed_by ? ` by ${live.armed_by}` : ""}
              </dd>
            </>
          ) : null}
        </dl>

        <ul className="synth-gates" aria-label="Live gates">
          {live.gates.map((g) => (
            <li key={g.key} className={g.ok ? "synth-check--ok" : "synth-check--bad"}>
              <span aria-hidden="true">{g.ok ? "✓" : "✗"}</span> {g.label}
              {g.detail ? <span className="synth-dim"> · {g.detail}</span> : null}
            </li>
          ))}
        </ul>
        {isLive && live.entry_block_reason ? (
          <p className="synth-held">
            <strong>No new live entry now:</strong> {live.entry_block_reason}.
          </p>
        ) : null}

        {live.breaker ? (
          <div className="banner banner--error">
            <strong>Circuit breaker open</strong>
            {live.breaker_at ? ` since ${istTime(live.breaker_at)}` : ""}: {live.breaker}. New live entries are blocked until every order
            is reconciled and the breaker is reset.{" "}
            <Button
              size="sm"
              variant="danger"
              disabled={busy || live.unresolved_intents.length > 0 || live.quarantined_live_trades > 0 || live.busy > 0}
              title={
                live.unresolved_intents.length > 0 || live.quarantined_live_trades > 0
                  ? "Reconcile first: orders or positions are unresolved"
                  : "Close the breaker (live stays disarmed)"
              }
              onClick={() => {
                setPhrase("");
                setConfirming("reset");
              }}
            >
              Reset breaker…
            </Button>
          </div>
        ) : null}

        <div className="synth-card-head">
          <h3 className="synth-section-title">Unresolved live orders ({live.unresolved_intents.length})</h3>
          <Button
            size="sm"
            disabled={busy || live.reconciling || live.busy > 0}
            onClick={onReconcile}
            title={live.busy > 0 ? "A live order is being worked right now" : "Re-read every unresolved order at the broker"}
          >
            {live.reconciling ? "Reconciling…" : "Reconcile with broker"}
          </Button>
        </div>
        {live.unresolved_intents.length === 0 ? (
          <p className="synth-dim">None. Every live order has a proven outcome.</p>
        ) : (
          <div className="synth-table-wrap">
            <table className="synth-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Phase</th>
                  <th>Leg</th>
                  <th className="num">Qty</th>
                  <th className="num">Limit</th>
                  <th>Tag</th>
                  <th>State</th>
                  <th>Broker id</th>
                  <th className="num">Filled</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {live.unresolved_intents.map((i) => (
                  <tr key={i.client_order_id}>
                    <td className="synth-dim">{i.client_order_id}</td>
                    <td>{i.phase}</td>
                    <td>
                      <span className={`synth-side synth-side--${i.side === "BUY" ? "buy" : "sell"}`}>{i.side}</span> {i.tradingsymbol}
                    </td>
                    <td className="num">{i.qty}</td>
                    <td className="num">{fmt(i.limit_price)}</td>
                    <td className="synth-dim">{i.tag}</td>
                    <td className="synth-check synth-check--bad">{i.state}</td>
                    <td className="synth-dim">{i.broker_order_id || "-"}</td>
                    <td className="num">{i.filled}</td>
                    <td className="synth-dim">{i.reason || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="synth-card-grid">
          <div className="synth-metric">
            <span className="synth-metric-k">Open live positions</span>
            <span className="synth-metric-v">
              {live.open_live_trades}
              {live.quarantined_live_trades > 0 ? ` (${live.quarantined_live_trades} quarantined)` : ""}
            </span>
          </div>
          <div className={`synth-metric ${pnlClass(live.day_net)}`} title="Owning account, IST recognition day; includes hidden closed results and priced open marks. Unknown evidence blocks entries.">
            <span className="synth-metric-k">Account live risk today</span>
            <span className="synth-metric-v">{fmtMoney(live.day_net)}</span>
          </div>
          <div className="synth-metric" title="Median POST → broker acknowledgement over the last live orders; live parity uses it from 20 samples">
            <span className="synth-metric-k">Measured ACK latency</span>
            <span className="synth-metric-v">{live.measured_ack_ms === null ? `${live.ack_samples}/20 samples` : `${live.measured_ack_ms} ms`}</span>
          </div>
          <div className="synth-metric" title="Median cancel request → terminal state; live parity uses it as the cancel race window">
            <span className="synth-metric-k">Measured cancel latency</span>
            <span className="synth-metric-v">
              {live.measured_cancel_ms === null ? `${live.cancel_samples}/20 samples` : `${live.measured_cancel_ms} ms`}
            </span>
          </div>
        </div>
        <dl className="synth-kv synth-exec-knobs">
          {LIVE_KNOBS.map((k) => {
            const s = byKey.get(k);
            return s ? (
              <Fragment key={k}>
                <dt>{s.label}</dt>
                <dd>{formatSettingValue(s, s.value)}</dd>
              </Fragment>
            ) : null;
          })}
        </dl>
      </div>

      {view.in_flight.length > 0 ? (
        <div className="synth-card">
          <h2 className="synth-section-title">Being worked now</h2>
          <ul className="synth-gates">
            {view.in_flight.map((f) => (
              <li key={`${f.kind}:${f.trade_id}`}>
                <span className="spinner" /> {f.kind} · {f.underlying} · {MODE_LABEL[f.mode] ?? f.mode} · since {istTime(f.since_ms)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="synth-card">
        <div className="synth-card-head">
          <h2 className="synth-section-title">Entry attempts ({view.attempts.length})</h2>
          <span className="synth-dim">Every mode, every outcome. Click a row for its orders.</span>
        </div>
        {view.attempts.length === 0 ? (
          <p className="synth-dim">No entry attempt yet in an execution mode (paper_touch entries fill at the touch and are not listed here).</p>
        ) : (
          <div className="synth-table-wrap">
            <table className="synth-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Underlying</th>
                  <th>Direction</th>
                  <th className="num">K</th>
                  <th>Mode</th>
                  <th>Outcome</th>
                  <th className="num">Net at detection</th>
                  <th className="num">Net at fills</th>
                  <th className="num">Legging P&amp;L</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {view.attempts.map((a) => {
                  const open = expanded === a.id;
                  return (
                    <Fragment key={a.id}>
                      <tr className="synth-row" onClick={() => setExpanded(open ? null : a.id)} aria-expanded={open}>
                        <td className="synth-dim">{istTime(a.at_ms)}</td>
                        <td>
                          <span className="synth-sym">{a.underlying}</span>
                        </td>
                        <td>
                          <span className={`synth-dir synth-dir--${a.direction.toLowerCase()}`}>{a.direction}</span>
                        </td>
                        <td className="num">{a.strike}</td>
                        <td className="synth-dim">{MODE_LABEL[a.mode] ?? a.mode}</td>
                        <td>
                          <StatusBadge tone={outcomeTone(a.outcome)}>{label(OUTCOME_LABEL, a.outcome)}</StatusBadge>
                        </td>
                        <td className="num">{fmtMoney(a.detected_net_profit)}</td>
                        <td className="num">{a.filled_net_profit === null ? "-" : fmtMoney(a.filled_net_profit)}</td>
                        <td className={`num ${pnlClass(a.legging_pnl)}`}>{a.legging_pnl === null ? "-" : fmtMoney(a.legging_pnl)}</td>
                        <td className="synth-dim synth-run-reason">{a.reason || "-"}</td>
                      </tr>
                      {open ? (
                        <tr className="synth-detail">
                          <td colSpan={10}>
                            {a.entry ? <SynthRunTable run={a.entry} title="Entry" /> : <p className="synth-dim">Nothing was sent.</p>}
                            {a.unwind ? <SynthRunTable run={a.unwind} title="Unwind" /> : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirming ? (
        <Modal
          title={confirming === "arm" ? `Arm LIVE trading on ${live.broker}?` : "Reset the circuit breaker?"}
          subtitle={confirming === "arm" ? "New entries will send real LIMIT orders to the broker." : "Live stays disarmed afterwards."}
          onClose={() => setConfirming(null)}
        >
          {confirming === "arm" ? (
            <p>
              Once armed, every confirmed ELIGIBLE opportunity is entered with real orders: the bought option, then the future, then
              the sold option, each only after the previous filled in full. Limits: {knob("live_max_lots")} per trade,{" "}
              {knob("live_max_open_trades")} open, margin cap {knob("live_max_margin_per_trade")}, daily loss limit{" "}
              {knob("live_daily_loss_limit")}.
            </p>
          ) : (
            <p>Every order is reconciled. Resetting lets live entries resume once you arm again.</p>
          )}
          <label className="synth-field">
            <span>
              Type <strong>{expected}</strong> to confirm
            </span>
            <input
              className="synth-input"
              value={phrase}
              autoComplete="off"
              onChange={(e) => setPhrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && phrase === expected) void submitPhrase();
              }}
            />
          </label>
          <div className="synth-modal-actions">
            <Button variant="quiet" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy || phrase !== expected} onClick={() => void submitPhrase()}>
              {confirming === "arm" ? "Arm live" : "Reset breaker"}
            </Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
