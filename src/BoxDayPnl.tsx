/**
 * A compact "how is today going" strip for the Box page.
 *
 * Shows the RUNNING day P&L the backend computes: the sum of open positions'
 * current net P&L, the realised net of trades closed today, and their total. The
 * backend is the sole authority for these figures (they come off the same
 * touch-based metrics the monitor uses); this only renders them.
 */

import type { AccountFunds, BoxDayPnl, FundsUnavailableReason } from "./api";

function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

function pnlClass(v: number): string {
  return v > 0 ? "is-pos" : v < 0 ? "is-neg" : "";
}

/**
 * What to SHOW when there is no balance figure.
 *
 * Each reason gets its own words because each calls for a different action, and collapsing them into
 * one dash is what leaves an operator staring at nothing with no idea whether to log in, wait, or
 * stop expecting a number at all. None of these is "₹0" — an empty account is a real, separate state
 * that renders as an actual zero.
 */
const FUNDS_UNAVAILABLE_LABEL: Record<FundsUnavailableReason, string> = {
  no_session: "no broker session",
  not_supported: "not available for this broker",
  never_read: "reading…",
  read_failed: "read failed",
  not_reported: "not reported by broker",
  semantics_unknown: "cannot be interpreted",
};

/**
 * FREE CAPITAL — the tile an operator checks before arming.
 *
 * Rendered in the neutral money group, deliberately without P&L colouring: a balance is capital, not
 * profit, so a big number here is neither good nor bad. Same convention as the margin tiles beside it.
 *
 * The staleness treatment is the load-bearing part. A figure past its freshness bound is STILL SHOWN,
 * with its age and a marker, because mid-session "₹47,000 as of 60s ago, refresh failing" is far more
 * useful than a blank — and blanking it would also be indistinguishable from an empty account.
 */
function AccountFundsItem({ funds }: { funds: AccountFunds | undefined }) {
  if (!funds) return null;

  // Zerodha's `available.live_balance` is the broker-reported margin available for a
  // new trade, not cash in a bank account. The backend applies the broker-specific
  // semantics once and never subtracts `utilised.debits` twice.
  const value = funds.free_to_trade_rupees;
  const known = value !== null;
  const ageSecs = funds.age_ms === null ? null : Math.round(funds.age_ms / 1000);
  const marginLabel = funds.broker === "zerodha" ? "Available margin to trade" : "Available funds to trade";
  const usedLabel = funds.broker === "zerodha" ? "used/blocked margin" : "used/blocked";

  return (
    <div
      className={`box-daypnl-item box-daypnl-item--neutral${known && !funds.fresh ? " is-stale" : ""}`}
      // The backend's own sentence, which already states what the figure cannot prove. Reusing it
      // rather than writing a second explanation keeps one authority for the caveat.
      title={funds.note}
    >
      <span className="box-daypnl-k">{marginLabel}</span>
      <span className="box-daypnl-v">
        {known ? (
          rupees(value)
        ) : (
          <span className="box-dim">
            —{" "}
            <span className="box-daypnl-reason">
              {funds.unavailable_reason
                ? FUNDS_UNAVAILABLE_LABEL[funds.unavailable_reason]
                : "unknown"}
            </span>
          </span>
        )}
      </span>
      <span className="box-daypnl-sub">
        {known ? (
          <>
            {funds.fresh ? (
              <>{ageSecs === null ? "" : `${ageSecs}s ago`}</>
            ) : (
              // Explicitly labelled, never shown as if it were current.
              <span className="is-warn">
                STALE · {ageSecs === null ? "unknown age" : `${ageSecs}s ago`}
              </span>
            )}
            {/* The encumbrance, when the broker reports it. Shown because "free" is only meaningful
                beside what is already blocked, and because null here means UNKNOWN rather than
                nothing blocked — a distinction that changes how far the headline can be trusted. */}
            {funds.broker_utilised_rupees !== null && (
              <> · {rupees(funds.broker_utilised_rupees)} {usedLabel}</>
            )}
          </>
        ) : (
          funds.last_error ?? "no figure published"
        )}
      </span>
    </div>
  );
}

