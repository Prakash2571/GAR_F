/**
 * THE NOTIFICATION BELL — which stock was refused, and why.
 *
 * WHY THIS EXISTS. A deployment could sit at `ATTEMPTS 355 / FAILED 355 / FAILURE RATE 100%` with
 * `UNKNOWN_INTERNAL_ERROR: 354` as the only explanation on the page. Nothing had crashed: the armed
 * session's attempt budget was spent and every candidate was correctly refused with
 * `session_limit_reached`. But the reason had been folded into an "unknown internal error" bucket by a
 * metric-label backstop, and the SYMBOL had nowhere to be published at all — so the screen described a
 * crash that never happened and withheld the one fact that would have explained everything.
 *
 * This panel renders `status.entry_alerts`, the backend's bounded per-underlying ledger, which is the
 * only surface carrying the symbol AND the reason AND an exact count AND a remedy.
 *
 * TWO PRESENTATION RULES IT MUST KEEP OBEYING
 *
 *  1. THE BADGE COUNTS `actionable_alerts`, NEVER `total_alerts`. Ordinary market churn — the price
 *     moved, the edge closed — is refusal after refusal in a healthy system. A badge that counted it
 *     would sit permanently at three digits and would be ignored within a day, taking the genuine
 *     alerts with it. `actionable` is the BACKEND's verdict and is deliberately not re-derived here,
 *     so the badge and the engine cannot disagree about what is urgent.
 *  2. IT NEVER INVENTS A VERDICT. Every reason, category and remedy sentence is the backend's. The one
 *     thing computed locally is "is this NEW since the operator last looked", which is a property of
 *     this browser session and belongs nowhere else.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { BellIcon, BellRingingIcon } from "@phosphor-icons/react";
import type { EntryAlert, EntryAlertCategory, EntryAlerts } from "../../api.ts";

/**
 * Where "already seen" is remembered.
 *
 * Deliberately per-browser and NOT sent to the backend: acknowledging a notification is a property of
 * one operator's attention, and persisting it server-side would make one person's dismissal silence
 * the bell for everybody watching the same deployment.
 */
const SEEN_KEY = "gts_box_alerts_seen_at";

/** How each category is titled and toned. The backend classifies; this only chooses words and colour. */
const CATEGORY_META: Record<
  EntryAlertCategory,
  { readonly label: string; readonly tone: string; readonly blurb: string }
> = {
  fault: {
    label: "Fault",
    tone: "is-fault",
    blurb: "Something in the engine failed. Not a market outcome.",
  },
  infrastructure: {
    label: "Infrastructure",
    tone: "is-infra",
    blurb: "A dependency is unhealthy — the feed or the database.",
  },
  operator_action: {
    label: "Needs you",
    tone: "is-operator",
    blurb: "A setting or a decision of yours is refusing entry. Nothing will trade until it changes.",
  },
  market: {
    label: "Market",
    tone: "is-market",
    blurb: "Normal market outcome. Nothing is broken.",
  },
};

/**
 * Turn a backend reason label into something readable WITHOUT inventing meaning.
 *
 * Purely mechanical: `session_limit_reached` → `SESSION LIMIT REACHED`. Deliberately not a lookup
 * table of prettier names — the taxonomy has ~25 members and a table would silently fall through to a
 * blank for any member it had not been taught, which is the exact failure this whole feature exists to
 * remove. The human explanation lives in `remedy`, which the backend always supplies.
 */
export function entryAlertReasonLabel(reason: string): string {
  return reason.replace(/_/g, " ").toUpperCase();
}

/** Compact relative age. */
function ago(at: number, now: number): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function readSeenAt(): number {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // A browser with storage blocked must still get a working bell; it simply forgets between loads.
    return 0;
  }
}

