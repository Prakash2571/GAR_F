/**
 * THE RISK PANEL — the per-Box ₹ cap, the same-underlying policy, and the entry burst width.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS READ-MOSTLY
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * These three limits are ENV-CONFIGURED on the server and deliberately not runtime-mutable:
 *
 *   BOX_LIVE_MAX_BOX_CAPITAL_RUPEES
 *   BOX_ONE_ACTIVE_BOX_PER_UNDERLYING
 *   BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY
 *
 * Each one changes what the execution layer is allowed to do with real money, and the existing
 * runtime-tunable contract in the backend is deliberately just two thresholds (entry gate and
 * safety buffer) — everything else describes the execution model rather than an operator
 * preference. Letting a risk cap drift mid-session would also make a trade's own frozen config
 * snapshot disagree with the limits it actually ran under.
 *
 * So this panel REPORTS them, with the exact variable names and values needed to change them
 * deliberately, and shows the live evidence that they are in force. That is more useful than an
 * input box that would have to be refused by the backend anyway.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * THE NAMING RULE THIS PANEL ENFORCES
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * The ₹ cap is GROSS ENTRY-ORDER NOTIONAL: SUM(|limit_price x quantity|) over the four bounded
 * LIMIT orders. It is NOT broker margin, and this panel never calls it margin. A four-leg Box is
 * hedged, so its real margin requirement is typically a small fraction of gross option notional
 * and can even be a net credit — an operator who read "margin" here and set a matching cap would
 * be off by roughly an order of magnitude.
 */

import type { BoxExecutionControl } from "./api";

function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

/** Human wording for one underlying-activity kind. */
const KIND_LABEL: Record<string, string> = {
  open_box: "open Box",
  partially_exited: "partially exited",
  recovery: "RECOVERY",
  residual_exposure: "residual exposure",
  working_entry_order: "working entry order",
  uncertain_intent: "uncertain broker state",
  entry_in_flight: "entry in flight",
};

