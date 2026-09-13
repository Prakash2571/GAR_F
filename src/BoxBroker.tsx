/**
 * Broker presentation for the Box page.
 *
 * Kept in its own module for the same reason as BoxDirection.tsx: the broker
 * vocabulary must be identical across the opportunities, open and closed views, and
 * a badge that reads "ZERODHA" on one tab and "Zerodha" on another erodes trust in
 * a screen whose whole job is to say which venue owns a trade.
 *
 * Historical trades from both brokers coexist forever, so EVERY trade shows its own
 * badge — never the currently-active broker, which would silently relabel history.
 */

import type { BrokerId } from "./api";

/**
 * Compact "ZERODHA" / "DHAN" pill for one trade.
 *
 * `broker` is optional because rows written before broker identity existed have no
 * such field. Those are Zerodha trades — it was the only broker the application
 * ever had — so an absent value renders as ZERODHA rather than as "unknown".
 */
export function BrokerBadge({ broker }: { broker?: BrokerId | null }) {
  const isDhan = broker === "dhan";
  return (
    <span
      className={`box-broker ${isDhan ? "box-broker--dhan" : "box-broker--zerodha"}`}
      title={
        isDhan
          ? "This trade was created by the Dhan broker: Dhan market data priced it and Dhan's fee schedule costed it."
          : "This trade was created by the Zerodha broker: Zerodha market data priced it and Zerodha's fee schedule costed it."
      }
    >
      {isDhan ? "DHAN" : "ZERODHA"}
    </span>
  );
}

/** The closed-history broker filter. */
export type BrokerFilter = "all" | BrokerId;

/**
 * Filter closed trades by broker.
 *
 * Shown only when history actually contains more than one broker: offering a filter
 * with a single possible answer is noise, and on a Zerodha-only deployment it would
 * imply Dhan trades exist somewhere.
 */
export function BrokerHistoryFilter({
  value,
  onChange,
  counts,
}: {
  value: BrokerFilter;
  onChange: (next: BrokerFilter) => void;
  counts: { all: number; zerodha: number; dhan: number };
}) {
  if (counts.zerodha === 0 || counts.dhan === 0) return null;
  const options: { key: BrokerFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "zerodha", label: "Zerodha", count: counts.zerodha },
    { key: "dhan", label: "Dhan", count: counts.dhan },
  ];
  return (
    <span className="box-broker-filter" role="group" aria-label="Filter closed trades by broker">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`btn btn--sm${value === opt.key ? " btn--primary" : ""}`}
          aria-pressed={value === opt.key}
          onClick={() => onChange(opt.key)}
        >
          {opt.label} <span className="pill-count">{opt.count}</span>
        </button>
      ))}
    </span>
  );
}

/*
 * A second, single-broker `BrokerStatusPanel` used to live here. It was dead code — nothing
 * imported it — and it shared its name with the LIVE dual-broker panel in
 * `BrokerStatusPanel.tsx`, which is the one the workspace renders. Two exported components
 * with the same name, one of them unreachable, is how the wrong panel eventually gets edited.
 * It was removed with the workspace redesign; the dual-broker panel is the only broker status
 * surface, and it reports each broker's session, market-data health and order channel
 * separately rather than collapsing them.
 */
