/**
 * Positions (every execution mode): the day P&L strip, open cards with the backend's exit
 * arithmetic, and the closed-trade history. paper_touch fills are checked against the book
 * they were priced on; every other mode shows each order it sent (entry, unwind, exits),
 * with what filled, at what price and when. Incomplete and quarantined positions say so.
 */

import { Fragment, useState } from "react";
import Button from "../ui/Button.tsx";
import { fmt, fmtMoney, formatExpiry } from "../../format.ts";
import type { SynthDayPnl, SynthOpenPosition, SynthTrade, SynthTradeLeg } from "../../api/synth.ts";
import {
  EXIT_REASON_LABEL,
  MODE_LABEL,
  REJECT_LABEL,
  ageText,
  fillOf,
  fillVerdict,
  groupByDay,
  heldText,
  istDay,
  label,
  legName,
  legQty,
  offsetLabel,
  outstandingQty,
  pnlClass,
  positionState,
  residualText,
  runSummary,
} from "../../lib/synthView.ts";
import { SynthRunTable } from "./SynthExecution.tsx";

function isTouch(t: SynthTrade): boolean {
  return (t.execution_mode ?? "paper_touch") === "paper_touch";
}

function ModeTag({ t }: { t: SynthTrade }) {
  const mode = t.execution_mode ?? "paper_touch";
  return <span className={`synth-tag${mode === "live" ? " synth-tag--live" : ""}`}>{MODE_LABEL[mode] ?? mode}</span>;
}

/** Every order an execution-mode trade sent: entry, unwind, and each exit / flatten run. */
function RunsDetails({ t, open = false }: { t: SynthTrade; open?: boolean }) {
  const exits = t.exit_runs ?? [];
  return (
    <details className="synth-fills" open={open}>
      <summary>
        Orders · entry {runSummary(t.entry_run)}
        {t.unwind_run ? ` · unwind ${runSummary(t.unwind_run)}` : ""}
        {exits.length > 0 ? ` · ${exits.length} closing run(s)` : ""}
      </summary>
      {t.entry_run ? <SynthRunTable run={t.entry_run} title="Entry" /> : <p className="synth-dim">No entry run recorded.</p>}
      {t.unwind_run ? <SynthRunTable run={t.unwind_run} title="Unwind" /> : null}
      {exits.map((r, i) => (
        <SynthRunTable key={`${r.sent_at}:${i}`} run={r} title={r.phase === "residual" ? `Flatten ${i + 1}` : `Exit ${i + 1}`} />
      ))}
    </details>
  );
}

function money(v: number | null): string {
  return fmtMoney(v);
}

function DayItem({ k, v, sub, total, neutral }: { k: string; v: number; sub?: string; total?: boolean; neutral?: boolean }) {
  return (
    <div className={`synth-daypnl-item${total ? " synth-daypnl-item--total" : ""}${neutral ? " synth-daypnl-item--neutral" : ""}`}>
      <span className="synth-daypnl-k">{k}</span>
      <span className={`synth-daypnl-v ${neutral ? "" : pnlClass(v)}`}>{neutral ? `₹${Math.round(v).toLocaleString("en-IN")}` : fmtMoney(v)}</span>
      {sub && <span className="synth-daypnl-sub">{sub}</span>}
    </div>
  );
}

export function SynthDayPnlStrip({ dayPnl }: { dayPnl: SynthDayPnl | undefined }) {
  if (!dayPnl) return null;
  return (
    <section className="synth-daypnl" aria-label="Running day P&L">
      <DayItem
        k={`Open P&L @ LTP (${dayPnl.open_count})`}
        v={dayPnl.open_mtm_ltp}
        {...(dayPnl.open_unmarked_count > 0 ? { sub: `${dayPnl.open_unmarked_count} not marked yet` } : {})}
      />
      <DayItem
        k="Open net if closed now"
        v={dayPnl.open_running_net_pnl}
        sub={
          dayPnl.open_unpriced_count > 0
            ? `${dayPnl.open_unpriced_count} unpriced, excluded`
            : `gross ${fmtMoney(dayPnl.open_running_gross_pnl)} at the touch`
        }
      />
      <DayItem
        k={`Closed today net (${dayPnl.closed_count})`}
        v={dayPnl.closed_realised_net_pnl}
        sub={`gross ${fmtMoney(dayPnl.closed_realised_gross_pnl)} · fees ${fmtMoney(dayPnl.closed_charges)}`}
      />
      <DayItem k="Day net (after charges)" v={dayPnl.total_net_pnl} total />
      <DayItem
        k="Margin in use (open)"
        v={dayPnl.open_margin}
        neutral
        sub={dayPnl.open_margin_unknown > 0 ? `${dayPnl.open_margin_unknown} n/a` : `₹${Math.round(dayPnl.closed_margin).toLocaleString("en-IN")} on today's closes`}
      />
    </section>
  );
}

