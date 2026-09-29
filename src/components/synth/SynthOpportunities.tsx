/**
 * The scanner's rows: every strike × direction the backend priced, best first. Filtering and
 * the per-row leg drill-down are view-only; eligibility and entry decisions are the backend's.
 */

import { Fragment, useMemo, useState } from "react";
import Button from "../ui/Button.tsx";
import { fmt, fmtMoney, formatExpiry } from "../../format.ts";
import { describeRequestFailure } from "../../api/http.ts";
import { fetchSynthChain, type SynthChain, type SynthOpportunity } from "../../api/synth.ts";
import {
  ENTRY_BLOCK_LABEL,
  REJECT_LABEL,
  ageText,
  filterRows,
  label,
  legName,
  offsetLabel,
  pnlClass,
  type RowFilter,
} from "../../lib/synthView.ts";

function statusText(o: SynthOpportunity): { text: string; cls: string; title?: string } {
  switch (o.status) {
    case "ELIGIBLE":
      return o.entry_blocked
        ? { text: `ELIGIBLE · ${label(ENTRY_BLOCK_LABEL, o.entry_blocked)}`, cls: "box-status--eligible" }
        : { text: "ELIGIBLE · entering", cls: "box-status--eligible" };
    case "OPEN":
      return { text: "OPEN", cls: "box-status--open" };
    case "INDICATIVE":
      return { text: "INDICATIVE", cls: "box-status--indicative", title: "Market shut: last-session prices, never traded" };
    case "WATCHING":
      return { text: "watching", cls: "box-status--watching", title: label(REJECT_LABEL, o.reject) };
    default:
      return { text: label(REJECT_LABEL, o.reject) || "rejected", cls: "box-status--rejected" };
  }
}

