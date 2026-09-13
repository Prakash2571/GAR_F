/**
 * The "?" explainer for the Box page.
 *
 * Written for a TRADER, not a developer: it explains what the page is doing, what
 * every label on it means, how a box is decided, and what each parameter actually
 * changes. No code identifiers, no implementation detail that a desk analyst would
 * not care about.
 *
 * Two rules this file must keep obeying:
 *
 *  1. It describes the CURRENT configuration, not documented defaults. The live
 *     `cfg` is passed in, so every parameter below prints the value the server is
 *     really running. A hardcoded default in a help panel becomes a lie the first
 *     time someone changes an env var.
 *  2. It never claims the page shows something it does not. Several backend
 *     concepts (the paper execution PROFILE, latency calibration, the queue
 *     haircut, live-vs-paper parity) are real but are not published to this page,
 *     and they are labelled as such rather than described as if visible.
 */

import { useEffect, useState } from "react";
import type { BoxConfigView, BoxExecutionMode } from "./api.ts";

/* ─────────────────────────── value formatting ─────────────────────────── */

function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

function ms(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}s` : `${Math.round(v)}ms`;
}

/** Config percentages are stored as fractions (0.2 = 20%). */
function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 1000) / 10}%`;
}

function yesNo(v: boolean | null | undefined): string {
  return v === undefined || v === null ? "—" : v ? "on" : "off";
}

function count(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toLocaleString("en-IN");
}

/** How the mode is written in the toolbar chip, so the help matches the screen. */
function modeLabel(mode: BoxExecutionMode | undefined): string {
  return (mode ?? "paper_latency").replace(/_/g, " ").toUpperCase();
}

