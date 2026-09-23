import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  boxStreamUrl,
  closeBoxTrade,
  deleteBoxTrade,
  fetchBoxChain,
  fetchBoxExecutionAttempts,
  fetchBoxHistory,
  fetchBoxOpportunities,
  fetchBoxExecutionControl,
  fetchBoxStatus,
  fetchRuntimeStatus,
  fetchExportStatus,
  setBoxStrikeLevel,
  startBoxScanner,
  stopBoxScanner,
  type BoxChain,
  type BoxExecutionAttempt,
  type BoxExecutionControl as BoxExecutionControlView,
  type BoxHistorySource,
  type BoxOpenPosition,
  type BoxOpportunity,
  type BoxSnapshot,
  type BoxStatus,
  type BoxTrade,
  type BrokerId,
  type RuntimeStatus,
  type ExportStatus,
} from "./api.ts";
import { accessStatus } from "./api/access.ts";
import { onUnauthorized } from "./api/http.ts";
import { ReconnectingBoxStream } from "./lib/boxStream.ts";
// SECTION 7: the three ways a correct backend answer still gets displayed wrongly — an
// out-of-order response overwriting newer state, a failed refresh leaving stale data looking
// current, and a double-submitted mutation. All three are guarded by these pure helpers.
import {
  ControlRequests,
  RefreshTracker,
  runOnce,
} from "./lib/statusIntegrity.ts";
// Contract v1.7.0: ordering readiness decisions ACROSS a backend restart. A process-local
// decision_generation cannot do it — see the module header for the defect it fixes.
import {
  ReadinessOrderTracker,
  verdictApplies,
  verdictDisablesEntry,
} from "./lib/readinessOrder.ts";
import { explainScannerStop, modeLabel } from "./lib/honestLabels.ts";
import { fmt, formatExpiry } from "./format.ts";
import BoxHeader from "./components/layout/BoxHeader.tsx";
import { DirectionBadge } from "./BoxDirection.tsx";
import { BrokerBadge, BrokerHistoryFilter, type BrokerFilter } from "./BoxBroker.tsx";
import BoxDeleteModal from "./BoxDeleteModal.tsx";
import { BoxExecutionHealth } from "./BoxExecutionHealth.tsx";
import { BoxOrderStreamStatus } from "./BoxOrderStreamStatus.tsx";
import { BoxOperationalState } from "./BoxOperationalState.tsx";
import { BoxExecutionAttempts } from "./BoxExecutionAttempts.tsx";
import { BoxDayPnlStrip } from "./BoxDayPnl.tsx";
// The four control panels are now mounted by ControlBox, which owns their layout and nothing else.
import { ControlBox } from "./components/box/ControlBox.tsx";
import { RunConfirm } from "./components/box/RunConfirm.tsx";
import { useBoxSounds } from "./useBoxSounds.ts";
import { BrokerStatusPanel } from "./BrokerStatusPanel.tsx";
import { RuntimeStatusBanners } from "./RuntimeStatusBanners.tsx";
import { marginProvenanceSuffix, marginOverstatesHedge } from "./marginProvenance.ts";

interface Props {
  /**
   * Called to lock the app — logs out and returns to the passcode gate.
   */
  onLock: () => void;
}

/** Money with no decimals — box figures are rupees, not paise. */
function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

function pnlClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "muted";
  if (v > 0) return "pnl-pos";
  if (v < 0) return "pnl-neg";
  return "";
}

/**
 * How long ago this leg's order book was last pushed.
 *
 * A depth feed only sends a message when the book CHANGES, so a few seconds of
 * silence on a quiet strike is normal and the book is still the current one —
 * hence the generous limit. Beyond it the book is no longer trusted for a fill.
 */
