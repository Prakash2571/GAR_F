/**
 * Paper positions: the day P&L strip, open cards with the backend's exit arithmetic, and the
 * closed-trade history with every fill checked against the book it was priced on.
 */

import { Fragment, useState } from "react";
import Button from "../ui/Button.tsx";
import { fmt, fmtMoney, formatExpiry } from "../../format.ts";
import type { SynthDayPnl, SynthOpenPosition, SynthTrade, SynthTradeLeg } from "../../api/synth.ts";
import {
  EXIT_REASON_LABEL,
  REJECT_LABEL,
  ageText,
  fillOf,
  fillVerdict,
  groupByDay,
  heldText,
  istDay,
  label,
  legName,
  offsetLabel,
  pnlClass,
} from "../../lib/synthView.ts";

function money(v: number | null): string {
  return fmtMoney(v);
}

function DayItem({ k, v, sub, total, neutral }: { k: string; v: number; sub?: string; total?: boolean; neutral?: boolean }) {
  return (
    <div className={`box-daypnl-item${total ? " box-daypnl-total" : ""}${neutral ? " box-daypnl-item--neutral" : ""}`}>
      <span className="box-daypnl-k">{k}</span>
      <span className={`box-daypnl-v ${neutral ? "" : pnlClass(v)}`}>{neutral ? `₹${Math.round(v).toLocaleString("en-IN")}` : fmtMoney(v)}</span>
      {sub && <span className="box-daypnl-sub">{sub}</span>}
    </div>
  );
}

