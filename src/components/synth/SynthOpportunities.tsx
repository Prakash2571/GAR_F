/**
 * The scanner's rows: every strike × direction the backend priced, best first. Filtering and
 * the per-row leg drill-down are view-only; eligibility and entry decisions are the backend's.
 *
 * Built for fast updates: the page hands in rows with structural sharing (an unchanged row is
 * the SAME object as last frame), every row is memoised with stable callbacks, so a snapshot
 * re-renders only the rows that changed. The row list is deferred, so typing in the filter
 * stays responsive while the market is busy. Key figures flash when they move.
 */

import { Fragment, memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import Button from "../ui/Button.tsx";
import { describeRequestFailure } from "../../api/http.ts";
import { fetchSynthChain, type SynthChain, type SynthOpportunity } from "../../api/synth.ts";
import { ENTRY_BLOCK_LABEL, REJECT_LABEL, filterRows, label, legName, offsetLabel, pnlClass, type RowFilter } from "../../lib/synthView.ts";
import { expiryLabel, liveAgeText, money, num2 } from "../../lib/synthLive.ts";
import { SynthTick } from "./SynthTick.tsx";

function statusText(o: SynthOpportunity): { text: string; cls: string; title?: string } {
  switch (o.status) {
    case "ELIGIBLE":
      return o.entry_blocked
        ? { text: `ELIGIBLE · ${label(ENTRY_BLOCK_LABEL, o.entry_blocked)}`, cls: "synth-status--eligible" }
        : { text: "ELIGIBLE · entering", cls: "synth-status--eligible" };
    case "OPEN":
      return { text: "OPEN", cls: "synth-status--open" };
    case "INDICATIVE":
      return { text: "INDICATIVE", cls: "synth-status--indicative", title: "Market shut: last-session prices, never traded" };
    case "WATCHING":
      return { text: "watching", cls: "synth-status--watching", title: label(REJECT_LABEL, o.reject) };
    default:
      return { text: label(REJECT_LABEL, o.reject) || "rejected", cls: "synth-status--rejected" };
  }
}

function ChainView({ chain }: { chain: SynthChain }) {
  return (
    <div className="synth-table-wrap">
      <table className="synth-table synth-chain">
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
                <td className="num">{r.ce.bid ? num2(r.ce.bid) : "-"}</td>
                <td className="num">{r.ce.ask ? num2(r.ce.ask) : "-"}</td>
                <td className="num">
                  <strong>{r.strike}</strong>
                </td>
                <td className="num">{r.pe.bid ? num2(r.pe.bid) : "-"}</td>
                <td className="num">{r.pe.ask ? num2(r.pe.ask) : "-"}</td>
                <td className="num">{ce !== null && pe !== null ? num2(r.strike + ce - pe) : "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="synth-dim">
        Future {chain.future.tradingsymbol}: bid {num2(chain.future.bid)} / ask {num2(chain.future.ask)} · lot {chain.lot_size}
      </p>
    </div>
  );
}

/** One strike × direction. Re-renders only when its own row object (or expansion) changes. */
const OppRow = memo(function OppRow({
  o,
  expanded,
  onToggle,
  onChain,
}: {
  o: SynthOpportunity;
  expanded: boolean;
  onToggle: (key: string) => void;
  onChain: (underlying: string) => void;
}) {
  const st = statusText(o);
  return (
    <Fragment>
      <tr className="synth-row" onClick={() => onToggle(o.key)} aria-expanded={expanded}>
        <td>
          <span className="synth-sym">{o.underlying}</span>
          {o.is_index && <span className="synth-tag">INDEX</span>}
        </td>
        <td>
          <span className={`synth-dir synth-dir--${o.direction.toLowerCase()}`}>{o.direction}</span>
        </td>
        <td className="synth-dim">
          {expiryLabel(o.expiry)} · {o.days_to_expiry.toFixed(1)}d
        </td>
        <td className="num">
          {o.strike} <span className="synth-dim">{offsetLabel(o.atm_offset)}</span>
        </td>
        <td className="num">
          <SynthTick value={o.future_price} text={num2(o.future_price)} />
        </td>
        <td className="num">
          <SynthTick value={o.synthetic_price} text={num2(o.synthetic_price)} />
        </td>
        <td className={`num ${pnlClass(o.mispricing_per_unit)}`}>
          <SynthTick value={o.mispricing_per_unit} text={num2(o.mispricing_per_unit)} />
        </td>
        <td className="num synth-dim">{num2(o.carry_per_unit)}</td>
        <td className="num">{o.quantity}</td>
        <td className={`num ${pnlClass(o.gross_edge)}`}>
          <SynthTick value={o.gross_edge} text={money(o.gross_edge)} />
        </td>
        <td className="num synth-dim">{money(o.entry_charges)}</td>
        <td className="num synth-dim">{money(o.estimated_exit_charges)}</td>
        <td className={`num ${pnlClass(o.expected_net_profit)}`}>
          <strong>
            <SynthTick value={o.expected_net_profit} text={money(o.expected_net_profit)} />
          </strong>
        </td>
        <td className="synth-dim" title={o.worst_age_ms !== null ? `Oldest leg book ${liveAgeText(o.worst_age_ms)} old; timestamp basis ${o.timestamp_source ?? "receipt"}; dispersion ${o.dispersion_ms ?? "unknown"} ms` : undefined}>
          {o.price_source === "last_close" ? "last close" : o.liquidity_ok ? "✓ full lot" : "thin"} · {liveAgeText(o.worst_age_ms)}
        </td>
        <td>
          <span className={`synth-status ${st.cls}`} title={st.title}>
            {st.text}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="synth-detail">
          <td colSpan={15}>
            <table className="synth-table synth-legs">
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
                      <span className={`synth-side synth-side--${l.side === "BUY" ? "buy" : "sell"}`}>{l.side} LIMIT</span>
                    </td>
                    <td className="num">
                      <SynthTick value={l.price} text={num2(l.price)} />
                    </td>
                    <td className="num">
                      {l.bid ? num2(l.bid) : "-"} <span className="synth-dim">({l.bid_qty})</span>
                    </td>
                    <td className="num">
                      {l.ask ? num2(l.ask) : "-"} <span className="synth-dim">({l.ask_qty})</span>
                    </td>
                    <td className="num">{l.qty_at_touch}</td>
                    <td className="num">{liveAgeText(l.age_ms)}</td>
                    <td className="synth-dim">{l.executable ? "✓" : label(REJECT_LABEL, l.reject)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="synth-detail-foot">
              <span className="synth-dim">Basket time: {o.timestamp_source ?? "receipt"} · dispersion {o.dispersion_ms ?? "unknown"} ms · {o.coherent ? "coherent" : "unconfirmed"}</span>
              <span className="synth-dim">
                Mid basis {num2(o.mid_basis)} (context only) · gate {money(o.min_expected_net_profit)} · safety {money(o.safety_buffer)} ·
                slippage {money(o.expected_slippage)}
              </span>
              <Button
                size="sm"
                variant="quiet"
                onClick={(e) => {
                  e.stopPropagation();
                  onChain(o.underlying);
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
});

function SynthOpportunities({ rows, running, strikeLevel }: { rows: SynthOpportunity[]; running: boolean; strikeLevel: number }) {
  const [filter, setFilter] = useState<RowFilter>({ direction: "all", bestOnly: true, positiveOnly: false, search: "" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [chain, setChain] = useState<{ u: string; data: SynthChain | null; error: string | null } | null>(null);
  // Typing in the filter is urgent; re-filtering a fresh snapshot can wait a frame.
  const deferredRows = useDeferredValue(rows);
  const shown = useMemo(() => filterRows(deferredRows, filter), [deferredRows, filter]);

  const onToggle = useCallback((key: string) => setExpanded((cur) => (cur === key ? null : key)), []);
  const onChain = useCallback((u: string) => {
    setChain({ u, data: null, error: null });
    fetchSynthChain(u)
      .then((data) => setChain({ u, data, error: null }))
      .catch((err) => setChain({ u, data: null, error: describeRequestFailure(err) }));
  }, []);

  return (
    <section className="synth-section">
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
          className="synth-input synth-search"
          placeholder="Filter symbol"
          value={filter.search}
          onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
        />
      </div>

      {chain && (
        <div className="synth-chain-panel">
          <h3 className="synth-section-title">
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
            <p className="synth-empty">
              <span className="spinner" /> Loading…
            </p>
          )}
        </div>
      )}

      {!running && rows.length === 0 ? (
        <p className="synth-empty">
          The scanner is stopped. Press <strong>RUN</strong> to compare each underlying's nearest future with its synthetic
          (K + CE − PE) at ATM ±{strikeLevel}.
        </p>
      ) : shown.length === 0 ? (
        <p className="synth-empty">
          <span className="spinner" />
          {rows.length === 0 ? " Building the universe and waiting for books…" : " No rows match the filters."}
        </p>
      ) : (
        <div className="synth-table-wrap">
          <table className="synth-table">
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
              {shown.map((o) => (
                <OppRow key={o.key} o={o} expanded={expanded === o.key} onToggle={onToggle} onChain={onChain} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default memo(SynthOpportunities);