function BestCheck({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="synth-dim">not recorded</span>;
  return ok ? (
    <span className="synth-check synth-check--ok" title="Limit = best level on its side, full quantity rested there, book not crossed">
      ✓ at best
    </span>
  ) : (
    <span className="synth-check synth-check--bad" title="The recorded book does not support this fill">
      ✗ not at best
    </span>
  );
}

function FillsDetails({ legs, phase, quantity, open = false }: { legs: SynthTradeLeg[]; phase: "entry" | "exit"; quantity: number; open?: boolean }) {
  const fills = legs.map((l) => fillOf(l, phase, quantity));
  const verdict = fillVerdict(legs, phase, quantity);
  return (
    <details className="synth-fills" open={open}>
      <summary>
        {phase === "entry" ? "Entry" : "Exit"}: {fills.length} LIMIT orders at the touch ·{" "}
        {verdict === true ? (
          <span className="synth-check synth-check--ok">✓ all at the best bid/ask</span>
        ) : verdict === false ? (
          <span className="synth-check synth-check--bad">✗ a leg was not at the best price</span>
        ) : (
          <span className="synth-dim">book not recorded</span>
        )}
      </summary>
      <table className="synth-table synth-legs">
        <thead>
          <tr>
            <th>Leg</th>
            <th>Order</th>
            <th className="num">Limit = fill</th>
            <th className="num">Best bid</th>
            <th className="num">Best ask</th>
            <th className="num">Qty at limit</th>
            <th className="num">Book age</th>
            <th>At best?</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((f) => (
            <tr key={f.role}>
              <td>{f.name}</td>
              <td>
                <span className={`synth-side synth-side--${f.side === "BUY" ? "buy" : "sell"}`}>{f.side} LIMIT</span>
              </td>
              <td className="num">{fmt(f.price)}</td>
              <td className="num">{f.bid ? fmt(f.bid) : "-"}</td>
              <td className="num">{f.ask ? fmt(f.ask) : "-"}</td>
              <td className="num">
                {f.qtyAtTouch ?? "-"}
                {f.qtyAtTouch !== null && f.qtyAtTouch < quantity && <span className="synth-check synth-check--bad"> &lt; qty</span>}
              </td>
              <td className="num">{ageText(f.ageMs)}</td>
              <td>
                <BestCheck ok={f.atBest} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Metric({ k, v, cls = "", title }: { k: string; v: string; cls?: string; title?: string }) {
  return (
    <div className={`synth-metric ${cls}`} title={title}>
      <span className="synth-metric-k">{k}</span>
      <span className="synth-metric-v">{v}</span>
    </div>
  );
}

function marginText(t: SynthTrade): string {
  if (t.margin !== null && t.margin !== undefined) {
    return `₹${t.margin.toLocaleString("en-IN")}${t.margin_source === "dhan_per_leg_fallback" ? " (per-leg sum)" : ""}`;
  }
  return t.margin_error ? "unavailable" : "fetching…";
}

export function SynthOpenCards({
  positions,
  closingId,
  busy,
  onClose,
  onCloseAll,
  onDelete,
}: {
  positions: SynthOpenPosition[];
  closingId: string | null;
  busy: boolean;
  onClose: (id: string) => void;
  onCloseAll: () => void;
  onDelete: (t: SynthTrade) => void;
}) {
  if (positions.length === 0) {
    return (
      <section className="synth-section">
        <p className="synth-empty">No open positions.</p>
      </section>
    );
  }
  return (
    <section className="synth-section">
      <div className="synth-filters">
        <Button size="sm" variant="danger" disabled={busy} onClick={onCloseAll} title="Close every open position at the touch">
          Close all
        </Button>
      </div>
      <div className="synth-cards">
        {positions.map((p) => {
          const exitByRole = new Map(p.exit_legs.map((l) => [l.role, l]));
          const closing = closingId === p.id || p.closing;
          const state = positionState(p);
          const note = residualText(p);
          const liveOpen = p.execution_mode === "live";
          const touch = isTouch(p);
          return (
            <div
              key={p.id}
              className={`synth-card${p.exit_eligible ? " synth-card--exiting" : ""}${state === "residual" || state === "quarantined" ? " synth-card--alert" : ""}`}
            >
              <div className="synth-card-head">
                <div>
                  <span className="synth-sym">{p.underlying}</span>
                  {p.is_index && <span className="synth-tag">INDEX</span>}
                  <span className={`synth-dir synth-dir--${p.direction.toLowerCase()}`}>{p.direction}</span>
                  <span className="synth-tag">{p.broker}</span>
                  <ModeTag t={p} />
                  <span className="synth-card-strikes">
                    K {p.strike} <span className="synth-dim">{offsetLabel(p.atm_offset)}</span>
                  </span>
                  <span className="synth-dim">
                    {" "}
                    {formatExpiry(p.expiry)} · {p.quantity} qty ({p.lots} lot{p.lots === 1 ? "" : "s"})
                  </span>
                </div>
                <div className="synth-card-actions">
                  {state === "quarantined" && <span className="synth-tag synth-tag--warn">QUARANTINED</span>}
                  {state === "residual" && <span className="synth-tag synth-tag--warn">INCOMPLETE</span>}
                  {p.flatten_halted && <span className="synth-tag synth-tag--warn">FLATTEN HALTED</span>}
                  {p.exit_eligible && <span className="synth-tag synth-tag--exit">EXIT ELIGIBLE</span>}
                  {p.expiry_safety && <span className="synth-tag synth-tag--warn">EXPIRY SAFETY</span>}
                  {!p.linked && <span className="synth-tag synth-tag--warn">NOT LINKED</span>}
                  <Button
                    size="sm"
                    disabled={closing || busy || state === "quarantined"}
                    onClick={() => onClose(p.id)}
                    title={
                      state === "quarantined"
                        ? "Reconcile it against the broker first (Execution tab)"
                        : touch
                          ? "Close now at the executable touch"
                          : `Close now through ${MODE_LABEL[p.execution_mode] ?? p.execution_mode}: the orders are worked and the result streams in`
                    }
                  >
                    {closing ? "Closing…" : state === "residual" ? "Flatten now" : "Close now"}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={closing || busy || liveOpen}
                    title={liveOpen ? "A live position is real exposure at the broker: close or flatten it instead" : undefined}
                    onClick={() => onDelete(p)}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              {note && <p className="synth-held synth-held--alert">{note}</p>}

              <div className="synth-legs-list">
                {p.legs.map((leg) => {
                  const ex = exitByRole.get(leg.role);
                  const held = outstandingQty(p, leg);
                  return (
                    <div key={leg.role} className="synth-leg-row">
                      <span className={`synth-side synth-side--${leg.side === "BUY" ? "buy" : "sell"}`}>{leg.side}</span>
                      <span className="synth-leg-name" title={leg.tradingsymbol}>
                        {legName(leg)}
                      </span>
                      {!touch && (
                        <span className={`synth-leg-cell${held !== p.quantity ? " synth-check--bad" : ""}`} title="Held now / filled at entry / closed">
                          held {held} · filled {legQty(p, leg)} · closed {leg.exit_qty ?? 0}
                        </span>
                      )}
                      <span className="synth-leg-cell">entry {legQty(p, leg) > 0 ? fmt(leg.entry_price) : "-"}</span>
                      <span className="synth-leg-cell">LTP {ex?.ltp ? fmt(ex.ltp) : "-"}</span>
                      <span className="synth-leg-cell">
                        close {ex?.side ?? "-"} {ex?.price ? fmt(ex.price) : "-"}
                      </span>
                      <span className="synth-leg-cell synth-dim">{ex ? `${ex.qty_at_touch} @ touch · ${ageText(ex.age_ms)}` : "-"}</span>
                      {ex && !ex.executable && <span className="synth-check synth-check--bad">{label(REJECT_LABEL, ex.reject)}</span>}
                    </div>
                  );
                })}
              </div>

              {touch ? <FillsDetails legs={p.legs} phase="entry" quantity={p.quantity} /> : <RunsDetails t={p} />}

              <div className="synth-card-grid">
                <Metric k="Margin (basket)" v={marginText(p)} cls="synth-metric--strong" title={p.margin_error ?? undefined} />
                <Metric k="Locked at entry" v={money(p.entry_edge)} />
                <Metric k="Expected net (entry)" v={money(p.expected_net_profit)} />
                <Metric k="Open P&L @ LTP" v={money(p.mtm_ltp)} cls={`synth-metric--strong ${pnlClass(p.mtm_ltp)}`} />
                <Metric k="Gross if closed now" v={money(p.gross_pnl)} cls={pnlClass(p.gross_pnl)} />
                <Metric k="Entry fees" v={money(p.entry_charges)} />
                <Metric k="Exit fees now" v={money(p.current_exit_charges)} />
                <Metric k="Net if closed now" v={money(p.net_pnl)} cls={`synth-metric--strong ${pnlClass(p.net_pnl)}`} />
                <Metric k="Remaining edge" v={money(p.remaining_edge)} />
                <Metric k="Captured" v={p.captured_pct === null ? "-" : `${Math.round(p.captured_pct * 100)}%`} />
                <Metric k="Converged at ≤" v={money(p.convergence_threshold)} />
                <Metric k="Profit capture at" v={money(p.profit_capture_target)} />
                {p.detected_net_profit !== null && p.detected_net_profit !== undefined && !touch && (
                  <Metric k="Expected net at detection" v={money(p.detected_net_profit)} title="Before execution; 'Expected net (entry)' is re-priced at the actual fills" />
                )}
              </div>
              {!note && !p.exit_eligible && <p className="synth-dim synth-held">{heldText(p, money)}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function SynthClosedHistory({
  trades,
  loading,
  error,
  onDelete,
}: {
  trades: SynthTrade[];
  loading: boolean;
  error: string | null;
  onDelete: (t: SynthTrade) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const days = groupByDay(trades);
  const today = istDay(new Date().toISOString());
  return (
    <section className="synth-section">
      {error && <div className="banner banner--warn">{error}</div>}
      {loading && (
        <p className="synth-dim">
          <span className="spinner" /> loading…
        </p>
      )}
      {trades.length === 0 ? (
        <p className="synth-empty">{error ? "The closed-trade log could not be loaded." : "No closed trades yet."}</p>
      ) : (
        days.map((d) => (
          <details key={d.day} className="synth-day" open={d.day === today || days.length === 1}>
            <summary>
              <strong>{d.day === today ? `Today · ${d.day}` : d.day}</strong> · {d.trades.length} trade(s) · gross {fmtMoney(d.gross)} · fees{" "}
              {fmtMoney(d.fees)} · <span className={pnlClass(d.net)}>net {fmtMoney(d.net)}</span>
            </summary>
            <div className="synth-table-wrap">
              <table className="synth-table">
                <thead>
                  <tr>
                    <th>Underlying</th>
                    <th>Direction</th>
                    <th className="num">Strike</th>
                    <th>Broker</th>
                    <th>Mode</th>
                    <th>Exit</th>
                    <th className="num">Margin</th>
                    <th className="num">Locked</th>
                    <th className="num">Fees</th>
                    <th className="num">Gross</th>
                    <th className="num">Net</th>
                    <th>Fills</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {d.trades.map((t) => {
                    const touch = isTouch(t);
                    const entryOk = fillVerdict(t.legs, "entry", t.quantity);
                    const exitOk = t.exit_reason === "EXPIRED" ? true : fillVerdict(t.legs, "exit", t.quantity);
                    const ok = entryOk === false || exitOk === false ? false : entryOk === null || exitOk === null ? null : true;
                    const isOpen = expanded === t.id;
                    return (
                      <Fragment key={t.id}>
                        <tr className="synth-row" onClick={() => setExpanded(isOpen ? null : t.id)} aria-expanded={isOpen}>
                          <td>
                            <span className="synth-sym">{t.underlying}</span>
                          </td>
                          <td>
                            <span className={`synth-dir synth-dir--${t.direction.toLowerCase()}`}>{t.direction}</span>
                          </td>
                          <td className="num">{t.strike}</td>
                          <td className="synth-dim">{t.broker}</td>
                          <td>
                            <ModeTag t={t} />
                          </td>
                          <td className="synth-dim">{label(EXIT_REASON_LABEL, t.exit_reason)}</td>
                          <td className="num synth-dim">{marginText(t)}</td>
                          <td className="num">{fmtMoney(t.entry_edge)}</td>
                          <td className="num synth-dim">{fmtMoney(t.total_charges)}</td>
                          <td className={`num ${pnlClass(t.gross_pnl)}`}>{fmtMoney(t.gross_pnl)}</td>
                          <td className={`num ${pnlClass(t.net_pnl)}`}>
                            <strong>{fmtMoney(t.net_pnl)}</strong>
                          </td>
                          <td>{touch ? <BestCheck ok={ok} /> : <span className="synth-dim">{runSummary(t.entry_run)}</span>}</td>
                          <td>
                            <Button
                              size="sm"
                              variant="quiet"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDelete(t);
                              }}
                            >
                              Delete
                            </Button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="synth-detail">
                            <td colSpan={13}>
                              {touch ? (
                                <>
                                  <FillsDetails legs={t.legs} phase="entry" quantity={t.quantity} open />
                                  {t.exit_reason === "EXPIRED" ? (
                                    <p className="synth-dim">{t.exit_note}</p>
                                  ) : (
                                    <FillsDetails legs={t.legs} phase="exit" quantity={t.quantity} open />
                                  )}
                                </>
                              ) : (
                                <>
                                  {t.exit_note && <p className="synth-dim">{t.exit_note}</p>}
                                  {t.legging_pnl !== null && t.legging_pnl !== undefined && (
                                    <p className="synth-dim">
                                      Legging P&amp;L (reversed legs, before charges):{" "}
                                      <span className={pnlClass(t.legging_pnl)}>{fmtMoney(t.legging_pnl)}</span>
                                    </p>
                                  )}
                                  <RunsDetails t={t} open />
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        ))
      )}
    </section>
  );
}
