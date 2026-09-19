/**
 * A compact execution-health panel for the Box page.
 *
 * Broken out of the (already large) Box page rather than inlined. It summarises
 * what the paper simulator is actually experiencing: fill vs abort rates, legging
 * losses, latency and slippage — never a per-attempt firehose. The backend
 * remains the sole authority; this only displays the rolling metrics it publishes.
 */

import type { BoxExecutionMode, BoxMetricsSnapshot } from "./api";

function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${Math.round(v * 1000) / 10}%`;
}

function ms(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v)}ms`;
}

/**
 * TONE IS A FUNCTION OF THE VALUE, NEVER OF THE LABEL.
 *
 * Every metric here used to carry a fixed tone: "Failed" was always negative, "Successful" always
 * positive. On a deployment that has not traded yet — a fresh boot, a disarmed gate, the first
 * minutes of any session, which is most of what an operator actually looks at — that rendered
 * `Failed 0` in red and `Successful 0` in green. Both are reports about something that has not
 * happened. Colour that is present regardless of the reading carries no information, and a panel
 * that is always partly red teaches the eye to discount red, which is the one thing a risk
 * readout cannot afford to do.
 *
 * The rule below: a counter at zero is an ABSENCE, not an achievement and not a fault, so it reads
 * muted. Colour appears only once the thing it describes has actually occurred. This is the same
 * argument the `.is-muted` rule in the stylesheet already makes for a paper deployment's missing
 * order stream — a state that does not apply must not wear the warning colour.
 */
const ABSENT = "is-muted";

/** Muted until the figure is both present and non-zero; then it means what the label says. */
function tone(v: number | null | undefined, whenPresent: string): string {
  if (v === null || v === undefined || v === 0) return ABSENT;
  return whenPresent;
}

/**
 * A derived RATE is muted until the denominator exists. A success rate of 0% across zero attempts
 * is not a failure, it is an undefined quantity, and colouring it would assert an outcome the
 * backend never reported.
 */
function rateTone(v: number | null | undefined, sampled: boolean, whenPresent: string): string {
  return sampled ? tone(v, whenPresent) : ABSENT;
}