export function BoxRiskControl({
  control,
  canTrade,
}: {
  control: BoxExecutionControl | undefined;
  canTrade: boolean;
}) {
  if (!canTrade || !control) return null;

  const risk = control.risk;
  const exec = control.execution;
  const capital = risk.capital;
  // ENFORCED, not merely configured. The paper mirror exists for parity testing but gates nothing,
  // so badging it as an active cap would have shown a limit that never refuses anything.
  const capEnabled = risk.max_box_capital_enforced;

  return (
    <section className="box-risk">
      <h4 className="box-risk-h">Risk limits</h4>

      {/* ── the per-Box ₹ cap ── */}
      <div className="box-risk-item">
        <div className="box-risk-item-head">
          <span className="box-risk-k">Maximum ₹ per Box</span>
          <span className={`box-risk-v${capEnabled ? " is-on" : ""}`}>
            {capEnabled ? rupees(risk.max_box_capital_rupees) : "DISABLED (unlimited)"}
          </span>
        </div>
        <p className="box-risk-hint">
          Measured as <code>{risk.max_box_capital_metric}</code> — the sum of{" "}
          <em>|limit price × quantity|</em> across the four bounded LIMIT entry orders. This is{" "}
          <strong>gross option-order notional, not broker margin</strong>: a hedged four-leg Box
          usually blocks far less capital than this, and can even be a net credit. Checked from the
          immutable order requests before any broker submission, and re-checked at the last safe
          moment before transmission.
        </p>
        {capEnabled && capital.last_calculated_rupees !== null && (
          <p className="box-risk-evidence">
            Last evaluated candidate: <strong>{rupees(capital.last_calculated_rupees)}</strong> against
            a {rupees(capital.configured_max_rupees)} cap at the <code>{capital.last_stage}</code>{" "}
            stage —{" "}
            <span className={capital.last_allowed ? "ok" : "warn"}>
              {capital.last_allowed ? "admitted" : "REFUSED (box_capital_limit)"}
            </span>
            .
          </p>
        )}
        {risk.paper_max_box_capital_rupees > 0 && !capEnabled && (
          <p className="box-risk-evidence">
            A paper mirror of {rupees(risk.paper_max_box_capital_rupees)} is configured
            (<code>BOX_PAPER_MAX_BOX_CAPITAL_RUPEES</code>). It is <strong>advisory</strong> and
            refuses nothing — only <code>BOX_LIVE_MAX_BOX_CAPITAL_RUPEES</code> in live mode gates an
            entry.
          </p>
        )}
        <p className="box-risk-env">
          Set with <code>BOX_LIVE_MAX_BOX_CAPITAL_RUPEES</code> (0 disables). Env-only: a risk cap
          that drifted mid-session would leave a trade's own frozen config snapshot disagreeing with
          the limits it actually ran under.
        </p>
      </div>

      {/* ── one active Box per underlying ── */}
      <div className="box-risk-item">
        <div className="box-risk-item-head">
          <span className="box-risk-k">One active Box per underlying</span>
          <span className={`box-risk-v${risk.one_active_box_per_underlying ? " is-on" : ""}`}>
            {risk.one_active_box_per_underlying ? "ON" : "OFF"}
          </span>
        </div>
        <p className="box-risk-hint">
          {risk.one_active_box_per_underlying ? (
            <>
              A second Box on an underlying that is already active is refused{" "}
              <strong>regardless of strike pair, expiry or direction</strong>. RELIANCE 2500/2600
              active blocks RELIANCE 2550/2650 even though they share no contract. Reported as{" "}
              <code>underlying_already_active</code> — never as a contract-reservation conflict,
              because the two Boxes need not share any option.
            </>
          ) : (
            <>
              Only the existing per-CONTRACT reservations apply, so two Boxes on one underlying at
              different strikes may run concurrently. Turning this on adds a broader layer; it never
              replaces the contract-level exclusion.
            </>
          )}
        </p>
        {risk.active_underlyings.length > 0 && (
          <ul className="box-risk-underlyings">
            {risk.active_underlyings.map((item) => (
              <li key={item.underlying}>
                <strong>{item.underlying}</strong>{" "}
                <span>{item.kinds.map((k) => KIND_LABEL[k] ?? k).join(", ")}</span>
                {risk.claimed_underlyings.includes(item.underlying) && (
                  <em title="A durable cross-process reservation is held for as long as the Box is open.">
                    {" "}
                    · lock held
                  </em>
                )}
              </li>
            ))}
          </ul>
        )}
        {risk.one_active_box_per_underlying && risk.active_underlyings.length === 0 && (
          <p className="box-risk-evidence">No underlying is currently carrying Box exposure.</p>
        )}
        <p className="box-risk-env">
          Set with <code>BOX_ONE_ACTIVE_BOX_PER_UNDERLYING</code>. Applies to ENTRY only: it can
          never block an exit, a protective cancel or a residual flatten.
        </p>
      </div>

      {/* ── THE INVENTORY CEILING — the mode-independent one, reported FIRST ──
          Listed above BOX_LIVE_MAX_OPEN_BOXES deliberately: this is the control that actually
          answers "can a second box open?", and an operator comparing the two needs to reach the
          enforceable one first. */}
      <div className="box-risk-item">
        <div className="box-risk-item-head">
          <span className="box-risk-k">Box inventory ceiling (all modes)</span>
          <span
            className={`box-risk-v${risk.max_open_boxes_all_modes > 0 ? " is-on" : ""}`}
          >
            {risk.box_inventory_held} held
            {risk.max_open_boxes_all_modes > 0 ? ` / ${risk.max_open_boxes_all_modes}` : " · no limit"}
          </span>
        </div>
        <p className="box-risk-hint">
          {risk.max_open_boxes_all_modes > 0 ? (
            <>
              Refused at admission in <strong>every</strong> execution mode, before any exposure
              exists — so it stops a second Box on <strong>any</strong> underlying, in{" "}
              <strong>either</strong> direction. "Held" counts committed exposure, not just open
              positions: an unresolved partial entry, an unreconciled order and an in-flight entry
              pipeline each occupy a slot, because each is capital at risk.
            </>
          ) : (
            <>
              <strong>No total limit.</strong> Nothing caps how many Boxes may be held at once in
              this deployment except the session budgets. Set{" "}
              <code>BOX_MAX_OPEN_BOXES</code> to bound it.
            </>
          )}
        </p>
        <p className="box-risk-env">
          Set with <code>BOX_MAX_OPEN_BOXES</code> (0 = unlimited). Bounds what you{" "}
          <strong>hold</strong>; <code>BOX_SESSION_MAX_ENTRY_ATTEMPTS</code> bounds what you{" "}
          <strong>try</strong> — an attempt that filled partially and was unwound leaves no inventory
          behind, so only the attempt budget catches it. A supervised trial wants both.
        </p>
      </div>

      {/* ── the LIVE open-box limit, and how it interacts ── */}
      <div className="box-risk-item">
        <div className="box-risk-item-head">
          <span className="box-risk-k">Maximum open Boxes (live only)</span>
          <span className="box-risk-v">
            {risk.open_boxes} open{risk.max_open_boxes > 0 ? ` / ${risk.max_open_boxes}` : ""}
          </span>
        </div>
        <p className="box-risk-hint">
          {risk.one_active_box_per_underlying && risk.max_open_boxes > 1 ? (
            <>
              With both in force, {risk.max_open_boxes} Boxes are permitted but they must be on{" "}
              {risk.max_open_boxes} <strong>different</strong> underlyings. Two Boxes on one
              underlying are refused whatever this number says.
            </>
          ) : (
            <>The total number of Box positions that may be open at once (<code>BOX_LIVE_MAX_OPEN_BOXES</code>).</>
          )}
          {control.session.max_completed_trades > 0 && (
            <>
              {" "}
              The session limit is stricter still: only {control.session.max_completed_trades} complete
              lifecycle(s) may run regardless of this cap.
            </>
          )}
        </p>
        <p className="box-risk-env">
          Enforced inside the live order manager, which paper never constructs — so a paper rehearsal
          does <strong>not</strong> exercise this cap. It is also read from a count refreshed only
          after a position exists, so it cannot refuse two entries admitted in the same instant. The
          ceiling above covers both gaps.
        </p>
      </div>

      {/* ── entry submission concurrency ── */}
      <div className="box-risk-item">
        <div className="box-risk-item-head">
          <span className="box-risk-k">Entry submission concurrency</span>
          <span className="box-risk-v">
            {exec.live_entry_submit_concurrency} of 4
            <small> base concurrency {exec.max_concurrent_executions}</small>
          </span>
        </div>
        <p className="box-risk-hint">
          How many of one Box's four ENTRY legs may be in transport at once (valid 1–4). It applies to{" "}
          <code>ENTRY</code> only and is scoped to a single Box pipeline, so it can never let two
          overlapping candidates bypass contract reservations. Burst slots are invisible to
          emergency, cancel and exit admission, so an entry burst cannot delay protective work.
          Broker rate limits are enforced independently by the transport pacer.
        </p>
        {exec.entry_burst && (
          <p className="box-risk-evidence">
            Observed peak {exec.entry_burst.peak_entry_submissions_in_flight} simultaneous entry
            submission(s) · {exec.entry_burst.burst_slot_grants} burst slot grant(s) ·{" "}
            {exec.entry_burst.base_in_flight} base + {exec.entry_burst.burst_in_flight} burst in flight
            now.
          </p>
        )}
        <p className="box-risk-env">
          Set with <code>BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY</code> (default 1, which reproduces the
          pre-burst serialised behaviour exactly; 4 is the recommended production value). Validated
          server-side into 1–4 independently of anything this UI sends.
        </p>
      </div>

      {/* ── daily loss limit ── */}
      <div className="box-risk-item">
        <div className="box-risk-item-head">
          <span className="box-risk-k">Daily loss limit</span>
          <span className={`box-risk-v${risk.daily_loss_limit > 0 ? " is-on" : ""}`}>
            {risk.daily_loss_limit > 0 ? rupees(risk.daily_loss_limit) : "DISABLED"}
          </span>
        </div>
        <p className="box-risk-hint">
          Realised today:{" "}
          <strong className={(risk.realised_pnl_today ?? 0) < 0 ? "warn" : "ok"}>
            {rupees(risk.realised_pnl_today)}
          </strong>
          . Reaching the limit trips the circuit breaker, which disables entry and is sticky for the
          life of the process.{" "}
          {/*
            * THE OMISSION THIS CLOSES. Everything above was accurate, but nothing said WHICH P&L the
            * breaker measures. It compares REALISED P&L only, and tripping sets `entryEnabled = false`
            * and nothing else — open positions are untouched. So an operator could reasonably read
            * "daily loss limit ₹5,000" as a cap on how much they can lose today, when unrealised
            * mark-to-market drawdown can exceed it without tripping anything and no position is closed
            * when it does trip. Saying so is the difference between a control they understand and one
            * they over-trust.
            */}
          It measures <strong>realised</strong> P&amp;L only: it stops the engine OPENING new boxes and
          does not close anything. Unrealised mark-to-market drawdown on an open box can exceed this
          figure without tripping it, so it is not a maximum loss and not a stop-loss.
        </p>
      </div>
    </section>
  );
}