function Freshness({
  ageMs,
  limit,
  snapshotStale = false,
}: {
  ageMs: number | null;
  limit: number;
  /**
   * True when the SSE snapshot carrying this age has itself gone stale.
   *
   * WHY THIS PILL NEEDS TO KNOW. `ageMs` is computed by the BACKEND and shipped inside a snapshot, so
   * it measures "how old was this book when the server last spoke" — not "how old is it now". When the
   * stream stalls the value freezes, and a 320ms age keeps rendering green forever while the real age
   * grows without bound. That is the single most misleading thing on the page: the pill whose entire
   * job is to say whether a price is usable for a fill was the one lying about it.
   *
   * With a stale snapshot the age is no longer an age, so the pill says so rather than showing a
   * number that cannot be interpreted.
   */
  snapshotStale?: boolean;
}) {
  if (snapshotStale) {
    return (
      <span
        className="box-fresh box-fresh--bad"
        title="This book age came from the server inside a snapshot that has since gone stale, so it describes the past, not now. The real age is unknown and larger."
      >
        stale feed
      </span>
    );
  }
  if (ageMs === null) {
    return (
      <span className="box-fresh box-fresh--bad" title="No order book received for this leg yet">
        no book
      </span>
    );
  }
  const kind = ageMs <= limit ? "ok" : "bad";
  const text = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`;
  return (
    <span
      className={`box-fresh box-fresh--${kind}`}
      title={
        ageMs <= limit
          ? `Book last changed ${text} ago — within the ${(limit / 1000).toFixed(0)}s trust window. An unchanged book is still the current book.`
          : `Book has not changed for ${text}, beyond the ${(limit / 1000).toFixed(0)}s trust window, so it is not trusted for a fill.`
      }
    >
      {text}
    </span>
  );
}

const STATUS_LABEL: Record<BoxOpportunity["status"], string> = {
  WATCHING: "WATCHING",
  INDICATIVE: "AT LAST CLOSE",
  UNPRICED: "UNPRICED",
  ELIGIBLE: "AUTO PAPER TRADE",
  PAPER_OPENED: "PAPER OPENED",
  OPEN: "OPEN",
  REJECTED: "BLOCKED",
};

const REJECT_LABEL: Record<string, string> = {
  no_quote: "no live book",
  stale_quote: "stale book",
  missing_bid: "no bid",
  missing_ask: "no ask",
  insufficient_qty: "under one lot at the touch",
  below_gross_prefilter: "spread too small",
  below_net_edge: "net edge below the requirement",
  unpriced_charges: "charges unavailable",
  duplicate_open: "already open",
  stale_underlying: "stale underlying",
  market_closed: "market closed",
  implausible_close: "no comparable close",
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDayKey(iso: string): string {
  const at = new Date(iso).getTime();
  return Number.isFinite(at)
    ? new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10)
    : "unknown";
}

function istTodayKey(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istDayLabel(key: string): string {
  if (key === "unknown") return "Unknown date";
  const date = new Date(`${key}T00:00:00+05:30`);
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function duration(fromIso: string, toIso: string | null): string {
  const a = new Date(fromIso).getTime();
  const b = toIso ? new Date(toIso).getTime() : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "-";
  const secs = Math.max(0, Math.round((b - a) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export default function Box({ onLock }: Props) {
  // The site passcode is the single access boundary. This component is mounted only behind
  // <ProtectedRoute>, so a backend-confirmed session already exists; the session cookie then
  // authenticates every call and the backend enforces access per-request (any 401 clears
  // session state and returns the browser to the public page). These three flags are the
  // remains of a multi-tier admin model that no longer exists — all three are true here.
  const authenticated = true;
  const canTrade = true;
  const isFullAdmin = true;
  const { soundEnabled, toggleSound, notifyOpenSnapshot, notifyExit, testSound } = useBoxSounds();
  const [status, setStatus] = useState<BoxStatus | null>(null);
  /** Whole-system readiness readout, polled independently of the SSE. */
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  /** Async Mongo reporting-replica status. A lag here is expected and non-fatal. */
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null);
  const [opportunities, setOpportunities] = useState<BoxOpportunity[]>([]);
  const [open, setOpen] = useState<BoxOpenPosition[]>([]);
  const [history, setHistory] = useState<BoxTrade[]>([]);
  const [chain, setChain] = useState<BoxChain | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** The exact strike pair whose four legs should be highlighted in the chain. */
  const [selectedPair, setSelectedPair] = useState<{ k1: number; k2: number } | null>(null);
  /** Which of the three jobs the page is showing. */
  const [view, setView] = useState<"opportunities" | "open" | "history">("opportunities");
  /** Aborted paper_legging execution attempts (loaded lazily on the History tab). */
  const [attempts, setAttempts] = useState<BoxExecutionAttempt[]>([]);
  /**
   * Why the aborted-execution log could not be read, when it could not.
   *
   * Kept apart from `historyError` because the two answer different questions and an operator acts on
   * them differently. Without it, a failed fetch left `attempts` empty and the panel claimed "No
   * aborted legging executions recorded" — reporting ABSENCE OF LOSSES when the truth was absence of
   * DATA.
   */
  const [attemptsError, setAttemptsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  /** The trade the destructive delete modal is confirming, or null when closed. */
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    underlying: string;
    direction: BoxTrade["direction"];
    broker?: BrokerId | null;
    lower_strike: number;
    upper_strike: number;
    status: "open" | "closed" | "error";
  } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** Closed-history broker filter. Only rendered when both brokers appear. */
  const [brokerFilter, setBrokerFilter] = useState<BrokerFilter>("all");
  const [live, setLive] = useState(false);
  /**
   * When the LAST SSE SNAPSHOT ACTUALLY ARRIVED, by this browser's clock. Null before the first one.
   *
   * WHY A CLIENT-SIDE STAMP IS REQUIRED. `live` is a pure EventSource-lifecycle boolean: it is set by
   * `onOpen`/`onEvent` and cleared by `onDisconnect`, and `onDisconnect` only fires when EventSource
   * raises an ERROR — i.e. a BROKEN connection. A backend whose event loop wedges, whose snapshot
   * timer dies, or whose stream is held open by nginx or a load balancer while no bytes flow produces
   * no error event at all. Every consequence then lands at once:
   *
   *   - `pending.current` is never refilled, so the flush below returns early and the last
   *     `status` / `opportunities` / `open` stay mounted verbatim;
   *   - the header badge stays green "Scanning";
   *   - the Feed cell renders `live (243ms)` from the FROZEN `status.feed_age_ms` — a
   *     backend-computed field cannot report that the backend stopped talking;
   *   - `<Freshness ageMs={o.worst_age_ms}/>` keeps rendering the frozen server-side book age in
   *     green, so a 40-second-old edge reads as a 320ms-old edge.
   *
   * And no button's actionability changed: an operator could arm real entry, or press "Close now at
   * the current executable touch", against a snapshot of unbounded age.
   *
   * The backend cannot help here — `box-sse-snapshot.schema.json` is a CLOSED object of exactly
   * `{status, opportunities, open_trades}` with no `emitted_at` and no sequence — so the age has to be
   * measured on arrival, which is what this is. The machinery already existed and was applied to the
   * LESS important path: `RefreshTracker` + `freshnessBand` wrap the 5s runtime poll. Nothing wrapped
   * the stream the entire price surface depends on.
   */
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  /**
   * Re-evaluated on a timer so snapshot age advances with the passage of time rather than only when a
   * frame arrives — which is the whole point, since the failure being detected is frames STOPPING.
   */
  const [snapshotAgeMs, setSnapshotAgeMs] = useState<number | null>(null);
  /**
   * True while the pre-run confirmation is open.
   *
   * Deliberately OUTSIDE runOnce: this only decides whether to ASK, and the confirm handler goes
   * through the very same toggleScanner() as before, so the synchronous single-flight claim that
   * stops a double submit is untouched.
   */
  const [confirmRun, setConfirmRun] = useState(false);
  /** Execution mode / arming / session / risk. Its own state and its own error line. */
  const [executionControl, setExecutionControl] = useState<BoxExecutionControlView | undefined>(undefined);
  const [executionError, setExecutionError] = useState<string | null>(null);
  /** Closed-trade loading state, kept apart from the control surface's own error. */
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** Which tier served today's trades: memory / redis / mongo. */
  const [historySource, setHistorySource] = useState<BoxHistorySource | null>(null);
  const [historyDbEnabled, setHistoryDbEnabled] = useState(true);

  // The stream pushes a full snapshot a couple of times a second. It is buffered
  // and flushed on an interval so a busy scanner cannot re-render this page on
  // every frame — the backend has already made the trading decision by then.
  const pending = useRef<BoxSnapshot | null>(null);
  /**
   * Ids of closed trades held with their full execution audit, so a later
   * audit-stripped copy of the same trade cannot replace it. See mergeHistory.
   */
  const fullRows = useRef<Set<string>>(new Set());

  /* ───────────────────── SECTION 7: status integrity ───────────────────── */

  /**
   * The highest readiness generation ALREADY rendered.
   *
   * `box_status` reaches this component from five independent places (the initial REST load, the
   * opportunities fetch, the SSE snapshot flush, and the responses to the scanner and strike-level
   * mutations). They are separate requests and can resolve out of order, so a slow OLDER response
   * could land after a newer one and silently rewind the dashboard — including rewinding a fresh
   * "entry blocked" back to a stale "entry permitted".
   *
   * Held in a REF, not state: the comparison has to be correct for two responses that land in the
   * same frame, and a state value read from a render closure would be stale for the second of them.
   */
  /**
   * RESTART-AWARE ORDERING STATE (contract v1.7.0).
   *
   * This used to be a bare `useRef<number | null>` holding the last `decision_generation`, and the
   * guard accepted only a strictly greater one. That ordered concurrent responses from ONE backend
   * process correctly and broke completely across a restart: the backend mints that counter with
   * `++this.readinessDecisionGeneration` on a field declared `= 0`, so after a restart it publishes 1
   * while the browser is holding 5000 — and 5000 > 1, so every decision from the new process was
   * rejected indefinitely. The dashboard went on rendering a permission verdict from a process that
   * no longer existed, and only a manual reload cleared it.
   *
   * The tracker orders by (instance.boot_ordinal, decision_generation) and REBASES onto a newer
   * instance, so a restart is picked up automatically while a delayed response from the superseded
   * process is still refused. See lib/readinessOrder.ts.
   */
  const readinessOrder = useRef(new ReadinessOrderTracker());
  /**
   * Set when a readiness payload could not be ORDERED at all — no instance identity, no durable boot
   * ordinal, or two backends claiming one epoch. Distinct from "stale": a stale response is normal and
   * what is on screen is still the newest thing seen, whereas an unorderable one means we cannot tell
   * whether what is on screen is current. Rendered as an entry-disabling banner.
   */
  const [readinessIncompatible, setReadinessIncompatible] = useState<string | null>(null);

  /**
   * The ONE guarded way this component accepts a status payload.
   *
   * Everything that used to call `setStatus` directly now goes through here, so the ordering rule is
   * applied in one place rather than remembered at five call sites.
   */
  const applyStatus = useCallback((incoming: BoxStatus | null | undefined): boolean => {
    const verdict = readinessOrder.current.offerStatus(incoming);
    if (!verdictApplies(verdict.kind)) {
      // An unorderable payload must visibly disable new entry rather than be silently dropped: the
      // operator needs to know we cannot vouch for what is on screen.
      setReadinessIncompatible(verdictDisablesEntry(verdict.kind) ? verdict.reason : null);
      return false;
    }
    setReadinessIncompatible(null);
    setStatus(incoming as BoxStatus);
    // WHEN this snapshot was observed. The readiness payload and the runtime payload are fetched on
    // separate timers and neither carries a shared ordering field, so the only way to say how far
    // apart they are is to record it here. Used to WORD a conflict, never to resolve one — see
    // lib/reductionAssurance.ts.
    setReadinessObservedAt(Date.now());
    return true;
  }, []);

  /**
   * Runtime-status refresh health.
   *
   * The poll below used `.catch(() => {})`, so once the endpoint began failing the last good
   * snapshot simply stayed on screen — indistinguishable from a healthy system. This records the
   * outcome so the readiness banners can go stale/unknown instead of confidently wrong. 12s is
   * ~2 missed polls at the 5s cadence.
   */
  const runtimeRefresh = useRef(new RefreshTracker(12_000));
  const [runtimeFreshness, setRuntimeFreshness] = useState(() => runtimeRefresh.current.state(Date.now()));
  // Observation times for the two INDEPENDENTLY fetched snapshots. See `applyStatus`.
  const [runtimeObservedAt, setRuntimeObservedAt] = useState<number | null>(null);
  const [readinessObservedAt, setReadinessObservedAt] = useState<number | null>(null);

  /**
   * In-flight control mutations, per DISTINCT control class.
   *
   * A ref-held synchronous registry, because a `disabled={busy}` guard cannot stop a double-click
   * that happens before React re-renders. Per-class (rather than one global flag) so an emergency
   * action is never queued behind an unrelated control.
   */
  const controls = useRef(new ControlRequests());

  const running = status?.running === true;

  /**
   * The mode label for the page header, from the BACKEND's own `execution_mode`.
   *
   * Not a constant, and not derived from whether the live controls happen to be armed: a live
   * deployment with its controls disarmed is still live, one toggle away from real orders.
   */
  const headerMode = modeLabel(status?.execution_mode);

  /* --------------------------------- load -------------------------------- */

  const loadStatus = useCallback(async () => {
    try {
      // Guarded: an older in-flight response must never overwrite newer rendered state.
      applyStatus(await fetchBoxStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load box status.");
    }
  }, []);

  /**
   * The execution control surface: mode, live capability, arming, session and risk limits.
   *
   * Fetched SEPARATELY from `status` and deliberately NOT folded into the SSE stream. It is a cold
   * read on the server (it consults the reservation store and the session record), so polling it at
   * the stream's rate would be wasteful; and it must never be the thing that makes the price view
   * stall, so its failure is reported on its own line rather than clearing `status`.
   */
  const loadExecutionControl = useCallback(async () => {
    try {
      setExecutionControl(await fetchBoxExecutionControl());
      setExecutionError(null);
    } catch (err) {
      setExecutionError(
        err instanceof Error ? err.message : "Failed to load the execution control state.",
      );
    }
  }, []);

  /**
   * Merge closed trades into the list, newest-closed first.
   *
   * Never a plain replace. Three sources feed this list — the fast "today" fetch,
   * the slower full-book fetch and live SSE `exit` events — and they can land in
   * any order, so it is keyed on id and no source can drop another's trades.
   *
   * `lite` says whether the incoming rows have had their execution-audit blobs
   * stripped (the fast path does that; the full book does not). A lite row must not
   * overwrite a full one already in state — an SSE `exit` delivers the complete
   * trade, and a later "today" refresh would otherwise quietly hollow it out.
   *
   * Which rows are full is tracked here rather than sniffed off the row, because
   * `BoxTrade` deliberately does not model the audit blobs at all: nothing on this
   * page renders them, so the wire carries fields the type has no reason to declare.
   */
  const mergeHistory = useCallback((incoming: BoxTrade[], lite = false) => {
    setHistory((current) => {
      const byId = new Map<string, BoxTrade>();
      for (const trade of current) byId.set(trade.id, trade);
      for (const trade of incoming) {
        // Keep the richer row: only skip when a lite row would replace a full one.
        if (lite && fullRows.current.has(trade.id)) continue;
        if (!lite) fullRows.current.add(trade.id);
        byId.set(trade.id, trade);
      }
      return [...byId.values()].sort((a, b) =>
        (b.closed_at ?? b.opened_at).localeCompare(a.closed_at ?? a.opened_at),
      );
    });
  }, []);

  /**
   * TODAY's closed trades — the fast path.
   *
   * The backend answers this from memory (or Redis after a restart), so the
   * session the operator is actually watching appears immediately instead of
   * waiting on a sort over the whole closed book.
   */
  const loadToday = useCallback(async () => {
    try {
      const res = await fetchBoxHistory(0, "today");
      // Audit-stripped rows: never let them overwrite a fuller row already held.
      mergeHistory(res.trades, res.lite ?? true);
      setHistorySource(res.source ?? null);
      setHistoryError(null);
      return true;
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : "Failed to load today's closed trades.",
      );
      return false;
    }
  }, [mergeHistory]);

  /**
   * The FULL closed book, including earlier days. Slower by nature, so it runs
   * after (and independently of) the fast path.
   *
   * The error is surfaced rather than swallowed: this list is the trade log, and an
   * empty one that silently meant "the request failed" was indistinguishable from
   * "nothing has been closed" — which is exactly how a broken history query hid
   * itself while the day-P&L strip cheerfully reported closed trades.
   */
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      // Ask for the backend's full cap (up to 1000) rather than the first 100,
      // so the Closed tab is the whole book, not a recent slice.
      const res = await fetchBoxHistory(1000, "all");
      mergeHistory(res.trades, res.lite ?? false);
      setHistoryDbEnabled(res.dbEnabled);
      setHistoryError(null);
    } catch (err) {
      // A big book can still be too slow for whatever sits in front of the API
      // (this failed with a gateway 504 before the audit blobs were projected out
      // of the query). A SHORTER window is far better than no earlier days at all,
      // so degrade rather than give up.
      try {
        const res = await fetchBoxHistory(200, "all");
        mergeHistory(res.trades, res.lite ?? false);
        setHistoryDbEnabled(res.dbEnabled);
        setHistoryError(
          "The full closed-trade history was too slow to load, so this is the 200 most recent" +
            " closed boxes. Today is complete.",
        );
      } catch {
        // Today's rows may already be on screen from the fast path; say so rather
        // than implying the whole log is gone.
        setHistoryError(
          `${err instanceof Error ? err.message : "Failed to load the closed-trade history."}` +
            " Earlier days may be missing — today's trades are unaffected.",
        );
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [mergeHistory]);

  useEffect(() => {
    if (!canTrade) return;
    void loadStatus();
    void loadExecutionControl();
    // Two phases: today's closed trades first (memory/Redis, immediate), then the
    // full book in the background. The old single full-book fetch meant the tab
    // showed nothing until the slowest query on the page finished — or forever, if
    // it failed.
    void loadToday().then(() => loadHistory());
    // A first opportunity/open snapshot, so the page is populated before the
    // stream's first frame arrives.
    fetchBoxOpportunities()
      .then((r) => {
        setOpportunities(r.opportunities);
        applyStatus(r.status);
      })
      .catch(() => {});
  }, [canTrade, loadStatus, loadExecutionControl, loadToday, loadHistory]);

  /**
   * Whole-system readiness + async reporting-replica status, polled on a slow cadence.
   *
   * SECTION 7 — A FAILED REFRESH IS NOW VISIBLE. This used to be
   * `fetchRuntimeStatus().then(setRuntime).catch(() => {})`. When the endpoint started failing, the
   * last good snapshot stayed on screen unchanged, indistinguishable from a healthy system, for as
   * long as the failure lasted. Every outcome is now recorded, and the age/failure is published to
   * the banners so an expired or failed refresh visibly becomes STALE or UNKNOWN.
   *
   * The last successful payload is deliberately KEPT rather than cleared: its content is still the
   * most recent thing known, and blanking it would replace one lie ("this is current") with another
   * ("there is nothing"). What changes is that its true age is now stated.
   */
  useEffect(() => {
    if (!canTrade) return;
    const poll = () => {
      fetchRuntimeStatus()
        .then((r) => {
          setRuntime(r);
          setRuntimeObservedAt(Date.now());
          runtimeRefresh.current.recordSuccess(Date.now());
        })
        .catch((err: unknown) => {
          runtimeRefresh.current.recordFailure(
            err instanceof Error ? err.message : "the readiness refresh failed",
          );
        })
        .finally(() => setRuntimeFreshness(runtimeRefresh.current.state(Date.now())));
      fetchExportStatus().then(setExportStatus).catch(() => {});
    };
    poll();
    const t = window.setInterval(poll, 5000);
    /*
     * THE EXECUTION-CONTROL SURFACE IS POLLED TOO, and it was not before.
     *
     * `loadExecutionControl()` ran ONCE on mount and then only when a mutation completed. Everything
     * it feeds is therefore a one-shot read that could be arbitrarily old with no age shown anywhere:
     * CIRCUIT, ENTRY STATE, LIVE ORDERS, SESSION LIMIT, ATTEMPT BUDGET, OPEN BOXES, QUEUE,
     * `arm.preconditions.feedHealthy`, `arm.preconditions.reconciliationComplete`,
     * `risk.realised_pnl_today` and `risk.daily_loss_limit`.
     *
     * So if the backend tripped the daily-loss circuit, consumed the session budget, or demoted the
     * feed, this panel kept showing `CIRCUIT CLOSED · ARMED · 0/1 complete · FEED HEALTHY` until the
     * operator happened to press something. That is the panel a human reads IMMEDIATELY BEFORE
     * enabling real entry.
     *
     * Deliberately SLOWER than the 5s readiness poll: the endpoint is a cold read on the server (it
     * consults the reservation store and the session record), and the values it carries change on
     * operator actions and circuit trips rather than tick by tick. 10s bounds the staleness of a
     * pre-arm decision without making the surface expensive.
     */
    const control = window.setInterval(() => void loadExecutionControl(), 10_000);
    // A second, faster timer re-evaluates FRESHNESS even when no poll resolves: data goes stale by
    // the passage of time, not by an event, so nothing else would ever notice.
    const age = window.setInterval(
      () => setRuntimeFreshness(runtimeRefresh.current.state(Date.now())),
      2000,
    );
    return () => {
      window.clearInterval(t);
      window.clearInterval(age);
      window.clearInterval(control);
    };
  }, [canTrade, loadExecutionControl]);

  /*
   * SNAPSHOT AGE, ticked independently of the stream.
   *
   * This exists precisely because the failure it detects is frames STOPPING: nothing in the stream
   * path can notice its own silence, so the age has to be advanced by a clock. 1s cadence so the
   * displayed age and the derived staleness verdict move visibly rather than in coarse jumps.
   */
  useEffect(() => {
    if (!canTrade) return;
    const tick = () =>
      setSnapshotAgeMs(snapshotAt === null ? null : Math.max(0, Date.now() - snapshotAt));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [canTrade, snapshotAt]);

  // A 401 anywhere returns the whole app to the gate. The http wrapper already fires this
  // when a REST call 401s; subscribing here lets the dashboard react immediately (the SSE is
  // torn down by its own probe path).
  useEffect(() => onUnauthorized(() => setLive(false)), []);

  /* --------------------------------- stream ------------------------------- */

  useEffect(() => {
    if (!canTrade) return;

    const flush = window.setInterval(() => {
      const snap = pending.current;
      if (!snap) return;
      pending.current = null;
      applyStatus(snap.status);
      setOpportunities(snap.opportunities);
      setOpen(snap.open_trades);
      // Entry cue is driven off this live open set (first frame is baseline). Purely a
      // UX side effect — it cannot influence anything above it.
      notifyOpenSnapshot(snap.open_trades.map((t) => t.id));
    }, 400);

    // The reconnecting stream opens with withCredentials:true (cookie auth, no token in the
    // URL), reconnects after a TRANSIENT drop with capped backoff, and — crucially — does
    // NOT reconnect after a 401: it closes and notifies, which returns the app to the gate.
    const stream = new ReconnectingBoxStream({
      url: boxStreamUrl(),
      events: ["snapshot", "entry", "exit"],
      onOpen: () => setLive(true),
      onDisconnect: () => setLive(false),
      // A dead session is confirmed with a cheap authenticated probe. When the cookie is
      // gone accessStatus() answers 401 (the http wrapper also fires the global unauthorized
      // handler); here we report "unauthorized" so the stream stops instead of reconnecting.
      probeUnauthorized: async () => {
        try {
          const s = await accessStatus();
          return !s.authenticated;
        } catch {
          return true;
        }
      },
      onUnauthorized: () => setLive(false),
      onEvent: (type, data) => {
        if (type === "snapshot") {
          try {
            pending.current = JSON.parse(data) as BoxSnapshot;
            setLive(true);
            // Stamped on ARRIVAL, not on flush: the flush is a 400ms UI throttle and its timing says
            // nothing about when the backend last spoke.
            setSnapshotAt(Date.now());
          } catch {
            /* ignore a malformed frame */
          }
          return;
        }
        if (type === "entry") {
          setLive(true);
          return;
        }
        // exit: a discrete event — reflect the closed box immediately.
        try {
          const payload = JSON.parse(data) as { trade?: BoxTrade };
          if (!payload.trade) {
            void loadToday();
            return;
          }
          fullRows.current.add(payload.trade.id);
          notifyExit(payload.trade.id);
          setHistory((current) => [
            payload.trade!,
            ...current.filter((trade) => trade.id !== payload.trade!.id),
          ]);
        } catch {
          void loadToday();
        }
      },
    });
    stream.start();

    return () => {
      window.clearInterval(flush);
      stream.stop();
    };
    // notifyOpenSnapshot / notifyExit are stable (empty-dep callbacks), so listing them
    // cannot cause the stream to re-open.
  }, [canTrade, loadToday, notifyOpenSnapshot, notifyExit]);

  /* --------------------------------- chain -------------------------------- */

  // The expanded underlying's chain is polled on its own slow cadence; it is a
  // visualization, not part of any decision.
  useEffect(() => {
    if (!expanded) {
      setChain(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      fetchBoxChain(expanded)
        .then((c) => {
          if (!cancelled) setChain(c);
        })
        .catch((err) => {
          if (!cancelled) {
            setChain(null);
            setError(err instanceof Error ? err.message : "Failed to load the chain.");
          }
        });
    };
    load();
    const t = window.setInterval(load, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [expanded]);

  /* -------------------------------- actions ------------------------------- */

  async function toggleScanner() {
    // SECTION 7 — SINGLE-FLIGHT. The old guard was `setBusy(true)` plus `disabled={busy}`, which
    // reads `busy` from the render closure: two clicks in the same frame BOTH saw `false` and BOTH
    // fired. `runOnce` claims the slot synchronously, so the second click is refused here, before
    // the network. The backend remains the authority on whether the action is ALLOWED — this only
    // stops the same authorised action being submitted twice.
    const wasRunning = running;
    const outcome = await runOnce(controls.current, "scanner", async () => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const next = wasRunning ? await stopBoxScanner() : await startBoxScanner();
        applyStatus(next);
        if (wasRunning) {
          // SCANNER STOP must say, unambiguously and SEPARATELY, what happens to entry and what
          // happens to positions already open. Merging them into one sentence is how "stopped
          // scanning" gets read as "stopped watching my open box".
          const stop = explainScannerStop(next.monitoring, next.operational_readiness);
          setNotice(`${stop.headline} ${stop.entryEffect} ${stop.positionsEffect}`);
        } else {
          const label = modeLabel(next.execution_mode);
          setNotice(
            label.live
              ? "Scanner running. Qualifying boxes will be entered with REAL orders automatically — " +
                "no fill, four-leg completion or maximum loss is guaranteed."
              : `Scanner running. Qualifying boxes will be opened in the ${label.badge} simulation ` +
                `automatically. No order reaches any broker.`,
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to change the scanner state.");
      } finally {
        setBusy(false);
      }
    });
    if (!outcome.sent) setNotice(outcome.reason);
  }

  async function handleStrikeLevel(level: 1 | 2 | 3) {
    if (status?.strike_level === level) return;
    const outcome = await runOnce(controls.current, "scanner", async () => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const next = await setBoxStrikeLevel(level);
        applyStatus(next);
        setNotice(
          `Now monitoring ATM ±${level}. New boxes are limited to this window — positions already open are unaffected and keep being monitored.`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to set the strike level.");
      } finally {
        setBusy(false);
      }
    }, `strike-${level}`);
    if (!outcome.sent) setNotice(outcome.reason);
  }

  async function handleClose(id: string) {
    // A React-state `closingId` alone cannot block two clicks in the same frame.
    // Claim the per-trade synchronous slot before the request so a live close is
    // never double-submitted by this browser.
    const outcome = await runOnce(controls.current, "trade", async () => {
      setClosingId(id);
      setError(null);
      setNotice(null);
      try {
        setOpen(await closeBoxTrade(id));
        setNotice("Box closed at the executable touch.");
        // A manual close lands in today, so the cheap fast path is enough.
        void loadToday();
      } catch (err) {
        // A refusal (no one-lot market) is the expected, meaningful case here.
        setError(err instanceof Error ? err.message : "Failed to close the box.");
      } finally {
        setClosingId(null);
      }
    }, id);
    if (!outcome.sent) setNotice(outcome.reason);
  }

  /**
   * Delete a PAPER trade and apply the backend's corrected state immediately.
   *
   * The response already carries the recomputed status, open positions and
   * closed-today list, so nothing here re-derives a number locally — subtracting
   * fields in the browser is exactly how a UI ends up disagreeing with the server.
   * The card disappears and every figure updates without a reload.
   */
  async function handleDelete(id: string, reason: string) {
    setDeletingId(id);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteBoxTrade(id, reason);
      applyStatus(result.status);
      setOpen(result.open ?? []);
      // Drop it from whichever list is on screen, then adopt the server's corrected
      // closed-today rows so the Closed tab and its totals agree with the backend.
      setHistory((prev) => {
        const corrected = result.closed_today?.trades ?? [];
        const correctedIds = new Set(corrected.map((t) => t.id));
        const older = prev.filter((t) => t.id !== id && !correctedIds.has(t.id));
        return [...corrected, ...older];
      });
      setDeleteTarget(null);
      setNotice("Trade deleted. Counts, P&L and margin have been recalculated.");
    } catch (err) {
      // A 409 refusal (live trade / mid-exit) is the meaningful case: surface it as-is.
      setError(err instanceof Error ? err.message : "Failed to delete the trade.");
    } finally {
      setDeletingId(null);
    }
  }

  const cfg = status?.config;
  const freshLimit = cfg?.quote_max_age_ms ?? 1500;
  /**
   * The ACTIVE strikes-each-side level the backend is monitoring on.
   *
   * `status.strike_level` (the live control) is authoritative; `config.strike_level`
   * is the same number and is the fallback. NOT `config.strikes_each_side`, which
   * is the immutable ATM ±3 CAP — reading that is what made the status strip claim
   * ±3 no matter which level was selected.
   */
  const strikeLevel = status?.strike_level ?? cfg?.strike_level ?? 3;
  /**
   * The blocklisted underlyings, as a Set for O(1) lookup per opportunity row.
   *
   * Memoised on the array identity rather than rebuilt per render: this table can hold 60 rows and
   * the page re-renders several times a second off the SSE snapshot.
   */
  const excludedSymbols = useMemo(
    () => new Set((status?.excluded_underlyings.excluded ?? []).map((e) => e.symbol)),
    [status?.excluded_underlyings.excluded],
  );
  /** Strike PAIRS in the active window: C(n,2) for n = 2·level+1 strikes. */
  const strikePairs =
    cfg?.max_candidates_per_underlying ??
    ((strikeLevel * 2 + 1) * (strikeLevel * 2)) / 2;
  /**
   * Whether the backend will build a last-close view with the scanner stopped.
   *
   * Needs the feature switched on AND a Zerodha session, since the closes are
   * fetched over REST. Without both, promising "building the last-close view…" would
   * be a spinner for work that is never going to happen — so the plain
   * "press RUN" message is the honest one.
   */
  const closedViewExpected = (cfg?.indicative_discovery ?? false) && authenticated;
  /*
   * The backend is the authority on market hours, so with NO status we must not claim it is open.
   *
   * The old code was `status ? status.market_open : true` — with a comment saying it defaulted to
   * "open" only once a status existed, which is the opposite of what the expression did. While
   * `status === null` the page suppressed the "Market closed — these are last-traded prices, not
   * executable" banner, rendered `Prices: Executable touch`, and showed the exchange lag as live. And
   * `loadStatus` sets `error` but LEAVES `status` null on failure, so a backend that cannot serve
   * /api/box/status made the page assert executable prices PERMANENTLY, with a red error banner
   * directly above the claim.
   *
   * `false` is the safe default: it shows the market-closed banner and labels prices as last-close,
   * which is the correct reading of "we do not know".
   */
  const marketOpen = status ? status.market_open : false;

  /*
   * IS THE PRICE SURFACE ON SCREEN ACTUALLY CURRENT?
   *
   * `live` alone cannot answer this — it only reports whether the EventSource is open, and a wedged
   * backend holds the socket open while sending nothing (see `snapshotAt`). So the verdict combines
   * both: the socket must be up AND a snapshot must have arrived recently.
   *
   * The budget is deliberately generous relative to the backend's ~2/s publish rate. It is not trying
   * to catch a dropped frame; it is trying to catch a stream that has STOPPED, and a threshold tight
   * enough to flicker on a slow render would be ignored within a day.
   */
  const SNAPSHOT_STALE_MS = 6_000;
  const snapshotStale = snapshotAgeMs !== null && snapshotAgeMs > SNAPSHOT_STALE_MS;
  /**
   * True only when the rendered prices can be trusted as CURRENT.
   *
   * `snapshotAt === null` (no frame has ever arrived) counts as NOT trustworthy — "never received"
   * and "received and fine" must not collapse into the same state, which is the same distinction
   * `RefreshTracker` draws between `unknown` and `fresh`.
   */
  const snapshotTrusted = live && snapshotAt !== null && !snapshotStale;
  /** Human age of the last snapshot, for the banner and the status strip. */
  const snapshotAgeLabel =
    snapshotAgeMs === null
      ? "never"
      : snapshotAgeMs < 1000
        ? `${snapshotAgeMs}ms ago`
        : `${(snapshotAgeMs / 1000).toFixed(snapshotAgeMs < 60_000 ? 1 : 0)}s ago`;

  const eligibleCount = useMemo(
    () => opportunities.filter((o) => o.status === "ELIGIBLE").length,
    [opportunities],
  );
  // Surfaced on the Open tab so a position that needs attention is visible even
  // while you are looking at the scanner.
  const exitEligibleCount = useMemo(() => open.filter((p) => p.exit_eligible).length, [open]);
  const blockedCount = useMemo(
    () => open.filter((p) => p.exit_blocked_reason !== null).length,
    [open],
  );
  /*
   * CLOSED-BOOK TOTALS, WITH THE UNPRICED ROWS COUNTED SEPARATELY.
   *
   * THE DEFECT. These were plain `acc + (t.net_pnl ?? 0)` reductions. `net_pnl`, `gross_pnl` and
   * `total_charges` are all `number | null` on the wire, and a trade whose charges could not be priced
   * rendered `Total fees -` in its OWN row while contributing ₹0 of fees and ₹0 of net to the summary.
   * Net is a sum of `net_pnl` rather than `gross − fees`, so the strip could read
   * `Gross ₹4,200 · Fees ₹0 · Net ₹0` — internally inconsistent AND profit-flattering, which is the
   * dangerous direction. It also made a systematically broken charge pricer invisible: every trade
   * silently free.
   *
   * `margin` already did this correctly, disclosing `Margin ₹x (3 n/a)`; charges and P&L simply never
   * got the same treatment. So the fix is to follow the convention that was already here — sum only
   * the priced rows, and COUNT the unpriced ones so the total can say what it excluded.
   */
  const closedTotals = useMemo(() => {
    const sumKnown = (pick: (t: (typeof history)[number]) => number | null | undefined) => {
      let total = 0;
      let unknown = 0;
      for (const t of history) {
        const v = pick(t);
        if (typeof v === "number" && Number.isFinite(v)) total += v;
        else unknown++;
      }
      return { total, unknown };
    };
    return {
      net: sumKnown((t) => t.net_pnl),
      fees: sumKnown((t) => t.total_charges),
      gross: sumKnown((t) => t.gross_pnl),
      /** Total basket margin every listed closed box blocked (a sum, not a peak). */
      margin: sumKnown((t) => t.margin),
    };
  }, [history]);
  const closedNet = closedTotals.net.total;
  const closedFees = closedTotals.fees.total;
  const closedGross = closedTotals.gross.total;
  const closedMargin = closedTotals.margin.total;
  /**
   * What the backend's day summary says was closed today.
   *
   * Used to catch the exact disagreement that hid the broken history query: the
   * strip reporting "Closed today (164)" while the list rendered "No closed paper
   * boxes yet". If these two ever disagree again, the empty state says so out loud
   * instead of implying nothing was traded.
   */
  const dayPnlClosedCount = status?.day_pnl?.closed_count ?? 0;
  const todayKey = istTodayKey();
  // `<details>` has no React "defaultOpen", and an uncontrolled `open` would be
  // reset by the frequent snapshot re-renders on this page. So the open state is
  // tracked here: today is expanded until the user explicitly toggles a day.
  const [dayOverrides, setDayOverrides] = useState<Record<string, boolean>>({});
  const isDayOpen = useCallback(
    (key: string) => dayOverrides[key] ?? key === todayKey,
    [dayOverrides, todayKey],
  );
  const setDayOpen = useCallback((key: string, next: boolean) => {
    setDayOverrides((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
  }, []);
  /**
   * How many closed trades each broker contributed.
   *
   * Drives whether the broker filter is worth showing at all: on a Zerodha-only
   * deployment offering a Dhan filter would imply Dhan trades exist somewhere.
   * Rows with no `broker` are Zerodha, matching the backend's legacy default.
   */
  const brokerCounts = useMemo(() => {
    let zerodha = 0;
    let dhan = 0;
    for (const t of history) {
      if (t.broker === "dhan") dhan++;
      else zerodha++;
    }
    return { all: history.length, zerodha, dhan };
  }, [history]);

  /** Closed trades after the broker filter. */
  const visibleHistory = useMemo(
    () =>
      brokerFilter === "all"
        ? history
        : history.filter((t) => (t.broker ?? "zerodha") === brokerFilter),
    [history, brokerFilter],
  );

  const historyDays = useMemo(() => {
    const groups = new Map<string, BoxTrade[]>();
    for (const trade of visibleHistory) {
      const key = istDayKey(trade.closed_at ?? trade.opened_at);
      const group = groups.get(key);
      if (group) group.push(trade);
      else groups.set(key, [trade]);
    }
    return [...groups]
      .sort(([a], [b]) => {
        if (a === "unknown") return 1;
        if (b === "unknown") return -1;
        return b.localeCompare(a);
      })
      .map(([key, trades]) => {
      /*
       * Same rule as the book-wide totals: sum only the rows that carry a real number and COUNT the
       * rest. `?? 0` treated an unpriced trade as free, so a day could report `Gross ₹4,200 ·
       * Fees ₹0 · Net ₹0` — flattering and internally inconsistent, since net is a sum of `net_pnl`
       * rather than `gross − fees`.
       */
      const sumKnown = (pick: (t: (typeof trades)[number]) => number | null | undefined) => {
        let total = 0;
        let unknown = 0;
        for (const t of trades) {
          const v = pick(t);
          if (typeof v === "number" && Number.isFinite(v)) total += v;
          else unknown++;
        }
        return { total, unknown };
      };
      const gross = sumKnown((t) => t.gross_pnl);
      const fees = sumKnown((t) => t.total_charges);
      const net = sumKnown((t) => t.net_pnl);
      /**
       * Total basket margin these boxes blocked, and how many are missing a
       * figure. Summed over the day, so it is an upper bound on what was blocked
       * at any single instant rather than a peak: boxes that opened and closed at
       * different times never held their margin simultaneously.
       */
      const margin = sumKnown((t) => t.margin);
      return {
        key,
        label: istDayLabel(key),
        trades,
        gross: gross.total,
        grossUnknown: gross.unknown,
        fees: fees.total,
        feesUnknown: fees.unknown,
        net: net.total,
        netUnknown: net.unknown,
        margin: margin.total,
        marginUnknown: margin.unknown,
      };
    });
  }, [visibleHistory]);

  /* --------------------------------- render ------------------------------- */

  return (
    <div className="gts-workspace">
      {/* The top bar. Identity, backend-derived state, session utilities and the one command
          control, in that order. Every value it renders is passed in from here — it derives no
          readiness, no mode and no tradability of its own. */}
      <BoxHeader
        status={status}
        cfg={cfg}
        headerMode={headerMode}
        running={running}
        live={live}
        marketOpen={marketOpen}
        busy={busy}
        canTrade={canTrade}
        soundEnabled={soundEnabled}
        onToggleSound={toggleSound}
        onTestSound={testSound}
        // ASYMMETRIC ON PURPOSE. Starting asks first, because the set of underlyings it will act on
        // is now a ~200-part decision that is otherwise only visible in another tab. STOPPING stays
        // instant: friction in front of the control that reduces activity is friction in the wrong
        // place.
        onToggleScanner={() => (running ? void toggleScanner() : setConfirmRun(true))}
        onStrikeLevel={(level) => void handleStrikeLevel(level)}
        onLock={onLock}
      />

      {/* Broker status for BOTH stored sessions — active + standby — with guarded
          selection and switch-blocker display. */}
      <BrokerStatusPanel runtime={runtime} />

      {/* Plain-language whole-system readiness, without exposing any secret.

          `readiness` is what lets these banners say anything about EXITING. Without it every such
          statement degrades to UNKNOWN by design, and a MID-SESSION PostgreSQL failure would be
          invisible here — `runtime.pg_ready` is only a startup latch. */}
      <RuntimeStatusBanners
        runtime={runtime}
        exportStatus={exportStatus}
        refresh={runtimeFreshness}
        readiness={status?.operational_readiness ?? null}
        observedAt={{ runtime: runtimeObservedAt, readiness: readinessObservedAt }}
      />

      {error && <div className="banner banner--error">{error}</div>}
      {notice && !error && <div className="banner banner--info">{notice}</div>}
      {status && !status.db_enabled && (
        <div className="banner banner--warn">
          Box persistence is not available on the server, so no paper box can be recorded.
          PostgreSQL is the authoritative operational store — until it is reachable, trades
          cannot be persisted.
        </div>
      )}
      {status && status.last_error && (
        <div className="banner banner--warn">{status.last_error}</div>
      )}
      {/* The single most important thing to say when the exchange is shut: these
          are yesterday's numbers and nothing can be entered from them. */}
      {/* A dead feed is the case freshness actually guards against: every cached
          book still looks normal while being of unknown age. */}
      {status && marketOpen && running && !status.feed_healthy && (
        <div className="banner banner--error">
          <strong>Tick feed is down.</strong> No tick has arrived across the whole universe for{" "}
          {status.feed_age_ms === null
            ? "some time"
            : `${(status.feed_age_ms / 1000).toFixed(1)}s`}
          , so every cached order book is of unknown age. Entries and automatic exits are paused
          until it recovers — open positions stay open and are not closed on unverifiable prices.
        </div>
      )}
      {/*
        THE BACKEND HAS STOPPED TALKING TO THIS PAGE.
        Reported SEPARATELY from "tick feed is down", because that banner is driven by
        `status.feed_healthy` — a value the BACKEND computes and pushes. A backend-computed field
        cannot tell you the backend stopped pushing, so a wedged event loop or a proxy holding the
        stream open showed every indicator green while the whole price surface was frozen.
        Placed above the market-closed banner: if what is on screen is not current, that fact
        outranks anything the stale snapshot happens to say.
      */}
      {snapshotStale && (
        <div className="banner banner--error">
          <strong>These prices are not live.</strong> The last update from the server arrived{" "}
          <strong>{snapshotAgeLabel}</strong>
          {live
            ? " — the connection is still open but no data is coming through it"
            : " and the connection has dropped"}
          . Everything below is a frozen snapshot of that moment, including every order book, age and
          edge. <strong>Arming live entry is disabled</strong> until data resumes, because creating new
          exposure from a stale price is how a phantom edge becomes a real loss.{" "}
          <strong>Exiting is deliberately still allowed</strong> — getting out of a position you
          already hold must never be blocked by a stale screen, and the server re-checks the real book
          before it sends anything. Open positions also continue to be managed by the server
          independently of this page.
        </div>
      )}
      {snapshotAt === null && live && (
        <div className="banner banner--warn">
          <strong>Waiting for the first update.</strong> The connection is open but no snapshot has
          arrived yet, so nothing below is priced. This is normal for a second or two after opening
          the page.
        </div>
      )}
      {status && !marketOpen && (        <div className="banner banner--warn">
          <strong>Market closed.</strong> The prices below are the{" "}
          <strong>last traded</strong> prices from the{" "}
          {status.indicative_session_day ?? "latest"} session, shown so you can see which boxes were
          mispriced at the close. They are not executable, so nothing will be entered and no open
          position will be auto-exited until the market reopens. Only strikes that actually traded in
          that session are used, and a box whose four closes do not form a coherent spread is left
          out rather than shown with an impossible edge
          {status.indicative_stale_legs > 0
            ? ` (${status.indicative_stale_legs} leg(s) skipped as stale)`
            : ""}
          .
          {status.indicative_at
            ? ` Refreshed ${fmtDateTime(new Date(status.indicative_at).toISOString())}.`
            : ""}
        </div>
      )}

      {/* ------------------------------ status strip ----------------------- */}
      <section className="box-strip">
        {/* BROKER first: which venue owns the feed, the scanner and execution is the
            single most important thing about everything else on this page. */}
        <div className="box-stat">
          <span className="box-stat-k">Broker</span>
          <span className="box-stat-v">
            <BrokerBadge broker={status?.broker} />
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Status</span>
          <span className="box-stat-v">{status?.state ?? "…"}</span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Entry gate</span>
          <span
            className="box-stat-v"
            title="A box is entered only when its EXPECTED NET profit — gross minus entry fees, estimated exit fees, simulated execution/slippage cost and the safety buffer — clears this, measured on the executed snapshot"
          >
            {rupees(cfg?.min_expected_net_profit ?? null)} expected net
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Execution</span>
          <span
            className="box-stat-v"
            title={
              cfg?.execution_mode === "paper_latency"
                ? `paper_latency: fills from the first WebSocket book at/after a simulated ${cfg?.simulated_latency_ms ?? 0}ms latency`
                : "paper_touch: fills at the detected touch"
            }
          >
            {cfg?.execution_mode ?? "…"}
          </span>
        </div>
        {cfg && (cfg.directions?.length ?? 0) > 1 && (
          <div className="box-stat">
            <span className="box-stat-k">Directions</span>
            <span className="box-stat-v">long + short</span>
          </div>
        )}
        <div className="box-stat">
          <span className="box-stat-k">Safety buffer</span>
          {/* It IS part of the gate: the backend deducts it inside the expected-net
              figure the gate tests against, so raising it makes entry strictly
              harder. The old tooltip said the opposite. */}
          <span
            className="box-stat-v"
            title="Deducted inside the expected-net figure the entry gate tests, so it is part of the entry decision — not just a reported number"
          >
            {rupees(cfg?.safety_buffer ?? null)}
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Universe</span>
          <span className="box-stat-v">F&amp;O stocks + indices</span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Prices</span>
          <span className="box-stat-v">{marketOpen ? "Executable touch" : "Last close"}</span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Strikes</span>
          {/* The ACTIVE level, not the cap. This used to render
              `strikes_each_side` — the immutable ATM ±3 ceiling — so it read ±3
              however narrow a window the admin had actually selected. */}
          <span
            className="box-stat-v"
            title={`Monitoring ${strikeLevel * 2 + 1} strikes (ATM ±${strikeLevel}), up to ${strikePairs} strike pairs per underlying. Maximum ±${cfg?.strikes_each_side ?? 3}.`}
          >
            ATM ±{strikeLevel}
            {cfg && strikeLevel < cfg.strikes_each_side && (
              <span className="box-dim"> of ±{cfg.strikes_each_side}</span>
            )}
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Mode</span>
          <span className="box-stat-v">
            {(status?.execution_mode ?? "—").replace(/_/g, " ").toUpperCase()}
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Lot</span>
          <span className="box-stat-v">1</span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Book trusted for</span>
          <span
            className="box-stat-v"
            title="How long an UNCHANGED order book is still accepted. A depth feed only sends a message when the book changes, so silence on a quiet strike is not staleness."
          >
            {(freshLimit / 1000).toFixed(0)}s
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Feed</span>
          <span
            className={`box-stat-v ${(status && !status.feed_healthy && marketOpen) || snapshotStale ? "pnl-neg" : ""}`}
            title={
              snapshotStale
                ? `This cell is computed by the SERVER and shipped inside a snapshot, so it cannot report that the server stopped sending. The last snapshot arrived ${snapshotAgeLabel}, so the value below is frozen and the real feed state is unknown.`
                : "Heartbeat: how long since ANY instrument last ticked. Not a delay from NSE — if it goes quiet the connection is down and trading pauses."
            }
          >
            {/*
              SNAPSHOT STALENESS OUTRANKS `status.feed_healthy`, and must.
              `feed_healthy` and `feed_age_ms` are BACKEND-COMPUTED and arrive inside the snapshot, so
              a wedged backend freezes them at their last healthy values and this cell renders
              `live (243ms)` indefinitely. A field pushed by the server can never report that the
              server stopped pushing, so the client-measured snapshot age has to be checked first.
            */}
            {snapshotStale
              ? `NO DATA (${snapshotAgeLabel})`
              : !snapshotTrusted
                ? "connecting…"
                : !status
                  ? "-"
                  : !marketOpen
                    ? "idle"
                    : status.feed_healthy
                      ? `live ${status.feed_age_ms === null ? "" : `(${status.feed_age_ms}ms)`}`
                      : "DOWN"}
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Exchange lag ≈</span>
          <span
            className="box-stat-v"
            title="Approximate staleness of the data versus NSE, from the broker feed's exchange_timestamp (1-second resolution, and sensitive to server-clock skew — so this is a rough figure, not a precise latency)."
          >
            {/* Only meaningful on a live feed: with the market shut the last
                sample is hours old, so the figure is stale, not a real lag. */}
            {!marketOpen || !status?.exchange_lag_ms
              ? "—"
              : `${(status.exchange_lag_ms.median_ms / 1000).toFixed(1)}s (p95 ${(status.exchange_lag_ms.p95_ms / 1000).toFixed(1)}s)`}
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Watching</span>
          <span className="box-stat-v">
            {status?.underlyings ?? 0} underlyings, {status?.candidates ?? 0} boxes
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Monitoring</span>
          <span className="box-stat-v">
            {status?.open_positions ?? 0} open
            {status?.monitor.running ? "" : " (monitor idle)"}
          </span>
        </div>
      </section>

      {/* ── CONTROLS: one framed surface for everything that changes what the engine does ──
          Execution, session, universe and risk/thresholds were four sibling sections stacked down
          the page with banners interleaved between them. They are the same four components, with
          the same props and the same single-flight guards; ControlBox only re-parents them behind a
          tab strip and keeps mode / entry / session armed state visible on every tab, so "are these
          real orders, and is it armed?" can never be hidden behind a tab. */}
      <ControlBox
        control={executionControl}
        cfg={cfg}
        status={status}
        blocklist={status?.excluded_underlyings}
        canTrade={canTrade}
        isFullAdmin={isFullAdmin}
        executionError={executionError}
        pricesStale={snapshotStale}
        onControlChanged={() => {
          void loadExecutionControl();
          void loadStatus();
        }}
        onSettingsSaved={(next) => {
          applyStatus(next.status);
          setNotice(null);
        }}
        onBlocklistChanged={() => {
          // The write already returned the authoritative list, but re-read the status so every other
          // surface that renders exclusions (the opportunity rows' EXCLUDED badge, the readiness
          // blockers) moves in the same tick rather than lagging until the next SSE snapshot.
          void loadStatus();
        }}
      />

      {status && status.skipped_for_budget > 0 && (
        <div className="banner banner--warn">
          {status.skipped_for_budget} underlying(s) are outside the live-feed token budget
          ({cfg?.max_subscribed_tokens} instruments) and are not being scanned
          {status.skipped_symbols.length > 0 ? `: ${status.skipped_symbols.join(", ")}…` : "."}
        </div>
      )}
      {/* A THIRD limit, and it used to be reported as the token budget above — which announced that
          214 underlyings were outside a 2200-instrument feed budget while that budget had hundreds of
          tokens spare, and never named BOX_MAX_UNDERLYINGS, the setting actually responsible. Naming
          the value is the point: "not being scanned" is a symptom, "the cap is 1" is the cause. */}
      {status && status.skipped_for_underlying_cap > 0 && (
        <div className="banner banner--warn">
          {status.skipped_for_underlying_cap} underlying(s) are not being scanned because{" "}
          <strong>BOX_MAX_UNDERLYINGS is {status.max_underlyings}</strong>, which caps the universe to
          the first {status.max_underlyings} name(s) in board order — indices first, then alphabetical.
          This is <strong>not</strong> the token budget, which is unaffected. Set it to 0 for no cap
          {status.skipped_underlying_cap_symbols.length > 0
            ? `. Skipped: ${status.skipped_underlying_cap_symbols.join(", ")}…`
            : "."}
        </div>
      )}
      {/* A DIFFERENT limit, and it used to be reported as the one above — which
          blamed the live-feed token budget while the market was shut and nothing
          was streaming at all. This one only trims the read-only preview. */}
      {status && (status.skipped_indicative_cap ?? 0) > 0 && (
        <div className="banner banner--info">
          Last-close preview is limited to the {status.indicative_max_underlyings ?? 150} most
          liquid underlyings, so {status.skipped_indicative_cap} more are not priced in this view.
          Nothing is being traded either way while the market is shut, and pressing{" "}
          <strong>RUN</strong> scans on the live-feed budget instead
          {status.skipped_indicative_symbols && status.skipped_indicative_symbols.length > 0
            ? `. Not previewed: ${status.skipped_indicative_symbols.join(", ")}…`
            : "."}
        </div>
      )}

      {/* One view at a time. The scanner, open book and history are three
          different jobs, and stacking them made the page a scroll-fest — but the
          counts stay on the tabs so nothing important is hidden behind a click. */}
      {/* Free capital rides in the neutral money strip beside the margin tiles. It is published
          continuously by the backend (its own timer, every mode with a session), unlike the
          `available_funds` figure inside `economic_admission`, which only exists as a by-product of a
          live entry attempt and is therefore absent exactly when an operator is deciding to arm. */}
      <BoxDayPnlStrip dayPnl={status?.day_pnl} funds={status?.account_funds} />

      <BoxExecutionHealth
        metrics={status?.metrics}
        mode={status?.execution_mode ?? "paper_latency"}
      />

      {/* The full operational picture for the ACTIVE broker: market-data state + generation and
          per-instrument readiness, the SEPARATE order-update fill path, entry-blocking reasons,
          economic admission (gross notional vs margin), and the denominator-carrying funnel. The
          two health signals are rendered independently — a live quote socket is not evidence that
          fills are observed. */}
      {/* READINESS THAT CANNOT BE ORDERED IS NOT READINESS.
          When a payload carries no backend instance identity, no durable boot ordinal, or two
          backends claim the same epoch, we cannot tell the current verdict from a superseded one — so
          the operator is told, and new entry is presented as disabled. This is deliberately NOT shown
          for a merely out-of-order response: that is normal, and what is on screen is still the newest
          thing we have seen. The backend independently refuses entry in this state too (blocker code
          instance_epoch_unknown), so this banner explains a refusal rather than being the only guard. */}
      {readinessIncompatible !== null && (
        <div className="banner banner--warn" role="status">
          <strong>Readiness cannot be ordered — new entry is disabled.</strong>{" "}
          {readinessIncompatible}
        </div>
      )}

      <BoxOperationalState status={status} />

      {/* Directly below execution health, because "how fast do fills complete" is meaningless
          without knowing HOW a fill is even observed. Separate panel, separate signal. */}
      <BoxOrderStreamStatus orderStream={status?.order_stream} />

      {/* The three jobs, as a real underlined tab strip rather than three pill buttons. Counts
          and attention markers stay ON the tabs, so a position that needs a look is visible
          from whichever tab is open. */}
      <nav className="box-views" role="tablist" aria-label="Box view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "opportunities"}
          className="box-view-tab"
          onClick={() => setView("opportunities")}
        >
          <span className="box-view-tab-label">Opportunities</span>
          <span className="pill-count">{opportunities.length}</span>
          {eligibleCount > 0 && (
            <span className="box-badge box-badge--eligible" title={`${eligibleCount} eligible`}>
              {eligibleCount}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "open"}
          className="box-view-tab"
          onClick={() => setView("open")}
        >
          <span className="box-view-tab-label">Positions</span>
          <span className="pill-count">{open.length}</span>
          {/* Attention markers, so a position needing a look is visible from any tab. */}
          {exitEligibleCount > 0 && (
            <span
              className="box-badge box-badge--exit"
              title={`${exitEligibleCount} position(s) eligible for auto exit`}
            >
              {exitEligibleCount}
            </span>
          )}
          {blockedCount > 0 && (
            <span
              className="box-badge box-badge--warn"
              title={`${blockedCount} position(s) with a blocked exit`}
            >
              {blockedCount}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "history"}
          className="box-view-tab"
          onClick={() => {
            setView("history");
            // Today first (instant), then reconcile the full book behind it.
            void loadToday().then(() => loadHistory());
            /*
             * A FAILED FETCH MUST NOT READ AS "NOTHING WENT WRONG".
             *
             * This was `.catch(() => {})`. On failure `attempts` stays `[]` and the panel renders
             * "No aborted legging executions recorded" — a FALSE NEGATIVE on the one surface that
             * reports money lost to partial fills that had to be unwound. `loadHistory` was
             * explicitly hardened against exactly this bug class (it even cross-checks the day
             * summary against an empty list); the attempts fetch never got the same treatment.
             */
            void fetchBoxExecutionAttempts(100)
              .then((rows) => {
                setAttempts(rows);
                setAttemptsError(null);
              })
              .catch((err: unknown) => {
                setAttemptsError(
                  err instanceof Error
                    ? err.message
                    : "The aborted-execution log could not be loaded.",
                );
              });
          }}
        >
          <span className="box-view-tab-label">History</span>
          <span className="pill-count">{history.length}</span>
        </button>
        {view === "history" && history.length > 0 && (
          <span className="box-views-total">
            <span
              className="box-dim"
              title="Total basket margin every listed box blocked, summed. Not a peak: boxes closed at different times did not hold their margin at the same moment."
            >
              Margin {rupees(closedMargin)}
              {closedTotals.margin.unknown > 0 ? ` (${closedTotals.margin.unknown} n/a)` : ""}
            </span>
            {"  ·  "}
            <span className="box-dim">
              Gross {rupees(closedGross)}
              {closedTotals.gross.unknown > 0 ? ` (${closedTotals.gross.unknown} n/a)` : ""}
            </span>
            {"  −  "}
            {/*
              THE UNPRICED COUNT IS NOT COSMETIC. These totals sum only the rows that carry a real
              number, so without stating how many were excluded, a systematically broken charge pricer
              reads as "every trade was free" — and `Gross X · Fees ₹0 · Net ₹0` looks like an
              arithmetic bug in the page rather than missing data from the server.
            */}
            <span className="box-dim">
              Fees {rupees(closedFees)}
              {closedTotals.fees.unknown > 0 ? ` (${closedTotals.fees.unknown} unpriced)` : ""}
            </span>
            {"  =  "}
            <span className={pnlClass(closedNet)}>
              Net {rupees(closedNet)}
              {closedTotals.net.unknown > 0 ? ` (${closedTotals.net.unknown} n/a)` : ""}
            </span>
            {(closedTotals.fees.unknown > 0 || closedTotals.net.unknown > 0) && (
              <span
                className="box-dim"
                title="These totals sum only the boxes that carry a priced figure. Boxes whose charges or P&L the server could not compute are excluded rather than counted as zero, because counting them as zero would overstate profit."
              >
                {"  ·  "}excludes unpriced boxes
              </span>
            )}
          </span>
        )}
      </nav>

      {/* ------------------------------ opportunities ---------------------- */}
      {view === "opportunities" && (
      <section className="box-section">
        {!running && opportunities.length === 0 && !marketOpen && closedViewExpected ? (
          /* Market shut AND stopped, and the backend does build the last-close view
             without RUN. Only claim a pass is coming when that is actually true —
             gated on `indicative_discovery`, on Zerodha being connected, and on
             whether a pass has already completed, so this never spins forever
             asserting work that will not happen. */
          <p className="box-empty">
            {status?.indicative_at ? null : <span className="spinner" />}
            {status?.indicative_at
              ? `The last session's closes were checked ${fmtDateTime(new Date(status.indicative_at).toISOString())} and no box in the ATM ±${strikeLevel} window had a coherent, mispriced close. Nothing is executable while the market is shut.`
              : `Building the last-close view of the ATM ±${strikeLevel} window… This is a read-only look at how boxes were priced at the close; nothing can be entered while the market is shut.`}
          </p>
        ) : !running && opportunities.length === 0 ? (
          <p className="box-empty">
            The scanner is stopped. Press <strong>RUN</strong> to start scanning F&amp;O stock and
            index options — only the ATM ±{strikeLevel} window of each underlying is monitored, so at
            most {strikePairs} strike pairs per symbol.
          </p>
        ) : opportunities.length === 0 ? (
          <p className="box-empty">
            <span className="spinner" />
            {marketOpen
              ? `Scanning for a box with at least ${rupees(cfg?.min_gross_edge ?? 1200)} of spread…`
              : "Loading last-close prices…"}
          </p>
        ) : (
          <div className="box-table-wrap">
            <table className="box-table">
              <thead>
                {/* COLUMN ORDER IS THE DECISION ORDER.
                    Expected NET comes third — right after what and which way — because it is
                    the figure the entry gate actually tests. The four components it is derived
                    from (gross edge, entry fees, estimated exit fees, execution cost) and the
                    safety buffer deducted inside it follow immediately, grouped, so the net is
                    prioritised WITHOUT hiding its derivation. Structure (strikes, width, box
                    value, expiry) and executability (broker, liquidity, freshness, status) come
                    after. No figure was removed. */}
                <tr>
                  <th scope="col">Underlying</th>
                  <th scope="col">Direction</th>
                  <th scope="col" className="num box-col--lead">
                    Net edge
                  </th>
                  <th scope="col" className="num box-col--group">
                    Gross edge
                  </th>
                  <th scope="col" className="num">
                    Entry fees
                  </th>
                  <th scope="col" className="num">
                    Est. exit fees
                  </th>
                  <th scope="col" className="num">
                    Exec. cost
                  </th>
                  <th scope="col" className="num">
                    Safety
                  </th>
                  <th scope="col" className="num box-col--group">
                    K1
                  </th>
                  <th scope="col" className="num">
                    K2
                  </th>
                  <th scope="col" className="num">
                    Width
                  </th>
                  <th scope="col" className="num">
                    {marketOpen ? "Box value" : "Close cost"}
                  </th>
                  <th scope="col">Expiry</th>
                  <th scope="col" className="box-col--group">
                    Broker
                  </th>
                  <th scope="col">Liquidity</th>
                  <th scope="col">Book</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {opportunities.map((o) => {
                  const isOpen = o.status === "OPEN" || o.status === "PAPER_OPENED";
                  return (
                    <tr
                      key={o.key}
                      className={
                        o.status === "ELIGIBLE"
                          ? "box-row--eligible"
                          : isOpen
                            ? "box-row--open"
                            : undefined
                      }
                    >
                      <td>
                        <span className="box-sym">{o.underlying}</span>
                        {o.is_index && <span className="badge-index">INDEX</span>}
                      </td>
                      <td><DirectionBadge direction={o.direction} /></td>
                      <td
                        className={`num box-net box-col--lead ${pnlClass(o.expected_net_profit)}`}
                        title={`The entry gate is expected net ≥ ${rupees(o.min_expected_net_profit)} after every cost`}
                      >
                        {o.expected_net_profit === null ? "unpriced" : rupees(o.expected_net_profit)}
                      </td>
                      <td className={`num box-col--group ${pnlClass(o.gross_edge)}`}>
                        {rupees(o.gross_edge)}
                      </td>
                      <td className="num box-dim">{rupees(o.entry_charges)}</td>
                      <td className="num box-dim">{rupees(o.estimated_exit_charges)}</td>
                      <td className="num box-dim">{rupees(o.execution_cost)}</td>
                      <td className="num box-dim">{rupees(o.safety_buffer)}</td>
                      <td className="num box-col--group">{o.lower_strike}</td>
                      <td className="num">{o.upper_strike}</td>
                      <td className="num box-dim">{o.box_width}</td>
                      <td className="num">{rupees(o.entry_box_cost)}</td>
                      <td className="box-dim">{formatExpiry(o.expiry)}</td>
                      <td className="box-col--group">
                        {/* The broker that WOULD execute this box: the scanner runs on exactly
                            one active broker at a time, and this is the backend's own
                            `status.broker`. It is not a per-opportunity field on the wire and is
                            not presented as one — it is the venue this whole scan belongs to,
                            repeated per row so a row can be read on its own. */}
                        <BrokerBadge broker={status?.broker} />
                      </td>
                      <td>
                        {/* Depth ONLY. Staleness has its own column, so a
                            perfectly deep but quiet book no longer reads as
                            illiquid. */}
                        {o.price_source === "last_close" ? (
                          <span
                            className="box-liq box-liq--closed"
                            title="Closing prices carry no bid/ask, so executable size is unknown"
                          >
                            n/a at close
                          </span>
                        ) : o.depth_ok ? (
                          <span
                            className="box-liq box-liq--ok"
                            title={`One whole lot (${o.lot_size}) rests at the best price on all four legs`}
                          >
                            {o.lot_size} @ touch
                          </span>
                        ) : (
                          <span
                            className="box-liq box-liq--bad"
                            title="At least one leg does not show a full lot at its best price"
                          >
                            under 1 lot
                          </span>
                        )}
                      </td>
                      <td>
                        {o.price_source === "last_close" ? (
                          <span className="box-fresh box-fresh--closed">close</span>
                        ) : (
                          <Freshness ageMs={o.worst_age_ms} limit={freshLimit} snapshotStale={snapshotStale} />
                        )}
                      </td>
                      <td>
                        <span
                          className={`box-status box-status--${o.status.toLowerCase()}`}
                          title={
                            o.status === "UNPRICED"
                              ? "The active broker could not price the eight box orders, so this box is shown but never auto-traded"
                              : o.status === "INDICATIVE"
                                ? "Derived from last traded prices while the market is shut — not executable, so it cannot be entered"
                                : o.reject
                                  ? `Not tradable: ${REJECT_LABEL[o.reject] ?? o.reject}`
                                  : undefined
                          }
                        >
                          {STATUS_LABEL[o.status]}
                        </span>
                        {/* The operator blocklist is a separate fact from the market verdict, so it
                            gets its own badge rather than overwriting `status`. A row can be
                            perfectly tradable AND excluded — that is exactly the case worth seeing,
                            because it is the one where an operator is declining real edge. */}
                        {excludedSymbols.has(o.underlying) && (
                          <span
                            className="box-badge box-badge--excluded"
                            title={`${o.underlying} is on the operator blocklist, so no new box will be entered on it. Any box already open on it is still monitored and will still exit.`}
                          >
                            EXCLUDED
                          </span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--sm btn--quiet"
                          onClick={() => {
                            const same =
                              expanded === o.underlying &&
                              selectedPair?.k1 === o.lower_strike &&
                              selectedPair?.k2 === o.upper_strike;
                            if (same) {
                              setExpanded(null);
                              setSelectedPair(null);
                            } else {
                              setExpanded(o.underlying);
                              // Pin THIS row's pair so the chain marks exactly its
                              // four legs, not just aggregate box marks.
                              setSelectedPair({ k1: o.lower_strike, k2: o.upper_strike });
                            }
                          }}
                          title="Show this box's four legs in the ATM ±3 chain"
                        >
                          {expanded === o.underlying &&
                          selectedPair?.k1 === o.lower_strike &&
                          selectedPair?.k2 === o.upper_strike
                            ? "Hide legs"
                            : "Show legs"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {/* --------------------------------- chain --------------------------- */}
      {view === "opportunities" && expanded && (
        <section className="box-section">
          <h2 className="box-section-title">
            {expanded} chain
            {chain && (
              <span className="box-chain-meta">
                {formatExpiry(chain.expiry)} · spot {fmt(chain.spot)} · ATM {chain.atm_strike} · lot{" "}
                {chain.lot_size}
              </span>
            )}
          </h2>
          {!chain ? (
            <p className="box-empty">
              <span className="spinner" />
              Loading the ATM ±3 window…
            </p>
          ) : (
            <>
            {selectedPair && (
              <BoxLegSummary chain={chain} pair={selectedPair} />
            )}
            <div className="box-table-wrap">
              <table className="box-chain">
                <thead>
                  <tr>
                    <th colSpan={4} className="box-chain-ce">
                      CALLS
                    </th>
                    <th className="box-chain-strike-h">STRIKE</th>
                    <th colSpan={4} className="box-chain-pe">
                      PUTS
                    </th>
                  </tr>
                  <tr>
                    <th className="num">BidQty</th>
                    <th className="num">Bid</th>
                    <th className="num">Ask</th>
                    <th className="num">AskQty</th>
                    <th className="box-chain-strike-h" />
                    <th className="num">BidQty</th>
                    <th className="num">Bid</th>
                    <th className="num">Ask</th>
                    <th className="num">AskQty</th>
                  </tr>
                </thead>
                <tbody>
                  {chain.strikes.map((row) => {
                    // When a specific box row is selected, mark EXACTLY its four
                    // legs; otherwise fall back to the aggregate detected-box marks.
                    const ceSide = selectedPair
                      ? boxLegSide(selectedPair, row.strike, "CE")
                      : hasMark(row.ce?.marks, "BUY_CE")
                        ? "BUY"
                        : hasMark(row.ce?.marks, "SELL_CE")
                          ? "SELL"
                          : null;
                    const peSide = selectedPair
                      ? boxLegSide(selectedPair, row.strike, "PE")
                      : hasMark(row.pe?.marks, "BUY_PE")
                        ? "BUY"
                        : hasMark(row.pe?.marks, "SELL_PE")
                          ? "SELL"
                          : null;
                    const inPair =
                      !!selectedPair &&
                      (row.strike === selectedPair.k1 || row.strike === selectedPair.k2);
                    return (
                    <tr
                      key={row.strike}
                      className={`${row.is_atm ? "box-chain-atm" : ""}${inPair ? " box-chain-leg-row" : ""}`}
                    >
                      <td className="num">{row.ce?.bid_qty || "-"}</td>
                      <td className={`num ${ceSide === "SELL" ? "box-marked" : ""}`}>
                        {row.ce?.bid ? fmt(row.ce.bid) : "-"}
                        {ceSide === "SELL" && <span className="box-leg box-leg--sell">SELL</span>}
                      </td>
                      <td className={`num ${ceSide === "BUY" ? "box-marked" : ""}`}>
                        {row.ce?.ask ? fmt(row.ce.ask) : "-"}
                        {ceSide === "BUY" && <span className="box-leg box-leg--buy">BUY</span>}
                      </td>
                      <td className="num">{row.ce?.ask_qty || "-"}</td>
                      <td className="box-chain-strike" title={row.ce?.tradingsymbol ?? ""}>
                        {row.strike}
                        {row.is_atm && <span className="box-atm-tag">ATM</span>}
                      </td>
                      <td className="num">{row.pe?.bid_qty || "-"}</td>
                      <td className={`num ${peSide === "SELL" ? "box-marked" : ""}`}>
                        {row.pe?.bid ? fmt(row.pe.bid) : "-"}
                        {peSide === "SELL" && <span className="box-leg box-leg--sell">SELL</span>}
                      </td>
                      <td className={`num ${peSide === "BUY" ? "box-marked" : ""}`}>
                        {row.pe?.ask ? fmt(row.pe.ask) : "-"}
                        {peSide === "BUY" && <span className="box-leg box-leg--buy">BUY</span>}
                      </td>
                      <td className="num">{row.pe?.ask_qty || "-"}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </section>
      )}

      {/* ------------------------------- open boxes ------------------------ */}
      {view === "open" && (
      <section className="box-section">
        <h2 className="box-section-title">
          Open positions <span className="pill-count">{open.length}</span>
          <span className="box-chain-meta">
            Monitored by the backend — this continues with the scanner stopped and the browser
            closed.
          </span>
        </h2>
        {open.length === 0 ? (
          <p className="box-empty">
            No open boxes. Qualifying boxes are opened automatically while the scanner is
            running.
          </p>
        ) : (
          <div className="box-cards">
            {open.map((p) => (
              <OpenBoxCard
                key={p.id}
                p={p}
                freshLimit={freshLimit}
                closing={closingId === p.id}
                onClose={() => void handleClose(p.id)}
                deleting={deletingId === p.id}
                snapshotStale={snapshotStale}
                {...(p.execution_mode !== "live"
                  ? {
                      onDelete: () =>
                        setDeleteTarget({
                          id: p.id,
                          underlying: p.underlying,
                          direction: p.direction,
                          broker: p.broker,
                          lower_strike: p.lower_strike,
                          upper_strike: p.upper_strike,
                          status: "open",
                        }),
                    }
                  : {})}
              />
            ))}
          </div>
        )}
      </section>
      )}

      {/* ------------------------------ closed boxes ----------------------- */}
      {view === "history" && (
      <section className="box-section">
        <h2 className="box-section-title">
          Execution history <span className="pill-count">{history.length}</span>
          {historyLoading && (
            <span className="box-chain-meta">
              <span className="spinner" /> loading earlier days…
            </span>
          )}
          {!historyLoading && historySource && historySource !== "none" && (
            <span className="box-chain-meta" title="Where today's closed trades were served from. memory/redis are the fast paths; mongo means the cache was cold.">
              today from {historySource}
            </span>
          )}
          {/* Historical trades from both brokers coexist; this narrows the view
              without ever hiding that the other broker's history exists. */}
          <BrokerHistoryFilter
            value={brokerFilter}
            onChange={setBrokerFilter}
            counts={brokerCounts}
          />
        </h2>
        {/* Never let a failed fetch look like "nothing has been closed". */}
        {historyError && <div className="banner banner--warn">{historyError}</div>}
        {!historyDbEnabled && (
          <div className="banner banner--warn">
            The box database is not connected on the server, so the closed-trade log cannot be
            read. Trades closed in this session may still be listed from memory.
          </div>
        )}
        {history.length === 0 ? (
          <p className="box-empty">
            {historyError
              ? "The closed-trade log could not be loaded — see the message above."
              : historyLoading
                ? "Loading closed boxes…"
                : dayPnlClosedCount > 0
                  ? `The day summary reports ${dayPnlClosedCount} box(es) closed today, but none could be listed. This is a load failure, not an empty log — try reloading.`
                  : "No closed boxes yet."}
          </p>
        ) : (
          <div className="box-history-days">
            {historyDays.map((day) => (
              <details
                className="box-history-day"
                key={day.key}
                open={isDayOpen(day.key)}
                onToggle={(e) => setDayOpen(day.key, e.currentTarget.open)}
              >
                <summary className="box-history-day-summary">
                  <span>
                    {day.key === todayKey && <strong>Today · </strong>}
                    {day.label}
                  </span>
                  <span className="box-history-day-meta">
                    <span className="pill-count">
                      {day.trades.length} {day.trades.length === 1 ? "trade" : "trades"}
                    </span>
                    <span
                      className="box-dim"
                      title={
                        `Total basket margin these ${day.trades.length} box(es) blocked, summed over the day — ` +
                        `an upper bound on what was blocked at any one instant, since boxes closed at ` +
                        `different times did not hold their margin simultaneously.` +
                        (day.marginUnknown > 0
                          ? ` ${day.marginUnknown} box(es) have no margin figure and are excluded.`
                          : "")
                      }
                    >
                      Margin {rupees(day.margin)}
                      {day.marginUnknown > 0 ? ` (${day.marginUnknown} n/a)` : ""}
                    </span>
                    <span className="box-dim">
                      Gross {rupees(day.gross)}
                      {day.grossUnknown > 0 ? ` (${day.grossUnknown} n/a)` : ""}
                    </span>
                    {/* An unpriced charge shown as ₹0 makes a losing day look profitable, so the
                        count is stated rather than folded into the sum. */}
                    <span
                      className="box-dim"
                      title={
                        day.feesUnknown > 0
                          ? `${day.feesUnknown} box(es) have no priced charges and are EXCLUDED from this total — ` +
                            `they are not counted as zero, because that would overstate the day's profit.`
                          : "Total charges for the boxes closed on this day."
                      }
                    >
                      Fees {rupees(day.fees)}
                      {day.feesUnknown > 0 ? ` (${day.feesUnknown} unpriced)` : ""}
                    </span>
                    <span className={pnlClass(day.net)}>
                      Net {rupees(day.net)}
                      {day.netUnknown > 0 ? ` (${day.netUnknown} n/a)` : ""}
                    </span>
                  </span>
                </summary>
                <div className="box-table-wrap">
                  <table className="box-table">
                    <thead>
                      <tr>
                        <th>Underlying</th>
                        <th>Direction</th>
                        <th>Expiry</th>
                        <th className="num">K1 → K2</th>
                        <th>Opened</th>
                        <th>Closed</th>
                        <th className="num">Held</th>
                        <th>Broker</th>
                        <th className="num">Margin</th>
                        <th className="num">Entry cost</th>
                        <th className="num">Exit value</th>
                        <th className="num">Entry fees</th>
                        <th className="num">Exit fees</th>
                        <th className="num">Total fees</th>
                        <th className="num">Gross P&amp;L</th>
                        <th className="num">Net P&amp;L</th>
                        <th>Reason</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {day.trades.map((t) => (
                        <tr key={t.id}>
                          <td>
                            <span className="box-sym">{t.underlying}</span>
                            {t.is_index && <span className="badge-index">INDEX</span>}
                          </td>
                          <td><DirectionBadge direction={t.direction} /></td>
                          <td className="box-dim">{formatExpiry(t.expiry)}</td>
                          <td className="num">
                            {t.lower_strike} → {t.upper_strike}
                          </td>
                          <td className="box-dim">{fmtDateTime(t.opened_at)}</td>
                          <td className="box-dim">{t.closed_at ? fmtDateTime(t.closed_at) : "-"}</td>
                          <td className="num box-dim">{duration(t.opened_at, t.closed_at)}</td>
                          <td><BrokerBadge broker={t.broker} /></td>
                          <td
                            className={`num box-dim${marginOverstatesHedge(t.margin_source) ? " box-warn" : ""}`}
                            title={
                              t.margin_source
                                ? `Margin source${marginProvenanceSuffix(t.margin_source)}`
                                : "Margin source not recorded for this trade"
                            }
                          >
                            {rupees(t.margin)}
                          </td>
                          <td className="num">{rupees(t.entry_box_cost)}</td>
                          <td className="num">{rupees(t.exit_box_value)}</td>
                          <td className="num box-dim">{rupees(t.entry_charges?.total ?? null)}</td>
                          <td className="num box-dim">{rupees(t.exit_charges?.total ?? null)}</td>
                          <td className="num box-dim">{rupees(t.total_charges)}</td>
                          <td className={`num ${pnlClass(t.gross_pnl)}`}>{rupees(t.gross_pnl)}</td>
                          <td className={`num box-net ${pnlClass(t.net_pnl)}`}>{rupees(t.net_pnl)}</td>
                          <td>
                            <span className="box-reason">{t.exit_reason ?? "-"}</span>
                          </td>
                          <td>
                            {t.execution_mode === "live" ? (
                              // A closed LIVE trade is the audit record of real
                              // executed orders and is deliberately retained.
                              <span
                                className="box-dim"
                                title="Closed LIVE trades are retained as the audit record of real executed orders."
                              >
                                retained
                              </span>
                            ) : (
                              <button
                                className="btn btn--sm btn--danger"
                                disabled={deletingId === t.id}
                                title="Permanently delete this PAPER trade and recalculate all Box statistics"
                                onClick={() =>
                                  setDeleteTarget({
                                    id: t.id,
                                    underlying: t.underlying,
                                    direction: t.direction,
                                    broker: t.broker,
                                    lower_strike: t.lower_strike,
                                    upper_strike: t.upper_strike,
                                    status: t.status,
                                  })
                                }
                              >
                                {deletingId === t.id ? "Deleting…" : "Delete"}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>
        )}

        <h2 className="box-section-title box-section-title--sub">
          Aborted legging executions <span className="pill-count">{attempts.length}</span>
          <span className="box-chain-meta">
            Partial fills that had to be emergency-unwound at a loss — not trades, but they cost
            money, so they count against strategy P&amp;L.
          </span>
        </h2>
        {attemptsError && (
          <div className="banner banner--warn">
            <strong>The aborted-execution log could not be loaded.</strong> {attemptsError} The list
            below is <strong>not</strong> evidence that nothing was unwound — it is empty because the
            log could not be read. Reload to try again.
          </div>
        )}
        <BoxExecutionAttempts attempts={attempts} />
      </section>
      )}

      <p className="box-disclaimer">
        {status?.execution_mode === "live" ? (
          <>
            <strong>Live execution.</strong> Boxes above are opened with real broker orders through
            the fail-closed durable order manager. Real trading still carries inter-leg latency,
            queue position, depth disappearing, partial fills, order rejection and legging risk —
            see the execution-health panel above for the measured figures.
          </>
        ) : (
          <>
            <strong>Paper execution.</strong> Every box above is simulated. A paper fill assumes all
            four one-lot legs were simultaneously executable at the touch recorded in that snapshot.
            Real trading can differ because of inter-leg latency, queue position, depth disappearing,
            partial fills, order rejection and legging risk. These are not exchange fills.
          </>
        )}
      </p>

      {/* Destructive confirmation. Rendered last so it overlays the whole page. */}
      {deleteTarget && (
        <BoxDeleteModal
          underlying={deleteTarget.underlying}
          direction={deleteTarget.direction}
          broker={deleteTarget.broker}
          lowerStrike={deleteTarget.lower_strike}
          upperStrike={deleteTarget.upper_strike}
          status={deleteTarget.status}
          busy={deletingId === deleteTarget.id}
          onConfirm={(reason) => void handleDelete(deleteTarget.id, reason)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Pre-run confirmation: what is about to be watched, and what will not be. Informational —
          every real refusal stays with the backend, so this can only decline to proceed. */}
      {confirmRun && (
        <RunConfirm
          // The EXECUTION MODE, not the stream state. `live` here is the SSE connection and was
          // previously passed by mistake — see the prop doc in RunConfirm for why that inverted the
          // dialog's safety claim whenever the stream dropped on a live deployment.
          mode={headerMode}
          busy={busy}
          onConfirm={() => {
            setConfirmRun(false);
            void toggleScanner();
          }}
          onCancel={() => setConfirmRun(false)}
        />
      )}
    </div>
  );
}

function hasMark(marks: string[] | undefined, mark: string): boolean {
  return !!marks && marks.includes(mark);
}

/**
 * The side a given (strike, CE/PE) cell trades for a specific long box K1<K2:
 *   BUY  K1 CE   SELL K2 CE   BUY  K2 PE   SELL K1 PE
 * Returns null for any cell that is not one of that box's four legs.
 */
function boxLegSide(
  pair: { k1: number; k2: number } | null,
  strike: number,
  type: "CE" | "PE",
): "BUY" | "SELL" | null {
  if (!pair) return null;
  if (type === "CE" && strike === pair.k1) return "BUY";
  if (type === "CE" && strike === pair.k2) return "SELL";
  if (type === "PE" && strike === pair.k2) return "BUY";
  if (type === "PE" && strike === pair.k1) return "SELL";
  return null;
}

/** One live open box, with its entry fills and current exit arithmetic. */
function OpenBoxCard({
  p,
  freshLimit,
  closing,
  onClose,
  onDelete,
  deleting,
  snapshotStale = false,
}: {
  p: BoxOpenPosition;
  freshLimit: number;
  closing: boolean;
  onClose: () => void;
  /** Absent for a LIVE position: real exposure must be flattened, not deleted. */
  onDelete?: () => void;
  deleting: boolean;
  /**
   * True when the snapshot carrying this position's exit-leg book ages has gone stale.
   *
   * Passed down so the per-leg freshness pills stop claiming a frozen age is current. Note that
   * "Close now" is deliberately NOT gated on it: closing is risk-reducing, the backend re-checks the
   * real book before it sends anything, and an operator must never be locked out of exiting by a
   * stale screen.
   */
  snapshotStale?: boolean;
}) {
  // A live position never gets a delete affordance. Its record is the only link to
  // real broker exposure, so removing it would orphan that exposure entirely.
  const isLive = p.execution_mode === "live";
  const exitByRole = new Map(p.exit_legs.map((l) => [l.role, l]));
  return (
    <div className={`box-card${p.exit_eligible ? " box-card--exiting" : ""}`}>
      <div className="box-card-head">
        <div>
          <span className="box-sym">{p.underlying}</span>
          {p.is_index && <span className="badge-index">INDEX</span>}
          <DirectionBadge direction={p.direction} />
          <BrokerBadge broker={p.broker} />
          <span className="box-card-strikes">
            {p.lower_strike} → {p.upper_strike}
          </span>
          <span className="box-chain-meta">
            {formatExpiry(p.expiry)} · {p.quantity} qty (1 lot) · held{" "}
            {duration(p.opened_at, null)}
          </span>
        </div>
        <div className="box-card-actions">
          {/* Attention markers first — state before controls. */}
          {p.exit_eligible && <span className="box-badge box-badge--exit">AUTO EXIT ELIGIBLE</span>}
          {p.expiry_safety && <span className="box-badge box-badge--warn">EXPIRY SAFETY</span>}

          {/* CRITICAL ZONE. Everything that changes exposure or destroys a record lives inside
              this separated group, set apart from the read-mostly card body by its own rule and
              inset. The affordances themselves are UNCHANGED — the same single click with the
              same backend confirmation behaviour as before. This makes them easier to FIND and
              no easier to hit by accident, which is the correct direction for a control that
              flattens a real four-leg position. */}
          <div className="box-card-critical" role="group" aria-label="Position controls">
            <button
              type="button"
              className="btn btn--sm btn--critical"
              onClick={onClose}
              disabled={closing || deleting}
              title="Close now at the current executable touch. The backend refuses if a whole-lot market is not available on all four reversed legs."
            >
              {closing ? "Closing…" : "Close now"}
            </button>
            {isLive ? (
              // Stated rather than hidden, so the restriction is understood instead of
              // looking like a missing feature.
              <span
                className="box-dim box-delete-blocked"
                title="A live position's record is the only link to real broker exposure. Deleting it would orphan that exposure."
              >
                Close/flatten this live position before removing records.
              </span>
            ) : (
              onDelete && (
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  onClick={onDelete}
                  disabled={deleting || closing}
                  title="Permanently delete this PAPER trade and recalculate all Box statistics"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              )
            )}
          </div>
        </div>
      </div>

      <div className="box-legs">
        {p.entry_legs.map((leg) => {
          const ex = exitByRole.get(leg.role);
          return (
            <div className="box-leg-row" key={leg.role}>
              <span className={`leg-tag ${leg.side === "BUY" ? "tag-buy" : "tag-sell"}`}>
                {leg.side}
              </span>
              <span className="box-leg-name">
                {leg.strike} {leg.instrument_type}
              </span>
              <span className="box-leg-cell">
                @ {fmt(leg.entry_price)}
                <span className="box-leg-side">
                  {leg.side === "BUY" ? "ask" : "bid"}
                </span>
              </span>
              <span className={`leg-tag ${ex?.side === "BUY" ? "tag-buy" : "tag-sell"}`}>
                {ex?.side ?? "-"}
              </span>
              <span className="box-leg-cell">
                {ex?.price ? fmt(ex.price) : "-"}
                <span className="box-leg-side">{ex?.side === "BUY" ? "ask" : "bid"}</span>
              </span>
              <span className="box-leg-cell box-dim">
                {ex ? `${ex.side === "BUY" ? ex.ask_qty : ex.bid_qty} @ touch` : "-"}
              </span>
              <Freshness ageMs={ex?.age_ms ?? null} limit={freshLimit} snapshotStale={snapshotStale} />
              {ex && !ex.executable && <span className="box-liq box-liq--bad">thin</span>}
            </div>
          );
        })}
      </div>

      <div className="box-card-grid">
        <Metric label="Entry edge" value={rupees(p.entry_edge)} />
        <Metric label="Expected net (entry)" value={rupees(p.expected_net_profit)} />
        <Metric
          label={`Margin (all 4 legs)${marginProvenanceSuffix(p.margin_source)}`}
          value={p.margin === null ? "unpriced" : rupees(p.margin)}
        />
        <Metric label="Entry cost" value={rupees(p.entry_box_cost)} />
        <Metric label="Exit value now" value={rupees(p.exit_box_value)} />
        <Metric label="Gross P&L" value={rupees(p.gross_pnl)} cls={pnlClass(p.gross_pnl)} />
        <Metric label="Entry fees" value={rupees(p.entry_charges)} />
        <Metric label="Est. exit fees" value={rupees(p.current_exit_charges)} />
        <Metric label="Total charges" value={rupees(p.total_charges)} />
        <Metric
          label="CURRENT NET P&L"
          value={rupees(p.net_pnl)}
          cls={`box-metric--strong ${pnlClass(p.net_pnl)}`}
        />
        <Metric
          label="Realisable net"
          value={rupees(p.realisable_net_pnl)}
          cls={pnlClass(p.realisable_net_pnl)}
        />
        {/* Convergence progress — the point of the strategy. */}
        <Metric label="Remaining edge" value={rupees(p.remaining_edge)} />
        <Metric label="Captured edge" value={rupees(p.captured_edge)} />
        <Metric
          label="Captured %"
          value={p.captured_pct === null ? "—" : `${Math.round(p.captured_pct * 100)}%`}
        />
        <Metric label="Exit threshold" value={rupees(p.convergence_threshold)} />
        <Metric label="Min exit profit" value={rupees(p.min_exit_net_pnl)} />
        <Metric label="Profit capture at" value={rupees(p.profit_capture_target)} />
      </div>

      {/* Say plainly why an open box is NOT closing, so the rules are legible
          rather than looking like the engine is asleep. */}
      {!p.exit_eligible && <p className="box-held">{whyHeld(p)}</p>}
      {p.exit_blocked_reason && (
        <p className="box-blocked">
          Exit held back: {p.exit_blocked_reason}. The position stays open and keeps being
          monitored — no fill is invented.
        </p>
      )}
    </div>
  );
}

/**
 * The four exact contracts a selected box is monitoring, so the strikes and
 * trading symbols can be checked against the active broker directly.
 */
function BoxLegSummary({
  chain,
  pair,
}: {
  chain: BoxChain;
  pair: { k1: number; k2: number };
}) {
  const k1 = chain.strikes.find((s) => s.strike === pair.k1);
  const k2 = chain.strikes.find((s) => s.strike === pair.k2);
  const legs = [
    { role: "K1 CE", side: "BUY" as const, side_price: "ask", side_of: k1?.ce },
    { role: "K2 CE", side: "SELL" as const, side_price: "bid", side_of: k2?.ce },
    { role: "K2 PE", side: "BUY" as const, side_price: "ask", side_of: k2?.pe },
    { role: "K1 PE", side: "SELL" as const, side_price: "bid", side_of: k1?.pe },
  ];
  return (
    <div className="box-legsum">
      <div className="box-legsum-head">
        Monitoring these four legs for {chain.underlying} {pair.k1} → {pair.k2}
        <span className="box-chain-meta">
          fills at the touch: BUY = ask, SELL = bid · verify the symbols against the active broker
        </span>
      </div>
      <div className="box-legsum-grid">
        {legs.map((l) => {
          const q = l.side_of;
          const fill = q ? (l.side === "BUY" ? q.ask : q.bid) : 0;
          const qty = q ? (l.side === "BUY" ? q.ask_qty : q.bid_qty) : 0;
          return (
            <div className="box-legsum-leg" key={l.role}>
              <span className={`leg-tag ${l.side === "BUY" ? "tag-buy" : "tag-sell"}`}>
                {l.side}
              </span>
              <span className="box-legsum-role">{l.role}</span>
              <span className="box-legsum-sym" title={q?.tradingsymbol ?? "not in the window"}>
                {q?.tradingsymbol ?? "—"}
              </span>
              <span className="box-legsum-px">
                {fill ? fmt(fill) : "-"}
                <span className="box-leg-side"> {l.side_price}</span>
              </span>
              <span className="box-legsum-qty">{qty ? `${qty} qty` : "no size"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Why an open box has not auto-closed yet, in one sentence.
 *
 * The exit rules are: close when the net P&L is positive AND either the edge has
 * converged (remaining <= threshold) with net >= the minimum profit, or the
 * captured profit has reached the target — and only while all four reversed legs
 * have fresh one-lot liquidity. This turns "not eligible" into the specific
 * reason so the page never looks like it is doing nothing.
 */
function whyHeld(p: BoxOpenPosition): string {
  if (p.net_pnl === null) {
    return "Held: charges for this box could not be priced, so its net P&L can't be confirmed — it will not auto-close on an unknown cost.";
  }
  if (p.net_pnl <= 0) {
    return `Held: closing now would realise ${rupees(p.net_pnl)} — the box will not be closed below break-even. It waits for the spread to converge back in profit.`;
  }
  if (!p.liquidity_ok) {
    return "Held: the four-leg one-lot market is not currently executable (see the leg rows above). It will close once liquidity returns.";
  }
  const remaining = p.remaining_edge;
  const converged = remaining !== null && remaining <= p.convergence_threshold;
  if (!converged && p.net_pnl < p.profit_capture_target) {
    return `Held: in profit at ${rupees(p.net_pnl)}, but the edge has not converged (remaining ${rupees(remaining)} > ${rupees(p.convergence_threshold)} target) and profit is below the ${rupees(p.profit_capture_target)} capture level. Waiting for one of those.`;
  }
  if (converged && p.net_pnl < p.min_exit_net_pnl) {
    return `Held: the edge has converged, but net profit ${rupees(p.net_pnl)} is below the ${rupees(p.min_exit_net_pnl)} minimum for a convergence exit.`;
  }
  return "Held: monitoring — exit conditions not yet met.";
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className={`box-metric ${cls ?? ""}`}>
      <span className="box-metric-k">{label}</span>
      <span className="box-metric-v">{value}</span>
    </div>
  );
}