export default function BoxAlertsBell({ alerts }: { alerts: EntryAlerts | undefined }) {
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState<number>(() => readSeenAt());
  /** Re-rendered on a timer only so the "Ns ago" ages do not freeze while the panel is open. */
  const [now, setNow] = useState(() => Date.now());
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open]);

  // Esc closes, and the body must not scroll behind the drawer. Mirrors BoxHelp.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const actionable = alerts?.actionable_alerts ?? 0;
  const latestAt = alerts?.latest_at ?? null;
  /**
   * NEW means "an actionable refusal happened since you last opened this".
   *
   * Keyed off the backend's `latest_at` rather than a local diff of the array, so it survives a page
   * reload and cannot be fooled by re-ordering. Note it is intentionally gated on `actionable`: a
   * fresh crop of ordinary price-moved refusals must not light the bell.
   */
  const hasNew = actionable > 0 && latestAt !== null && latestAt > seenAt;

  const groups = useMemo(() => {
    const list = alerts?.alerts ?? [];
    // The backend already sorts urgency-first; grouping preserves that order within each bucket.
    const order: EntryAlertCategory[] = ["fault", "infrastructure", "operator_action", "market"];
    return order
      .map((category) => ({ category, items: list.filter((a) => a.category === category) }))
      .filter((g) => g.items.length > 0);
  }, [alerts]);

  function openPanel() {
    setOpen(true);
    // Acknowledge on OPEN, not on close: the operator has now seen the list, and marking it on close
    // would re-badge anything that arrived while they were reading it.
    const mark = latestAt ?? Date.now();
    setSeenAt(mark);
    try {
      window.localStorage.setItem(SEEN_KEY, String(mark));
    } catch {
      // Storage unavailable — the badge simply reappears on reload. Never a reason to fail the click.
    }
  }

  const title =
    alerts === undefined
      ? "Entry alerts — waiting for the first status from the backend"
      : actionable > 0
        ? `${actionable} entry alert(s) needing attention. ${alerts.actionable_rejections.toLocaleString("en-IN")} refused attempt(s).`
        : alerts.total_alerts > 0
          ? "No alerts needing attention. Ordinary market refusals are listed inside."
          : "No entry refusals recorded.";

  return (
    <>
      <button
        type="button"
        className={`btn box-alerts-btn${hasNew ? " has-new" : ""}`}
        onClick={openPanel}
        title={title}
        aria-label={
          actionable > 0 ? `Entry alerts, ${actionable} needing attention` : "Entry alerts"
        }
      >
        {hasNew ? (
          <BellRingingIcon size={16} weight="fill" aria-hidden="true" />
        ) : (
          <BellIcon size={16} weight="regular" aria-hidden="true" />
        )}
        <span>Alerts</span>
        {/* The badge shows the ACTIONABLE count only. Zero renders nothing rather than a "0" chip,
            because a permanent chip is a permanent thing to stop noticing. */}
        {actionable > 0 && (
          <span className="box-alerts-badge" aria-hidden="true">
            {actionable > 99 ? "99+" : actionable}
          </span>
        )}
      </button>

      {open && (
        <div className="box-help-backdrop" onClick={() => setOpen(false)}>
          <div
            className="box-help box-alerts"
            role="dialog"
            aria-modal="true"
            aria-label="Entry alerts"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="box-help-head">
              <div>
                <h2>Entry alerts — what was refused, and why</h2>
                <div className="box-help-sub">
                  {alerts === undefined ? (
                    "Waiting for the backend."
                  ) : (
                    <>
                      {alerts.total_rejections.toLocaleString("en-IN")} refused attempt(s) across{" "}
                      {alerts.total_alerts} underlying/reason group(s) since this backend started.{" "}
                      {actionable > 0
                        ? `${actionable} need attention.`
                        : "None need attention."}
                    </>
                  )}
                </div>
              </div>
              <button
                type="button"
                ref={closeRef}
                className="box-help-close"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </header>

            <div className="box-help-body">
              {alerts === undefined && (
                <p className="box-alerts-empty">
                  No status has arrived from the backend yet, so nothing can be said about refusals.
                  This is not the same as "no refusals".
                </p>
              )}

              {alerts !== undefined && alerts.total_alerts === 0 && (
                <p className="box-alerts-empty">
                  No entry attempt has been refused since this backend started. If you also see zero
                  attempts, the scanner is not attempting entries at all — check the execution state
                  and readiness rather than looking for refusals here.
                </p>
              )}

              {/* TRUNCATION IS ANNOUNCED. A partial list shown as a complete one would be a new way
                  of misleading an operator about how much is being refused. */}
              {alerts !== undefined && alerts.dropped_groups > 0 && (
                <p className="box-alerts-truncated">
                  <strong>This list is truncated.</strong> {alerts.dropped_groups} older
                  underlying/reason group(s) were dropped at the backend's group cap. The counts shown
                  are still exact for the groups that remain.
                </p>
              )}

              {groups.map(({ category, items }) => (
                <section key={category} className="box-alerts-group">
                  <h3 className={`box-alerts-group-head ${CATEGORY_META[category].tone}`}>
                    <span>{CATEGORY_META[category].label}</span>
                    <span className="box-alerts-group-count">{items.length}</span>
                  </h3>
                  <p className="box-alerts-group-blurb">{CATEGORY_META[category].blurb}</p>
                  {items.map((alert) => (
                    <AlertRow
                      key={`${alert.underlying}|${alert.reason}`}
                      alert={alert}
                      now={now}
                    />
                  ))}
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** One (underlying, reason) group. The symbol leads, because that is what an operator scans by. */
function AlertRow({ alert, now }: { alert: EntryAlert; now: number }) {
  return (
    <article className={`box-alerts-row ${CATEGORY_META[alert.category].tone}`}>
      <header className="box-alerts-row-head">
        <span className="box-alerts-underlying">{alert.underlying}</span>
        <span className="box-alerts-reason">{entryAlertReasonLabel(alert.reason)}</span>
        {/* The count is exact and unthrottled, so it is worth showing as a real number. */}
        <span className="box-alerts-count" title="How many times this exact refusal happened">
          ×{alert.count.toLocaleString("en-IN")}
        </span>
      </header>
      <div className="box-alerts-when">
        last {ago(alert.last_at, now)}
        {/* first_at is shown only once it differs, so a one-off does not carry a redundant clause.
            The distinction matters: the same count means very different things across ten seconds
            and across four hours. */}
        {alert.count > 1 && alert.first_at !== alert.last_at && (
          <> · first {ago(alert.first_at, now)}</>
        )}
      </div>
      <p className="box-alerts-remedy">{alert.remedy}</p>
      {alert.last_detail !== null && (
        <p className="box-alerts-detail" title="The refusing layer's own message for the most recent occurrence">
          {alert.last_detail}
        </p>
      )}
      {alert.last_candidate_key !== null && (
        <p className="box-alerts-candidate" title="The most recent candidate: underlying|expiry|lower strike|upper strike|direction">
          {alert.last_candidate_key}
        </p>
      )}
    </article>
  );
}