function ChainView({ chain }: { chain: SynthChain }) {
  return (
    <div className="box-table-wrap">
      <table className="box-table synth-chain">
        <thead>
          <tr>
            <th className="num">CE bid</th>
            <th className="num">CE ask</th>
            <th className="num">Strike</th>
            <th className="num">PE bid</th>
            <th className="num">PE ask</th>
            <th className="num">K + CE − PE (mid)</th>
          </tr>
        </thead>
        <tbody>
          {chain.strikes.map((r) => {
            const ce = r.ce.bid > 0 && r.ce.ask > 0 ? (r.ce.bid + r.ce.ask) / 2 : null;
            const pe = r.pe.bid > 0 && r.pe.ask > 0 ? (r.pe.bid + r.pe.ask) / 2 : null;
            return (
              <tr key={r.strike} className={r.is_atm ? "synth-atm" : undefined}>
                <td className="num">{r.ce.bid ? fmt(r.ce.bid) : "-"}</td>
                <td className="num">{r.ce.ask ? fmt(r.ce.ask) : "-"}</td>
                <td className="num">
                  <strong>{r.strike}</strong>
                </td>
                <td className="num">{r.pe.bid ? fmt(r.pe.bid) : "-"}</td>
                <td className="num">{r.pe.ask ? fmt(r.pe.ask) : "-"}</td>
                <td className="num">{ce !== null && pe !== null ? fmt(r.strike + ce - pe) : "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="box-dim">
        Future {chain.future.tradingsymbol}: bid {fmt(chain.future.bid)} / ask {fmt(chain.future.ask)} · lot {chain.lot_size}
      </p>
    </div>
  );
}

export default function SynthOpportunities({
  rows,
  running,
  strikeLevel,
}: {
  rows: SynthOpportunity[];
  running: boolean;
  strikeLevel: number;
}) {
  const [filter, setFilter] = useState<RowFilter>({ direction: "all", bestOnly: true, positiveOnly: false, search: "" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [chain, setChain] = useState<{ u: string; data: SynthChain | null; error: string | null } | null>(null);
  const shown = useMemo(() => filterRows(rows, filter), [rows, filter]);

  const openChain = (u: string) => {
    setChain({ u, data: null, error: null });
    fetchSynthChain(u)
      .then((data) => setChain({ u, data, error: null }))
      .catch((err) => setChain({ u, data: null, error: describeRequestFailure(err) }));
  };

  return (
    <section className="box-section">
      <div className="synth-filters">
        {(["all", "CONVERSION", "REVERSAL"] as const).map((d) => (
          <Button
            key={d}
            size="sm"
            variant={filter.direction === d ? "primary" : "secondary"}
            aria-pressed={filter.direction === d}
            onClick={() => setFilter((f) => ({ ...f, direction: d }))}
          >
            {d === "all" ? "Both" : d}
          </Button>
        ))}
        <Button
          size="sm"
          variant={filter.bestOnly ? "primary" : "secondary"}
          aria-pressed={filter.bestOnly}
          onClick={() => setFilter((f) => ({ ...f, bestOnly: !f.bestOnly }))}
        >
          Best per symbol
        </Button>
        <Button
          size="sm"
          variant={filter.positiveOnly ? "primary" : "secondary"}
          aria-pressed={filter.positiveOnly}
          onClick={() => setFilter((f) => ({ ...f, positiveOnly: !f.positiveOnly }))}
        >
          Gross &gt; 0
        </Button>
        <input
          className="cfg-input synth-search"
          placeholder="Filter symbol"
          value={filter.search}
          onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
        />
      </div>

      {chain && (
        <div className="synth-chain-panel">
          <h3 className="box-section-title box-section-title--sub">
            {chain.u} chain
            <Button size="sm" variant="quiet" onClick={() => setChain(null)}>
              Close
            </Button>
          </h3>
          {chain.error ? (
            <div className="banner banner--warn">{chain.error}</div>
          ) : chain.data ? (
            <ChainView chain={chain.data} />
          ) : (
            <p className="box-empty">
              <span className="spinner" /> Loading…
            </p>
          )}
        </div>
      )}

      {!running && rows.length === 0 ? (
        <p className="box-empty">
          The scanner is stopped. Press <strong>RUN</strong> to compare each underlying's nearest future with its synthetic
          (K + CE − PE) at ATM ±{strikeLevel}.
        </p>
      ) : shown.length === 0 ? (
        <p className="box-empty">
          <span className="spinner" />
          {rows.length === 0 ? " Building the universe and waiting for books…" : " No rows match the filters."}
        </p>
      ) : (
        <div className="box-table-wrap">
          <table className="box-table">
            <thead>
              <tr>
                <th>Underlying</th>
                <th>Direction</th>
                <th>Expiry</th>
                <th className="num">Strike</th>
                <th className="num">Future</th>
                <th className="num">Synthetic</th>
                <th className="num" title="Locked per unit at the touch, before carry">
                  Lock/u
                </th>
                <th className="num">Carry/u</th>
                <th className="num">Qty</th>
                <th className="num">Gross</th>
                <th className="num">Entry fees</th>
                <th className="num">Est. exit fees</th>
                <th className="num">Expected net</th>
                <th>Book</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => {
                const st = statusText(o);
                const isOpen = expanded === o.key;
                return (
                  <Fragment key={o.key}>
                    <tr className="synth-row" onClick={() => setExpanded(isOpen ? null : o.key)} aria-expanded={isOpen}>
                      <td>
                        <span className="box-sym">{o.underlying}</span>
                        {o.is_index && <span className="synth-tag">INDEX</span>}
                      </td>
                      <td>
                        <span className={`synth-dir synth-dir--${o.direction.toLowerCase()}`}>{o.direction}</span>
                      </td>
                      <td className="box-dim">
                        {formatExpiry(o.expiry)} · {o.days_to_expiry.toFixed(1)}d
                      </td>
                      <td className="num">
                        {o.strike} <span className="box-dim">{offsetLabel(o.atm_offset)}</span>
                      </td>
                      <td className="num">{fmt(o.future_price)}</td>
                      <td className="num">{fmt(o.synthetic_price)}</td>
                      <td className={`num ${pnlClass(o.mispricing_per_unit)}`}>{fmt(o.mispricing_per_unit)}</td>
                      <td className="num box-dim">{fmt(o.carry_per_unit)}</td>
                      <td className="num">{o.quantity}</td>
                      <td className={`num ${pnlClass(o.gross_edge)}`}>{fmtMoney(o.gross_edge)}</td>
                      <td className="num box-dim">{fmtMoney(o.entry_charges)}</td>
                      <td className="num box-dim">{fmtMoney(o.estimated_exit_charges)}</td>
                      <td className={`num ${pnlClass(o.expected_net_profit)}`}>
                        <strong>{fmtMoney(o.expected_net_profit)}</strong>
                      </td>
                      <td className="box-dim" title={o.worst_age_ms !== null ? `Oldest leg book ${ageText(o.worst_age_ms)}` : undefined}>
                        {o.price_source === "last_close" ? "last close" : o.liquidity_ok ? "✓ full lot" : "thin"} ·{" "}
                        {ageText(o.worst_age_ms)}
                      </td>
                      <td>
                        <span className={`box-status ${st.cls}`} title={st.title}>
                          {st.text}
                        </span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="synth-detail">
                        <td colSpan={15}>
                          <table className="box-table synth-legs">
                            <thead>
                              <tr>
                                <th>Leg</th>
                                <th>Order</th>
                                <th className="num">Price used</th>
                                <th className="num">Bid (qty)</th>
                                <th className="num">Ask (qty)</th>
                                <th className="num">Qty at touch</th>
                                <th className="num">Age</th>
                                <th>Why</th>
                              </tr>
                            </thead>
                            <tbody>
                              {o.legs.map((l) => (
                                <tr key={l.role}>
                                  <td title={l.tradingsymbol}>{legName(l)}</td>
                                  <td>
                                    <span className={`box-leg box-leg--${l.side === "BUY" ? "buy" : "sell"}`}>{l.side} LIMIT</span>
                                  </td>
                                  <td className="num">{fmt(l.price)}</td>
                                  <td className="num">
                                    {l.bid ? fmt(l.bid) : "-"} <span className="box-dim">({l.bid_qty})</span>
                                  </td>
                                  <td className="num">
                                    {l.ask ? fmt(l.ask) : "-"} <span className="box-dim">({l.ask_qty})</span>
                                  </td>
                                  <td className="num">{l.qty_at_touch}</td>
                                  <td className="num">{ageText(l.age_ms)}</td>
                                  <td className="box-dim">{l.executable ? "✓" : label(REJECT_LABEL, l.reject)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div className="synth-detail-foot">
                            <span className="box-dim">
                              Mid basis {fmt(o.mid_basis)} (context only) · gate {fmtMoney(o.min_expected_net_profit)} · safety{" "}
                              {fmtMoney(o.safety_buffer)} · slippage {fmtMoney(o.expected_slippage)}
                            </span>
                            <Button
                              size="sm"
                              variant="quiet"
                              onClick={(e) => {
                                e.stopPropagation();
                                openChain(o.underlying);
                              }}
                            >
                              View chain
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