export function BoxHelp({
  mode,
  cfg,
}: {
  /** The execution model the backend reports. Drives the honesty of the lead paragraph. */
  mode?: BoxExecutionMode;
  /** Live server configuration, so every parameter shown is the real one. */
  cfg?: BoxConfigView | null;
}) {
  const [open, setOpen] = useState(false);
  const isLive = mode === "live";

  // Esc closes, and the body must not scroll behind the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="box-help-btn"
        onClick={() => setOpen(true)}
        title="The method: what this page does, what every term means, and what every parameter changes"
      >
        Method
      </button>

      {open && (
        <div className="box-help-backdrop" onClick={() => setOpen(false)}>
          <div
            className="box-help"
            role="dialog"
            aria-modal="true"
            aria-label="Method — how GTS Box prices and enters a box"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="box-help-head">
              <h2>Method — how GTS Box prices and enters a box</h2>
              <button type="button" className="box-help-close" onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
            </header>

            <div className="box-help-body">
              {/* The lead must follow the mode. Saying "no order is ever sent" while the
                  backend is in LIVE would be the single most dangerous sentence here. */}
              {isLive ? (
                <p className="box-help-lead box-help-lead--live">
                  <strong>This backend is running LIVE.</strong> Boxes on this page are opened with
                  real broker orders through the fail-closed durable order manager, and the money is
                  real. Live positions cannot be deleted from this page — they can only be closed or
                  flattened, because the record is the only link to real exposure.
                </p>
              ) : (
                <p className="box-help-lead">
                  <strong>Everything here is paper trading.</strong> No order is sent to any broker.
                  Every simulated fill is taken from a price that was actually resting on the
                  exchange order book at that moment — never an invented, averaged or randomised
                  price. The current model is <strong>{modeLabel(mode)}</strong>.
                </p>
              )}

              <Section title="The trade">
                <p>
                  A <em>box</em> is four options on the same underlying and expiry, across two strikes
                  K1 &lt; K2. It settles at a fixed value — the strike width (K2 − K1) — wherever the
                  underlying ends up. So if you can put the box on for less than that width, the
                  difference is locked in.
                </p>
                <ul>
                  <li>
                    <strong>Long box</strong> — buy K1 call, sell K2 call, buy K2 put, sell K1 put.
                    You <em>receive</em> the width at expiry, so you want to pay less than it.
                  </li>
                  <li>
                    <strong>Short box</strong> — the exact mirror. You <em>pay</em> the width, so you
                    want to take in more than it.
                  </li>
                </ul>
                <p>
                  This strategy does <strong>not</strong> hold to expiry. It takes temporary
                  bid/ask dislocations and closes them when the prices converge, usually the same day.
                  Size is always <strong>one lot</strong>.
                </p>
              </Section>

              <Section title="What happens on every tick">
                <p>The pipeline is the same on every price update, and a candidate can be dropped at any step:</p>
                <ol className="box-help-steps">
                  <li>
                    <strong>Universe</strong> — F&amp;O stocks and supported indices, options only,
                    limited to the ATM ± window and to the feed's token budget.
                  </li>
                  <li>
                    <strong>Book freshness</strong> — each leg's order book must have been seen
                    recently enough. A depth feed only publishes when the book <em>changes</em>, so a
                    quiet strike is not a stale one; that is why the trust window is generous.
                  </li>
                  <li>
                    <strong>Depth</strong> — one whole lot must be resting at the touch on all four
                    legs. Not "somewhere in the book": at the price being used.
                  </li>
                  <li>
                    <strong>Gross prefilter</strong> — a cheap width-versus-cost test to discard the
                    obviously uninteresting before spending a charge calculation on them.
                  </li>
                  <li>
                    <strong>Charges</strong> — the real broker heads are priced. If they cannot be
                    priced, the box shows as <em>UNPRICED</em> and is never auto-traded. A box is not
                    entered on an unknown cost.
                  </li>
                  <li>
                    <strong>The entry gate</strong> — the one number that decides. See below.
                  </li>
                  <li>
                    <strong>Execution</strong> — the fill model runs (see the two execution settings).
                  </li>
                  <li>
                    <strong>Re-test on fills</strong> — the gate is applied again to the prices that
                    were actually filled, not the ones that were spotted.
                  </li>
                  <li>
                    <strong>Monitoring</strong> — an opened box is managed by the backend until it
                    closes, independent of RUN/STOP and of your browser.
                  </li>
                </ol>
              </Section>

              <Section title="The entry decision">
                <p>Every candidate is priced on <em>executable</em> quotes — the ask when buying, the bid when selling, never the last traded price. The decision is one number:</p>
                <p className="box-help-formula">
                  gross edge − entry charges − estimated exit charges − expected exit slippage −
                  safety buffer = <strong>expected net profit</strong>
                </p>
                <p>
                  If that clears the <strong>entry gate</strong>
                  {cfg ? <> — currently <strong>{rupees(cfg.min_expected_net_profit)}</strong></> : null}
                  , the box is taken. Charges are the real broker heads (brokerage, STT, exchange
                  transaction, SEBI, GST, stamp duty), calculated locally and then reconciled against
                  the broker's own contract note afterwards, so a modelling error in the cost stack
                  gets caught rather than compounding.
                </p>
                <p>
                  The <strong>safety buffer</strong> is subtracted <em>inside</em> that figure, so it
                  is part of the entry decision and raising it makes entry strictly harder. It is not
                  a stop-loss and it is not a reported-only number.
                </p>
                <p className="box-help-note">
                  The re-test on filled prices is the important part. A dislocation that decays while
                  the orders are in flight is rejected — and if all four legs had already filled by
                  then, the position is reversed immediately and that cost is booked as a loss rather
                  than hidden. Those appear under <em>Aborted legging executions</em>.
                </p>
              </Section>

              <Section title="The two execution settings (they are different things)">
                <p>
                  These are <strong>independent axes</strong>, and confusing them is the most common
                  misreading of this page.
                </p>
                <Glossary
                  rows={[
                    [
                      "Mode",
                      "Whether real orders can exist at all. This IS shown on this page, in the toolbar chip and in the ‘Execution’ and ‘Mode’ cells of the status strip. Values: paper touch, paper latency, paper legging, live.",
                    ],
                    [
                      "Profile",
                      "How faithfully the simulator behaves. This is a server-side setting and is NOT published to this page — you cannot tell from this screen which profile is active. Values: standard, live_parity, stress.",
                    ],
                  ]}
                />
                <p>The modes, in increasing realism:</p>
                <ul>
                  <li>
                    <strong>paper touch</strong> — assumes all four legs fill instantly at the prices
                    you spotted. Optimistic; useful only as a benchmark ceiling.
                  </li>
                  <li>
                    <strong>paper latency</strong> — waits a decision + order-travel delay, then fills
                    from the book that actually existed when the order would have landed.
                  </li>
                  <li>
                    <strong>paper legging</strong> — four <em>separate</em> orders, each arriving on
                    its own, each filling or resting or timing out independently. This is the one that
                    exposes legging risk: some legs on, others not.
                  </li>
                  <li>
                    <strong>live</strong> — real broker orders through the durable order manager.
                    Requires a second explicit server-side flag; it can never be reached by accident
                    from this page.
                  </li>
                </ul>
                <p>And the profiles, which layer on top of <em>paper legging</em>:</p>
                <ul>
                  <li>
                    <strong>standard</strong> — the baseline paper behaviour: a constant latency, no
                    cancel race, no shared liquidity between concurrent attempts.
                  </li>
                  <li>
                    <strong>live_parity</strong> — evidence-driven. Latency, the cancel-versus-fill
                    race window and the durable-write delay are drawn from <em>measured</em> live
                    observations whenever enough recent samples exist; the four legs are scheduled
                    through the same queue, concurrency cap and broker pacing that live execution
                    uses; and displayed liquidity is finite and shared, so two concurrent attempts
                    cannot both spend the same resting lot. Every figure it produces reports whether
                    it was measured or assumed.
                  </li>
                  <li>
                    <strong>stress</strong> — deliberate fault injection for resilience testing. It is
                    synthetic on purpose and is a separate profile precisely so an injected fault can
                    never be mistaken for observed behaviour. It refuses to start alongside live
                    execution.
                  </li>
                </ul>
                <p className="box-help-note">
                  Under <strong>live_parity</strong> the simulator also measures its own accuracy —
                  fill realisation against visible depth, the cost attribution of each attempt, and a
                  live-versus-paper timing comparison. Those diagnostics exist on the server and are
                  not rendered on this page, so treat the figures here as the headline and the server
                  diagnostics as the audit.
                </p>
              </Section>

              <Section title="What no simulation here can know">
                <p>
                  This is <strong>not an exact exchange simulator</strong> and must never be described
                  as one. It reproduces the <em>observable</em> execution path. It cannot reconstruct:
                </p>
                <ul>
                  <li>
                    <strong>queue position</strong> — level-2 depth aggregates quantity at a price and
                    says nothing about your place in the line at that price. It is approximated by a
                    deliberately conservative haircut, never reconstructed;
                  </li>
                  <li><strong>hidden or iceberg liquidity</strong> — by definition not displayed;</li>
                  <li><strong>the matching engine's ordering</strong> of trades;</li>
                  <li>
                    <strong>another participant's next order</strong> — including the one about to
                    take the liquidity you were relying on;
                  </li>
                  <li><strong>the exact market impact</strong> of your own order.</li>
                </ul>
                <p>
                  Nor does it invent price movement that never appeared on the feed, broker
                  acceptance quirks, or random slippage, rejects or latency jitter. Where something
                  has not been measured, a documented constant is used and reported as unmeasured —
                  a constant is never presented as an observation.
                </p>
              </Section>

              <Section title="How a box gets closed">
                <p>An open box is managed continuously by the backend. It closes when either:</p>
                <ul>
                  <li>
                    the edge has <strong>converged</strong> — the remaining edge has shrunk to the
                    exit threshold — <em>and</em> net profit clears the minimum
                    {cfg ? <> ({rupees(cfg.min_exit_net_pnl)})</> : null}, or
                  </li>
                  <li>
                    <strong>profit capture</strong> — enough of the original edge has already been
                    banked
                    {cfg ? <> ({pct(cfg.profit_capture_pct)} of it)</> : null} to justify taking it.
                  </li>
                </ul>
                <p>
                  Both paths additionally require that all four reversing legs currently have fresh,
                  one-lot, executable liquidity. A box is never closed on a price that could not
                  actually be traded, and it is never closed below break-even.
                </p>
                <p>
                  On expiry day an <strong>expiry-safety</strong> window
                  {cfg ? <> ({count(cfg.expiry_safety_minutes)} minutes before the close)</> : null}{" "}
                  forces an exit attempt so a position is never abandoned into settlement. If the
                  market cannot fill that close at a real price, the system refuses and says so on the
                  card rather than inventing a fill.
                </p>
                <p className="box-help-note">
                  When a box is <em>not</em> closing, the card says why in one sentence — below
                  break-even, liquidity not executable, edge not converged, or profit below the
                  capture level. "Held" is a stated reason, not the engine being asleep.
                </p>
              </Section>

              <Section title="The P&amp;L strip and margin">
                <ul>
                  <li>
                    <strong>Open running net</strong> — what open boxes would net if closed at the
                    current touch, after all charges. It moves with the market.
                  </li>
                  <li><strong>Closed today net</strong> — realised net on boxes closed today.</li>
                  <li><strong>Day net P&amp;L</strong> — the two added together.</li>
                  <li>
                    <strong>Cumulative trade margin</strong> — a <em>sum</em> over the day of the
                    basket margin each box blocked. Boxes that opened and closed at different times
                    never held their margin simultaneously, so this is an upper bound, not a peak.
                  </li>
                  <li>
                    <strong>Peak concurrent margin</strong> — the highest open margin actually
                    observed at a sampled instant since the backend started. It is never back-filled
                    or estimated for time before the process was running, so it reads "—" until a
                    first sample exists.
                  </li>
                </ul>
                <p className="box-help-note">
                  A large negative "open running net" alongside a healthy realised figure usually
                  means open boxes are being marked at the far side of a wide spread. That is a
                  mark-to-touch, not a loss taken.
                </p>
              </Section>

              <Section title="Reading the Execution health panel">
                <p>
                  This panel is the honesty check on the P&amp;L above it. <em>p50</em> is the typical
                  case and <em>p95</em> the bad case; read p95 before believing any average, because a
                  four-leg entry is killed by the tail, not by the mean.
                </p>
                <Glossary
                  rows={[
                    ["Attempts", "One per detected candidate that entered an order pipeline. Internal leg retries never inflate this."],
                    ["Successful", "All four legs filled and the box opened."],
                    ["Partial recovered", "Some legs filled, and the exposure was unwound cleanly. Nothing is left outstanding — but it still cost money."],
                    ["Partial unresolved", "Some legs filled and residual exposure REMAINS. This is the number to worry about."],
                    ["Failed / Aborted", "The attempt did not open a box. Aborts are counted, and their cost is booked."],
                    ["Retries", "Leg-level retries inside an attempt, deliberately excluded from Attempts so the two cannot be conflated."],
                    ["Success rate / Failure rate", "Success = successful ÷ completed. Failure = (failed + partial unresolved) ÷ completed."],
                    ["Decision→fill p50 / p95", "Elapsed time from spotting the box to the last leg filling."],
                    ["Decision deterioration", "Expected net at detection minus expected net at the prices actually filled. Positive means the mispricing decayed while the orders were in flight."],
                    ["Execution slippage", "Fill price against the book at the instant the order arrived. Zero is a real reading — it means the fill matched that book exactly, not that nothing was measured."],
                    ["Exit slippage", "The same measurement on the closing side."],
                    ["Expected vs realised", "Expected net at entry minus what the trade actually netted. Persistently positive means the model is flattering itself."],
                    ["Rejection categories", "Why attempts were rejected, most frequent first. These are raw backend reason keys, shown unmapped rather than guessed at."],
                    ["Legging block", "Only meaningful in paper legging / live: how often all four legs made it, and what the 3/4, 2/4 and 1/4 aborts cost."],
                    ["Most-failing leg", "Which of the four roles fails most often. A consistent offender usually means that strike is thinner than the others."],
                  ]}
                />
              </Section>

              <Section title="Every label on this page">
                <Glossary
                  rows={[
                    ["Broker", "Which venue owns the feed, the scanner and execution right now. Only one broker is ever active for new trades, but history from both coexists, so every row carries its own."],
                    ["Status (strip)", "SCANNING, MARKET_CLOSED or STOPPED — the scanner's own state."],
                    ["Entry gate", "Minimum expected net profit, after every cost, before a box is taken. Editable from ‘Edit thresholds’; saved on the server and applied to NEW boxes only."],
                    ["Execution / Mode", "The same value twice: ‘Execution’ shows it raw, ‘Mode’ and the toolbar chip show it prettified. They must agree."],
                    ["Directions", "Whether long boxes, short boxes or both are being scanned. Shown only when more than one is enabled."],
                    ["Safety buffer", "A risk allowance subtracted inside the expected-net figure, so it is part of the entry decision. Not a stop-loss. Editable from ‘Edit thresholds’."],
                    ["Universe", "What is scanned: F&O stocks plus supported indices, options only."],
                    ["Prices", "‘Executable touch’ while open; ‘Last close’ when shut — indicative only, nothing can trade."],
                    ["Strikes ATM ±", "The ACTIVE window, with the cap shown dimmed beside it. Narrowing it affects NEW boxes only; open positions are untouched."],
                    ["Lot", "Always one lot per box."],
                    ["Book trusted for", "How long an UNCHANGED order book is still treated as executable. A depth feed only publishes on change, so a quiet strike is not a stale one."],
                    ["Feed", "Connection heartbeat: how long since ANY instrument ticked. ‘idle’ when shut; ‘DOWN’ means the link is broken and all entries and automatic exits pause."],
                    ["Exchange lag ≈", "Rough staleness versus NSE, from the exchange's own one-second timestamps. Sensitive to server-clock skew, so it is an approximation, not a precise latency. Shown only while open."],
                    ["Watching", "How many underlyings and candidate boxes are being evaluated."],
                    ["Monitoring", "Open positions under management — independent of RUN/STOP and of your browser. ‘(monitor idle)’ means the exit loop is not cycling."],
                    ["Width", "K2 − K1: what the box settles at, and the ceiling on what it can be worth."],
                    ["Box value / Close cost", "What the four legs cost to put on at executable prices — or at last-close prices when the market is shut."],
                    ["Gross edge", "The raw mispricing: (width − box cost) × lot, before any costs."],
                    ["Entry fees / Est. exit fees", "Real broker charge heads for getting in, and the projection for getting out."],
                    ["Exec. cost", "The expected execution/slippage cost carried in the projection — an allowance, not a measurement."],
                    ["Safety", "The safety buffer applied to this candidate."],
                    ["Expected net", "Gross edge after charges, expected exit slippage and the safety buffer. This is what the gate tests. ‘unpriced’ means charges could not be priced, so it will never auto-trade."],
                    ["Liquidity", "Whether a whole lot is genuinely resting at the touch on all four legs. ‘n/a at close’ because closing prices carry no bid/ask."],
                    ["Fresh", "Age of the order book behind a quote. Beyond the trust window it is not used; ‘no book’ means none has arrived."],
                    ["WATCHING / AT LAST CLOSE / UNPRICED", "Being evaluated; derived from last-close prices and not enterable; or not priceable and therefore never auto-traded."],
                    ["AUTO PAPER TRADE", "Clears the gate and is being taken automatically."],
                    ["PAPER OPENED / OPEN", "Already has a position against it."],
                    ["BLOCKED", "Rejected this pass. Hover the chip for the specific reason."],
                    ["Entry edge / Expected net (entry)", "The terms the position was actually opened on. Editing thresholds later never rewrites these."],
                    ["Margin (all 4 legs)", "Net basket margin the four legs blocked, captured at entry. ‘unpriced’ when the margin call did not return."],
                    ["Exit value now", "What closing the box at the current touch would return."],
                    ["Realisable net", "Net if closed now, minus an allowance for the slippage the exit itself will cost. Always the more conservative of the two net figures."],
                    ["Remaining / Captured edge, Captured %", "How far the dislocation has converged. Convergence is the point of the strategy, so this is the progress bar."],
                    ["Exit threshold", "The remaining-edge level that counts as converged."],
                    ["Min exit profit", "The floor a convergence exit must clear."],
                    ["Profit capture at", "The banked-profit level that triggers an exit on its own, without waiting for convergence."],
                    ["AUTO EXIT ELIGIBLE / EXPIRY SAFETY", "The exit rules are satisfied and it will close on the next cycle; or the expiry window is forcing an exit attempt."],
                    ["Net P&L (closed)", "The actual result once the exit executed — nothing estimated, no allowances left."],
                    ["Reason", "Why it closed: EDGE_CONVERGED, PROFIT_CAPTURE, MANUAL or EXPIRY_SAFETY."],
                    ["retained", "A closed LIVE trade. It is the audit record of real executed orders and is deliberately not deletable."],
                    ["today from memory/redis/mongo", "Where today's closed trades were served from. memory and redis are the fast paths; mongo means the cache was cold."],
                    ["Aborted legging executions", "Partial fills that had to be emergency-unwound at a loss. Not trades — but they cost money, so they count against strategy P&L."],
                  ]}
                />
              </Section>

              <Section title="Parameters — the values this server is running">
                <p>
                  These are the live figures, read from the backend, not documented defaults. Only the
                  first two are editable from this page; everything else is set on the server and
                  changes on the next evaluation, affecting <strong>new</strong> boxes only.
                </p>
                {!cfg ? (
                  <p className="box-help-note">
                    Configuration has not loaded yet — reopen this panel once the page has connected
                    to the backend and the real values will appear here.
                  </p>
                ) : (
                  <>
                    <h4 className="box-help-sub">The entry decision</h4>
                    <Params
                      rows={[
                        ["Entry gate", rupees(cfg.min_expected_net_profit), "Minimum expected NET profit after every cost. THE gate. Editable here."],
                        ["Safety buffer", rupees(cfg.safety_buffer), "Risk allowance deducted inside the expected-net figure. Editable here."],
                        ["Gross prefilter", rupees(cfg.min_gross_edge), "Cheap width-vs-cost screen before charges are priced. Never the decision."],
                        ["Legacy net floor", rupees(cfg.min_net_edge), "An older additional floor. 0 means it does not raise the gate."],
                        ["Expected entry slippage", rupees(cfg.expected_entry_slippage), "Allowance for the entry costing more than the screen showed."],
                        ["Expected exit slippage", rupees(cfg.expected_exit_slippage), "Allowance for the exit, charged against the entry decision up front."],
                        ["Charges must be priced", yesNo(cfg.require_priced_charges), "When on, a box with unpriceable charges can never be auto-traded."],
                        ["Reconcile charges", yesNo(cfg.reconcile_charges), "Verify local charge maths against the broker's contract note afterwards."],
                        ["Reconcile warn at", pct(cfg.charge_reconcile_warn_pct), "Discrepancy above this raises a warning rather than passing silently."],
                      ]}
                    />

                    <h4 className="box-help-sub">Universe and data freshness</h4>
                    <Params
                      rows={[
                        ["Universe", cfg.universe, "Which instrument set is scanned."],
                        ["Strikes each side (cap)", `ATM ±${count(cfg.strikes_each_side)}`, "The hard ceiling on the window."],
                        ["Strikes each side (active)", `ATM ±${count(cfg.strike_level)}`, "The level actually selected, changeable from the toolbar."],
                        ["Max strikes", count(cfg.max_strikes), "Upper bound on strikes held per underlying."],
                        ["Candidates per underlying", count(cfg.max_candidates_per_underlying), "Caps how many strike pairs one symbol may contribute."],
                        ["Book trusted for", ms(cfg.quote_max_age_ms), "How long an UNCHANGED order book stays executable."],
                        ["Feed liveness limit", ms(cfg.feed_max_age_ms), "If no instrument ticks within this, the feed is DOWN and trading pauses."],
                        ["Underlying freshness", ms(cfg.underlying_max_age_ms), "How stale the underlying price may be before candidates are rejected."],
                        ["Subscribed token budget", count(cfg.max_subscribed_tokens), "Upstream subscription cap. Underlyings beyond it are not scanned, and are named in a banner."],
                        ["Last-close discovery", yesNo(cfg.indicative_discovery), "Whether the read-only last-close view is built while the market is shut."],
                      ]}
                    />

                    <h4 className="box-help-sub">Execution model</h4>
                    <Params
                      rows={[
                        ["Mode", cfg.execution_mode, "Whether real orders can exist. paper_touch / paper_latency / paper_legging / live."],
                        ["Lots", count(cfg.lots), "Always one lot per box."],
                        ["Simulated decision delay", ms(cfg.simulated_decision_ms), "Modelled time to decide, before an order is even sent. Paper modes only."],
                        ["Simulated order latency", ms(cfg.simulated_latency_ms), "Modelled travel time to the broker. The fill comes from the book that existed on arrival."],
                        ["Leg scheduling", cfg.leg_execution_mode ?? "—", "parallel or sequential, in paper legging. Sequential legs are safer and slower."],
                        ["Leg timeout", ms(cfg.leg_timeout_ms), "How long one leg may work before it is abandoned and the rest unwound."],
                        ["Short boxes enabled", yesNo(cfg.enable_short_box), "Whether the mirrored short box is scanned at all."],
                        ["Directions", cfg.directions?.join(" + ") || "—", "Which way boxes are being taken."],
                      ]}
                    />
                    <p className="box-help-note">
                      The paper <strong>profile</strong> (standard / live_parity / stress), the
                      calibration state, the queue haircut and the cancel-race window are all real
                      server-side parameters, but they are <strong>not</strong> published to this page
                      — so this table cannot show them, and this panel will not pretend to.
                    </p>

                    <h4 className="box-help-sub">Exit rules</h4>
                    <Params
                      rows={[
                        ["Convergence floor", rupees(cfg.convergence_floor), "Absolute remaining-edge level treated as converged."],
                        ["Convergence percent", pct(cfg.convergence_pct), "Remaining edge as a fraction of the entry edge that also counts as converged."],
                        ["Min exit profit", rupees(cfg.min_exit_net_pnl), "The floor a convergence exit must clear."],
                        ["Profit capture at", pct(cfg.profit_capture_pct), "Banked fraction of the entry edge that triggers an exit on its own."],
                        ["Min captured percent", pct(cfg.min_captured_pct), "Minimum share of the edge that must have been captured."],
                        ["Judge exit on realisable net", yesNo(cfg.exit_use_realisable_net), "When on, the exit floor is tested on the more conservative realisable figure."],
                        ["Expiry safety window", `${count(cfg.expiry_safety_minutes)} min`, "Minutes before the close on expiry day when an exit is forced."],
                      ]}
                    />
                  </>
                )}
              </Section>

              <Section title="Known limitations right now">
                <p>
                  These are current, verified shortcomings — not hypotheticals. They are listed here
                  because a figure on this page can be misread without them.
                </p>
                <ul>
                  <li>
                    <strong>Two boxes can share an option and both be taken.</strong> Every duplicate
                    guard in the engine is keyed on the whole strike pair
                    (underlying + expiry + K1 + K2 + direction), so a box on 1300/1320 and a box on
                    1320/1340 are treated as completely unrelated even though both trade the 1320
                    strike. They can be entered in the same second, and each one assumes the
                    <em> full</em> size it saw resting at that shared strike. Nothing reserves an
                    individual contract yet.
                  </li>
                  <li>
                    <strong>What that does to these numbers.</strong> In paper it can overstate what
                    was really achievable, because the same resting lot is spent twice. The effect is
                    largest in the faster paper modes, which allow several entry pipelines at once; a
                    live run is far more serialised, because the live path admits one box at a time.
                    If you see two boxes with a common strike opened at the same timestamp, treat the
                    pair's combined fills with suspicion rather than as two independent results.
                  </li>
                  <li>
                    <strong>One market-data connection is shared.</strong> Box options and the
                    calendar-spread board are fed by a single upstream connection to the active
                    broker, drawn from one token budget. A wide Box universe therefore competes for
                    the same subscription capacity as the board, which is why the strike window is
                    capped rather than unlimited.
                  </li>
                </ul>
                <p className="box-help-note">
                  Both of these are being worked on: per-contract execution reservation so overlapping
                  boxes cannot consume the same leg, and a dedicated Box market-data connection
                  separate from the futures one. Neither exists yet, so this panel does not describe
                  them as if they do.
                </p>
              </Section>

              <Section title="What this does not prove">
                <p>
                  {isLive ? (
                    <>
                      Live fills are real, but the figures here are still a small sample of one
                      strategy on one venue. Read the Execution health panel — especially the failure
                      rate, <em>Partial unresolved</em> and the p95 columns — before drawing any
                      conclusion from the P&amp;L.
                    </>
                  ) : (
                    <>
                      Simulated fills at observed quotes are <strong>not</strong> exchange fills.
                      Real trading additionally brings queue position, depth vanishing between
                      decision and arrival, partial fills, order rejection, and margin and position
                      limits. Treat these results as an <strong>upper bound</strong> on what the
                      strategy could have done, and read the Execution health figures before
                      believing the P&amp;L.
                    </>
                  )}
                </p>
                <p>
                  Above all: a healthy-looking day here is evidence about the <em>model</em> until it
                  has been reproduced with real orders. The system is built to report that gap rather
                  than to close it with an assumption.
                </p>
              </Section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="box-help-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Glossary({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="box-help-glossary">
      {rows.map(([term, meaning]) => (
        <div key={term} className="box-help-row">
          <dt>{term}</dt>
          <dd>{meaning}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Parameter name, the value this server is actually running, and what it changes. */
function Params({ rows }: { rows: [string, string, string][] }) {
  return (
    <dl className="box-help-params">
      {rows.map(([name, value, meaning]) => (
        <div key={name} className="box-help-prow">
          <dt>{name}</dt>
          <dd className="box-help-pval">{value}</dd>
          <dd className="box-help-pmean">{meaning}</dd>
        </div>
      ))}
    </dl>
  );
}