export function SynthDayPnlStrip({ dayPnl }: { dayPnl: SynthDayPnl | undefined }) {
  if (!dayPnl) return null;
  return (
    <section className="box-daypnl" aria-label="Running day P&L">
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
  if (ok === null) return <span className="box-dim">not recorded</span>;
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
          <span className="box-dim">book not recorded</span>
        )}
      </summary>
      <table className="box-table synth-legs">
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
                <span className={`box-leg box-leg--${f.side === "BUY" ? "buy" : "sell"}`}>{f.side} LIMIT</span>
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
    <div className={`box-metric ${cls}`} title={title}>
      <span className="box-metric-k">{k}</span>
      <span className="box-metric-v">{v}</span>
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
      <section className="box-section">
        <p className="box-empty">No open paper positions.</p>
      </section>
    );
  }
  return (
    <section className="box-section">
      <div className="synth-filters">
        <Button size="sm" variant="danger" disabled={busy} onClick={onCloseAll} title="Close every open position at the touch">
          Close all
        </Button>
      </div>
      <div className="box-cards">
        {positions.map((p) => {
          const exitByRole = new Map(p.exit_legs.map((l) => [l.role, l]));
          const closing = closingId === p.id || p.closing;
          return (
            <div key={p.id} className={`box-card${p.exit_eligible ? " box-card--exiting" : ""}`}>
              <div className="box-card-head">
                <div>
                  <span className="box-sym">{p.underlying}</span>
                  {p.is_index && <span className="synth-tag">INDEX</span>}
                  <span className={`synth-dir synth-dir--${p.direction.toLowerCase()}`}>{p.direction}</span>
                  <span className="synth-tag">{p.broker}</span>
                  <span className="box-card-strikes">
                    K {p.strike} <span className="box-dim">{offsetLabel(p.atm_offset)}</span>
                  </span>
                  <span className="box-dim">
                    {" "}
                    {formatExpiry(p.expiry)} · {p.quantity} qty ({p.lots} lot{p.lots === 1 ? "" : "s"})
                  </span>
                </div>
                <div className="box-card-actions">
                  {p.exit_eligible && <span className="synth-tag synth-tag--exit">EXIT ELIGIBLE</span>}
                  {p.expiry_safety && <span className="synth-tag synth-tag--warn">EXPIRY SAFETY</span>}
                  {!p.linked && <span className="synth-tag synth-tag--warn">NOT LINKED</span>}
                  <Button size="sm" disabled={closing || busy} onClick={() => onClose(p.id)} title="Close now at the executable touch">
                    {closing ? "Closing…" : "Close now"}
                  </Button>
                  <Button size="sm" variant="danger" disabled={closing || busy} onClick={() => onDelete(p)}>
                    Delete
                  </Button>
                </div>
              </div>

              <div className="box-legs">
                {p.legs.map((leg) => {
                  const ex = exitByRole.get(leg.role);
                  return (
                    <div key={leg.role} className="box-leg-row">
                      <span className={`box-leg box-leg--${leg.side === "BUY" ? "buy" : "sell"}`}>{leg.side}</span>
                      <span className="box-leg-name" title={leg.tradingsymbol}>
                        {legName(leg)}
                      </span>
                      <span className="box-leg-cell">entry {fmt(leg.entry_price)}</span>
                      <span className="box-leg-cell">LTP {ex?.ltp ? fmt(ex.ltp) : "-"}</span>
                      <span className="box-leg-cell">
                        close {ex?.side ?? "-"} {ex?.price ? fmt(ex.price) : "-"}
                      </span>
                      <span className="box-leg-cell box-dim">{ex ? `${ex.qty_at_touch} @ touch · ${ageText(ex.age_ms)}` : "-"}</span>
                      {ex && !ex.executable && <span className="synth-check synth-check--bad">{label(REJECT_LABEL, ex.reject)}</span>}
                    </div>
                  );
                })}
              </div>

              <FillsDetails legs={p.legs} phase="entry" quantity={p.quantity} />

              <div className="box-card-grid">
                <Metric k="Margin (basket)" v={marginText(p)} cls="box-metric--strong" title={p.margin_error ?? undefined} />
                <Metric k="Locked at entry" v={money(p.entry_edge)} />
                <Metric k="Expected net (entry)" v={money(p.expected_net_profit)} />
                <Metric k="Open P&L @ LTP" v={money(p.mtm_ltp)} cls={`box-metric--strong ${pnlClass(p.mtm_ltp)}`} />
                <Metric k="Gross if closed now" v={money(p.gross_pnl)} cls={pnlClass(p.gross_pnl)} />
                <Metric k="Entry fees" v={money(p.entry_charges)} />
                <Metric k="Exit fees now" v={money(p.current_exit_charges)} />
                <Metric k="Net if closed now" v={money(p.net_pnl)} cls={`box-metric--strong ${pnlClass(p.net_pnl)}`} />
                <Metric k="Remaining edge" v={money(p.remaining_edge)} />
                <Metric k="Captured" v={p.captured_pct === null ? "-" : `${Math.round(p.captured_pct * 100)}%`} />
                <Metric k="Converged at ≤" v={money(p.convergence_threshold)} />
                <Metric k="Profit capture at" v={money(p.profit_capture_target)} />
              </div>
              {!p.exit_eligible && <p className="box-dim synth-held">{heldText(p, money)}</p>}
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
    <section className="box-section">
      {error && <div className="banner banner--warn">{error}</div>}
      {loading && (
        <p className="box-dim">
          <span className="spinner" /> loading…
        </p>
      )}
      {trades.length === 0 ? (
        <p className="box-empty">{error ? "The closed-trade log could not be loaded." : "No closed paper trades yet."}</p>
      ) : (
        days.map((d) => (
          <details key={d.day} className="synth-day" open={d.day === today || days.length === 1}>
            <summary>
              <strong>{d.day === today ? `Today · ${d.day}` : d.day}</strong> · {d.trades.length} trade(s) · gross {fmtMoney(d.gross)} · fees{" "}
              {fmtMoney(d.fees)} · <span className={pnlClass(d.net)}>net {fmtMoney(d.net)}</span>
            </summary>
            <div className="box-table-wrap">
              <table className="box-table">
                <thead>
                  <tr>
                    <th>Underlying</th>
                    <th>Direction</th>
                    <th className="num">Strike</th>
                    <th>Broker</th>
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
                    const entryOk = fillVerdict(t.legs, "entry", t.quantity);
                    const exitOk = t.exit_reason === "EXPIRED" ? true : fillVerdict(t.legs, "exit", t.quantity);
                    const ok = entryOk === false || exitOk === false ? false : entryOk === null || exitOk === null ? null : true;
                    const isOpen = expanded === t.id;
                    return (
                      <Fragment key={t.id}>
                        <tr className="synth-row" onClick={() => setExpanded(isOpen ? null : t.id)} aria-expanded={isOpen}>
                          <td>
                            <span className="box-sym">{t.underlying}</span>
                          </td>
                          <td>
                            <span className={`synth-dir synth-dir--${t.direction.toLowerCase()}`}>{t.direction}</span>
                          </td>
                          <td className="num">{t.strike}</td>
                          <td className="box-dim">{t.broker}</td>
                          <td className="box-dim">{label(EXIT_REASON_LABEL, t.exit_reason)}</td>
                          <td className="num box-dim">{marginText(t)}</td>
                          <td className="num">{fmtMoney(t.entry_edge)}</td>
                          <td className="num box-dim">{fmtMoney(t.total_charges)}</td>
                          <td className={`num ${pnlClass(t.gross_pnl)}`}>{fmtMoney(t.gross_pnl)}</td>
                          <td className={`num ${pnlClass(t.net_pnl)}`}>
                            <strong>{fmtMoney(t.net_pnl)}</strong>
                          </td>
                          <td>
                            <BestCheck ok={ok} />
                          </td>
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
                            <td colSpan={12}>
                              <FillsDetails legs={t.legs} phase="entry" quantity={t.quantity} open />
                              {t.exit_reason === "EXPIRED" ? (
                                <p className="box-dim">{t.exit_note}</p>
                              ) : (
                                <FillsDetails legs={t.legs} phase="exit" quantity={t.quantity} open />
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