export function BoxDayPnlStrip({
  dayPnl,
  funds,
}: {
  dayPnl: BoxDayPnl | undefined;
  /** From `status.account_funds`. Rendered even when the day-P&L block is absent. */
  funds?: AccountFunds | undefined;
}) {
  // The funds tile must survive a missing day-P&L block: account margin is worth showing before the
  // first trade of the day exists, which is exactly when an operator is deciding whether to arm.
  if (!dayPnl) {
    return funds ? (
      <section className="box-daypnl" aria-label="Account funds">
        <AccountFundsItem funds={funds} />
      </section>
    ) : null;
  }
  return (
    <section className="box-daypnl" aria-label="Running day P&L">
      {/*
        ACCOUNT MARGIN, FIRST, AND IN *THIS* BRANCH.
 
        This is the bug fix, and it is worth stating plainly because the original mistake was
        invisible by construction. The tile was rendered ONLY in the `!dayPnl` early return above,
        which reads as a sensible "show account margin even with no P&L yet" fallback — but `day_pnl` is a
        REQUIRED field of box-status and `computeDayPnl()` returns an object even with zero trades, so
        `dayPnl` is always truthy against a real backend. The early return was dead code, and the
        available-margin tile therefore never mounted anywhere. The backend was publishing the figure
        correctly the whole time.
 
        (`src/api/types.ts` declares `day_pnl?` optional while the schema marks it required, which is
        what made the dead branch look plausible in review. The tile is now rendered in BOTH branches,
        so that mismatch can no longer hide it.)
 
        Placed FIRST because it is the number an operator checks before arming: what can I trade with?
        That question precedes how today has gone.
      */}
      <AccountFundsItem funds={funds} />
      <Item
        label={`Open running net (${dayPnl.open_count})`}
        value={dayPnl.open_running_net_pnl}
        title="Sum of the current net P&L of every open box position"
      />
      <Item
        label={`Closed today net (${dayPnl.closed_count})`}
        value={dayPnl.closed_realised_net_pnl}
        title="Sum of the realised net P&L of every box closed today"
      />
      <Item
        label="Day net P&L"
        value={dayPnl.total_net_pnl}
        title="Open running net + today's realised net"
        total
      />
      {/* Margin is capital deployed, not profit, so it is deliberately rendered
          without the P&L colouring — a big number here is not a good or a bad
          thing. Hidden entirely on a backend that does not report it. */}
      {(dayPnl.cumulative_trade_margin ?? dayPnl.total_margin_used) !== undefined && (
        <div
          className="box-daypnl-item box-daypnl-item--neutral"
          title={
            `Zerodha basket margin these boxes blocked: ${rupees(dayPnl.open_margin_used)} currently ` +
            `open + ${rupees(dayPnl.closed_margin_used)} from boxes already closed today. ` +
            `This is a SUM over the day, so it is an upper bound on what was blocked at any single ` +
            `instant — boxes that opened and closed at different times never held their margin ` +
            `at the same time. It is NOT the peak concurrent figure shown separately below.` +
            (dayPnl.margin_unknown_count
              ? ` ${dayPnl.margin_unknown_count} box(es) have no margin figure and are excluded.`
              : "")
          }
        >
          <span className="box-daypnl-k">Cumulative trade margin</span>
          <span className="box-daypnl-v">
            {rupees(dayPnl.cumulative_trade_margin ?? dayPnl.total_margin_used)}
            {dayPnl.margin_unknown_count ? (
              <span className="box-dim"> ({dayPnl.margin_unknown_count} n/a)</span>
            ) : null}
          </span>
          <span className="box-daypnl-sub">
            {rupees(dayPnl.open_margin_used)} open · {rupees(dayPnl.closed_margin_used)} closed
          </span>
        </div>
      )}
      {dayPnl.peak_concurrent_margin !== undefined && (
        <div
          className="box-daypnl-item box-daypnl-item--neutral"
          title={
            "Highest OPEN margin actually observed at a sampled instant since this backend " +
            "process started. This is a real sampled measurement, not an estimate — it can " +
            "understate the true peak if it happened between samples, but it is never fabricated " +
            "for time before this process was running."
          }
        >
          <span className="box-daypnl-k">Peak concurrent margin</span>
          <span className="box-daypnl-v">
            {dayPnl.peak_concurrent_margin === null ? "—" : rupees(dayPnl.peak_concurrent_margin)}
          </span>
        </div>
      )}
    </section>
  );
}

function Item({
  label,
  value,
  title,
  total,
}: {
  label: string;
  value: number;
  title?: string;
  total?: boolean;
}) {
  return (
    <div className={`box-daypnl-item${total ? " box-daypnl-total" : ""}`} title={title}>
      <span className="box-daypnl-k">{label}</span>
      <span className={`box-daypnl-v ${pnlClass(value)}`}>{rupees(value)}</span>
    </div>
  );
}