export function BoxExecutionHealth({
  metrics,
  mode,
}: {
  metrics: BoxMetricsSnapshot | undefined;
  mode: BoxExecutionMode;
}) {
  if (!metrics) return null;
  const exec = metrics.execution;
  const legging = metrics.legging;
  /* Nothing derived from attempts means anything until at least one attempt exists. */
  const sampled = exec.attempted > 0;

  return (
    <section className="box-exec-health">
      <h3 className="box-exec-health-title">
        Execution health <span className="box-exec-mode">{mode}</span>
      </h3>

      <div className="box-exec-grid">
        <HealthStat
          label="Attempts"
          value={String(exec.attempted)}
          title="Parent strategy attempts — one per detected candidate that entered an order pipeline. Internal leg/order retries never count as a new attempt."
        />
        <HealthStat label="Successful" value={String(exec.successful)} cls={tone(exec.successful, "is-good")} />
        <HealthStat
          label="Partial recovered"
          value={String(exec.partial_recovered)}
          cls={tone(exec.partial_recovered, "is-warn")}
          title="Some legs filled and the position was recovered/unwound cleanly — no residual exposure remains."
        />
        <HealthStat
          label="Partial unresolved"
          value={String(exec.partial_unresolved)}
          cls={tone(exec.partial_unresolved, "is-bad")}
          title="Some legs filled and residual exposure remains outstanding."
        />
        <HealthStat label="Failed" value={String(exec.failed)} cls={tone(exec.failed, "is-bad")} />
        <HealthStat label="Aborted" value={String(exec.aborted)} cls={tone(exec.aborted, "is-warn")} />
        <HealthStat
          label="Retries"
          value={String(exec.retries)}
          title="Internal leg/order retries inside an attempt — excluded from the Attempts count above."
        />
        <HealthStat
          label="Success rate"
          value={pct(exec.success_rate)}
          cls={rateTone(exec.success_rate, sampled, "is-good")}
        />
        <HealthStat
          label="Failure rate"
          value={pct(exec.failure_rate)}
          cls={rateTone(exec.failure_rate, sampled, "is-bad")}
          title="(Failed + Partial unresolved) / Completed"
        />
        <HealthStat
          label="Decision→fill p50 / p95"
          value={`${ms(exec.latency.detection_to_fill_ms?.p50)} / ${ms(exec.latency.detection_to_fill_ms?.p95)}`}
        />
        <HealthStat
          label="Decision deterioration p50 / p95"
          value={`${rupees(exec.decision_deterioration?.p50)} / ${rupees(exec.decision_deterioration?.p95)}`}
          title="Detection expected net minus the realised expected net at actual fill prices. Positive means the mispricing decayed before the fill."
        />
        <HealthStat
          label="Execution slippage p50 / p95"
          value={`${rupees(exec.execution_slippage?.p50)} / ${rupees(exec.execution_slippage?.p95)}`}
          title="Fill price vs. the arrival-instant reference book. Zero is a valid, meaningful reading — it means the fill matched the captured arrival book exactly, not that nothing was measured."
        />
        <HealthStat label="Exit slippage p50" value={rupees(exec.exit_slippage?.p50)} />
        <HealthStat
          label="Expected vs realised (p50)"
          value={rupees(legging?.expected_vs_realised_net?.p50)}
          title="Expected net at entry minus the realised net of closed trades"
        />
      </div>

      {Object.keys(exec.rejection_categories).length > 0 && (
        <>
          <h4 className="box-exec-sub">Rejection categories</h4>
          <div className="box-exec-grid">
            {Object.entries(exec.rejection_categories)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([reason, count]) => (
                <HealthStat key={reason} label={reason} value={String(count)} />
              ))}
          </div>
        </>
      )}

      {legging && legging.outcomes.total > 0 && (
        <>
          <h4 className="box-exec-sub">Legging (four independent orders)</h4>
          <div className="box-exec-grid">
            {/* This block only renders when `outcomes.total > 0`, so these rates do have a
                denominator; the tone still follows the reading rather than the label. */}
            <HealthStat
              label="4/4 filled"
              value={pct(legging.fill_rate_4_of_4)}
              cls={tone(legging.fill_rate_4_of_4, "is-good")}
            />
            <HealthStat
              label="3/4 abort"
              value={pct(legging.failure_rate_3_of_4)}
              cls={tone(legging.failure_rate_3_of_4, "is-bad")}
            />
            <HealthStat
              label="2/4 abort"
              value={pct(legging.failure_rate_2_of_4)}
              cls={tone(legging.failure_rate_2_of_4, "is-bad")}
            />
            <HealthStat
              label="1/4 abort"
              value={pct(legging.failure_rate_1_of_4)}
              cls={tone(legging.failure_rate_1_of_4, "is-bad")}
            />
            <HealthStat
              label="Aborts"
              value={String(legging.outcomes.aborts)}
              cls={tone(legging.outcomes.aborts, "is-warn")}
            />
            <HealthStat
              label="Avg legging loss"
              value={rupees(legging.legging_net_loss?.mean)}
              cls={tone(legging.legging_net_loss?.mean, "is-bad")}
            />
            <HealthStat
              label="Legging loss p95"
              value={rupees(legging.legging_net_loss?.p95)}
              cls={tone(legging.legging_net_loss?.p95, "is-bad")}
            />
            <HealthStat label="1st→last fill p95" value={ms(legging.first_to_last_fill_ms?.p95)} />
            <HealthStat
              label="Most-failing leg"
              value={
                legging.most_failing_role
                  ? `${legging.most_failing_role.role} (${legging.most_failing_role.count})`
                  : "—"
              }
            />
          </div>
        </>
      )}
    </section>
  );
}

function HealthStat({ label, value, cls, title }: { label: string; value: string; cls?: string; title?: string }) {
  /*
   * A reading with no digit in it is an absence, not a measurement. `ms()` and `rupees()` render
   * an unpublished figure as "—", and the paired metrics as "— / —"; at full text weight those sit
   * in the grid looking exactly as substantial as a real number. Muting them keeps the eye on the
   * cells that actually carry a reading.
   *
   * Deliberately a digit test rather than a comparison against "—": it also catches the paired
   * form without special-casing it. And "₹0" or "0ms" DOES contain a digit, so a genuine zero
   * measurement stays at full weight — zero slippage is a real result, unlike an absent one.
   *
   * An explicit tone always wins, so the value-dependent tones above are never overridden here.
   */
  const resolved = cls ?? (/\d/.test(value) ? "" : ABSENT);
  return (
    <div className={`box-exec-stat ${resolved}`} title={title}>
      <span className="box-exec-stat-k">{label}</span>
      <span className="box-exec-stat-v">{value}</span>
    </div>
  );
}
