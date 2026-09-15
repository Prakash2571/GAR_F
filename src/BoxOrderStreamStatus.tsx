/**
 * ORDER-UPDATE STREAM PANEL — "will I actually see a fill quickly?"
 *
 * This panel exists because the obvious dashboard design is wrong. A single green
 * "socket connected" light invites the inference that fills will be observed promptly, but
 * market-data health says nothing about order-update delivery: on Zerodha the two share one
 * socket but different frame types (binary ticks vs text postbacks), and on Dhan they are two
 * entirely separate WebSockets. So this renders the ORDER-UPDATE answer on its own, and states
 * the mechanism currently responsible for observing a fill rather than leaving it implied.
 *
 * The panel deliberately reads as a WARNING whenever fills depend on REST polling, including
 * when the operator has armed the env gate but nothing is consuming the stream. Showing that
 * as a neutral "disabled" would let an operator believe they had a fast fill path they do not
 * have — which is precisely the misreading this whole surface is designed to prevent.
 */

import type { OrderStreamStatus, OrderStreamBrokerStatus } from "./api";

/** Short, human label per wiring state. The tone is deliberately not reassuring for not_wired. */
function wiringLabel(w: OrderStreamBrokerStatus["wiring"]): string {
  switch (w) {
    case "not_built": return "not implemented";
    case "not_wired": return "not wired";
    case "gated_off": return "not armed";
    case "armed": return "armed";
    // Neutral on purpose: a paper backend builds no consumer BY DESIGN, so this is the expected
    // configuration rather than a shortcoming.
    case "not_applicable_paper": return "not applicable (paper)";
  }
}

/**
 * Severity for styling.
 *
 * `armed` + stream-observed is the only good state. `not_wired` is treated as a WARNING rather
 * than neutral, because the capability looks present in the code but delivers nothing.
 *
 * PAPER IS NEUTRAL, NOT BAD. This function used to end in `return "is-bad"`, so a paper deployment
 * — which has no consumer by construction — was painted red for not running a component it must
 * never run. Simulated fills are a healthy, chosen state, so they get the neutral treatment.
 */
function severity(b: OrderStreamBrokerStatus): "is-good" | "is-warn" | "is-bad" | "is-muted" {
  if (b.fills_observed_by === "stream_primary_rest_reconcile") return "is-good";
  if (b.wiring === "not_applicable_paper") return "is-muted";
  if (b.wiring === "not_wired") return "is-warn";
  return "is-bad";
}

function mechanismLabel(m: OrderStreamBrokerStatus["fills_observed_by"]): string {
  switch (m) {
    case "stream_primary_rest_reconcile":
      return "stream first, REST reconciles";
    // NOT "REST polling only": nothing is polled for an order that was never sent to a broker.
    case "simulated_paper_fills":
      return "Simulated fills";
    case "rest_polling_only":
      return "REST polling only";
  }
}

/** True when every published broker is in the paper/not-applicable state. */
function allPaper(orderStream: OrderStreamStatus): boolean {
  return (
    orderStream.brokers.length > 0 &&
    orderStream.brokers.every((b) => b.wiring === "not_applicable_paper")
  );
}

function ago(at: number | null): string {
  if (at === null) return "never";
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

export function BoxOrderStreamStatus({ orderStream }: { orderStream: OrderStreamStatus | undefined }) {
  // Rendered only when the backend actually published the block. An older backend that omits it
  // shows nothing rather than a fabricated green light.
  if (!orderStream) return null;

  return (
    <section className="box-exec-health">
      <h3 className="box-exec-health-title">
        Order-update stream{" "}
        {/*
          The headline must not say "REST polling" in paper mode. No order reaches the broker, so
          there is nothing to poll for — and an inactive-by-design stream is reported as inactive,
          never as broken.
        */}
        <span
          className={`box-exec-mode ${
            orderStream.any_stream_live ? "is-good" : allPaper(orderStream) ? "is-muted" : "is-warn"
          }`}
        >
          {orderStream.any_stream_live
            ? "live"
            : allPaper(orderStream)
              ? "not applicable · simulated fills"
              : "REST polling"}
        </span>
      </h3>

      {/*
        The anti-conflation sentence is rendered, not just documented. The backend asserts the
        same thing in the payload (market_data_health_is_not_order_stream_health), and an
        operator reading this panel is exactly the person who needs to be told.
      */}
      <p className="box-exec-note">
        A healthy market-data feed is <strong>not</strong> evidence that fills are observed
        promptly. This is the order-update path, measured separately.
      </p>

      <div className="box-exec-grid">
        {orderStream.brokers.map((b) => (
          <div key={b.broker} className={`box-exec-stat ${severity(b)}`} title={b.detail}>
            <span className="box-exec-stat-k">
              {b.broker} — {wiringLabel(b.wiring)}
            </span>
            <span className="box-exec-stat-v">{mechanismLabel(b.fills_observed_by)}</span>
            {b.health && (
              <span className="box-exec-stat-sub">
                {b.health.state}
                {b.health.disconnects > 0 && ` · ${b.health.disconnects} disconnect(s)`}
                {b.health.reconcilePending && " · REST reconciliation owed"}
                {` · last event ${ago(b.health.lastEventAt)}`}
              </span>
            )}
            {!b.health && (
              <span className="box-exec-stat-sub">
                no consumer · gate {b.gate_env_var} {b.gate_enabled ? "set" : "unset"}
              </span>
            )}
          </div>
        ))}
      </div>

      {/*
        When nothing is wired, say what that means operationally instead of leaving the
        operator to infer it from a grey badge.
      */}
      {orderStream.brokers.some((b) => b.wiring === "not_wired") && (
        <p className="box-exec-note is-warn">
          An order-update stream is implemented and unit-tested but no running component consumes
          it, so it cannot deliver a fill. Fill-observation latency is bounded by the REST polling
          cadence and the broker pacing floor. Requires supervised live validation before it is
          relied upon.
        </p>
      )}

      {/*
        PAPER, stated plainly and without alarm. This is the counterpart to the warning above: the
        same "no consumer" fact, but for a deployment where having one would be the bug.
      */}
      {allPaper(orderStream) && (
        <p className="box-exec-note">
          This deployment simulates execution, so no order is sent to a broker and no broker
          order-update stream applies. Fills are produced by the backend&apos;s execution simulator
          against real streamed quotes — they are simulated, never broker-confirmed.
        </p>
      )}
    </section>
  );
}
