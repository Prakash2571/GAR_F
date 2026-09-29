/**
 * The Synthetic workspace: futures vs synthetic futures (K + CE − PE) on Zerodha or Dhan,
 * served by the self-contained gts-synth service, in five execution modes (four paper, one live).
 *
 * The service is the authority on everything this page shows: broker sessions, eligibility,
 * fills, P&L, what a setting may be, whether live orders are permitted. This component renders
 * its snapshot and sends the operator's controls back. Almost every knob is a runtime setting
 * changed here and saved on the server.
 *
 * The header's mode badge is derived ONLY from the server's status (`execution_mode`,
 * `live_orders`, `live_armed`, `live_breaker`). Live orders need the server's environment
 * consent, execution_mode = live AND an explicit ARM from the Execution tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LockKeyIcon } from "@phosphor-icons/react";
import GTSWordmark from "../brand/GTSWordmark.tsx";
import StatusBadge from "../ui/StatusBadge.tsx";
import Button from "../ui/Button.tsx";
import Modal from "../ui/Modal.tsx";
import ThemeToggle from "../../ThemeToggle.tsx";
import { SynthStream } from "../../lib/synthStream.ts";
import { ApiError, describeRequestFailure } from "../../api/http.ts";
import { fmtMoney } from "../../format.ts";
import {
  armSynthLive,
  closeAllSynthTrades,
  closeSynthTrade,
  deleteSynthTrade,
  disarmSynthLive,
  fetchSynthBrokers,
  fetchSynthExecution,
  fetchSynthHistory,
  fetchSynthOpen,
  fetchSynthOpportunities,
  fetchSynthSettings,
  patchSynthSettings,
  reconcileSynthLive,
  resetSynthBreaker,
  startSynth,
  stopSynth,
  synthAccessStatus,
  synthStreamUrl,
  type SynthBrokerId,
  type SynthBrokerView,
  type SynthExecutionMode,
  type SynthExecutionView,
  type SynthOpenPosition,
  type SynthOpportunity,
  type SynthSetting,
  type SynthSettingValue,
  type SynthSettings,
  type SynthSnapshot,
  type SynthStatus,
  type SynthTrade,
} from "../../api/synth.ts";
import {
  BROKER_LABEL,
  MODE_LABEL,
  formatSettingValue,
  isPaperMode,
  mergeClosed,
  modeBadge,
  parseBrokerLoginResult,
  pnlClass,
} from "../../lib/synthView.ts";
import SynthOpportunities from "./SynthOpportunities.tsx";
import { SynthClosedHistory, SynthDayPnlStrip, SynthOpenCards } from "./SynthPositions.tsx";
import SynthSettingsPanel from "./SynthSettingsPanel.tsx";
import SynthBrokerPanel from "./SynthBrokerPanel.tsx";
import SynthExecution from "./SynthExecution.tsx";

type View = "opportunities" | "open" | "history" | "execution" | "brokers" | "settings";

const EXECUTION_EVENTS = new Set(["attempt", "entry", "exit", "residual", "quarantine"]);

interface PendingChange {
  setting: SynthSetting;
  value: SynthSettingValue;
}

function Stat({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="synth-stat" title={title}>
      <span className="synth-stat-k">{k}</span>
      <span className="synth-stat-v">{v}</span>
    </div>
  );
}

export default function Synthetic({ onLock }: { onLock: () => void }) {
  const [status, setStatus] = useState<SynthStatus | null>(null);
  const [opps, setOpps] = useState<SynthOpportunity[]>([]);
  const [open, setOpen] = useState<SynthOpenPosition[]>([]);
  const [history, setHistory] = useState<SynthTrade[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SynthSettings | null>(null);
  const [brokers, setBrokers] = useState<SynthBrokerView[]>([]);
  const [view, setView] = useState<View>("opportunities");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SynthTrade | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [execView, setExecView] = useState<SynthExecutionView | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const pendingSnap = useRef<SynthSnapshot | null>(null);
  const deletedIds = useRef<Set<string>>(new Set());
  const viewRef = useRef<View>("opportunities");
  viewRef.current = view;

  const byKey = useMemo(() => {
    const m = new Map<string, SynthSetting>();
    for (const s of settings?.settings ?? []) m.set(s.key, s);
    return m;
  }, [settings]);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await fetchSynthSettings());
    } catch (err) {
      setError(describeRequestFailure(err));
    }
  }, []);

  const loadBrokers = useCallback(async () => {
    try {
      setBrokers(await fetchSynthBrokers());
    } catch (err) {
      setError(describeRequestFailure(err));
    }
  }, []);

  const loadExecution = useCallback(async () => {
    try {
      setExecView(await fetchSynthExecution(50));
      setExecError(null);
    } catch (err) {
      setExecError(describeRequestFailure(err));
    }
  }, []);

  const loadHistory = useCallback(async (scope: "today" | "all") => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const h = await fetchSynthHistory(scope, 1000);
      setHistory((prev) => mergeClosed(prev, h.trades, deletedIds.current));
    } catch (err) {
      setHistoryError(describeRequestFailure(err));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  /* ------------------------------ load + stream ----------------------------- */

  useEffect(() => {
    // Back from a broker login: announce the result once, then strip it from the URL.
    const { result, cleaned } = parseBrokerLoginResult(window.location.search);
    if (result) {
      if (result.ok) setNotice(result.message);
      else setError(result.message);
      setView("brokers");
      window.history.replaceState({}, "", `${window.location.pathname}${cleaned}${window.location.hash}`);
    }
    fetchSynthOpportunities()
      .then((r) => {
        setStatus(r.status);
        setOpps(r.opportunities);
      })
      .catch((err) => setError(describeRequestFailure(err)));
    fetchSynthOpen()
      .then(setOpen)
      .catch(() => {
        /* the stream carries them too */
      });
    void loadSettings();
    void loadBrokers();
    void loadHistory("today");
    void loadExecution();
  }, [loadSettings, loadBrokers, loadHistory, loadExecution]);

  // The Execution tab is refreshed while it is on screen (the header reads the snapshot).
  useEffect(() => {
    if (view !== "execution") return;
    void loadExecution();
    const t = window.setInterval(() => void loadExecution(), 3000);
    return () => window.clearInterval(t);
  }, [view, loadExecution]);

  // Another tab changed the settings: reload them so this page never edits a stale version.
  const serverVersion = status?.settings_version;
  useEffect(() => {
    if (serverVersion !== undefined && settings && serverVersion !== settings.version) void loadSettings();
  }, [serverVersion, settings, loadSettings]);

  useEffect(() => {
    const flush = window.setInterval(() => {
      const snap = pendingSnap.current;
      if (!snap) return;
      pendingSnap.current = null;
      setStatus(snap.status);
      setOpps(snap.opportunities);
      setOpen(snap.open_trades.filter((p) => !deletedIds.current.has(p.id)));
    }, 400);
    const stream = new SynthStream({
      url: synthStreamUrl(),
      events: ["snapshot", "entry", "exit", "trade_deleted", "attempt", "residual", "quarantine", "session_ended"],
      onOpen: () => setLive(true),
      onDisconnect: () => setLive(false),
      probeSessionEnded: async () => !(await synthAccessStatus()).authenticated,
      // The gate listens for the synth 401 and shows the passcode form; a probe that found
      // the session gone confirms it the same way.
      onSessionEnded: () => {
        setLive(false);
        onLock();
      },
      onEvent: (type, data) => {
        if (EXECUTION_EVENTS.has(type) && viewRef.current === "execution") void loadExecution();
        try {
          if (type === "snapshot") {
            pendingSnap.current = JSON.parse(data) as SynthSnapshot;
            setLive(true);
          } else if (type === "exit") {
            const p = JSON.parse(data) as { trade?: SynthTrade };
            if (p.trade) setHistory((prev) => mergeClosed(prev, [p.trade!], deletedIds.current));
          } else if (type === "trade_deleted") {
            const { id } = JSON.parse(data) as { id?: string };
            if (id) {
              deletedIds.current.add(id);
              setHistory((prev) => prev.filter((t) => t.id !== id));
              setOpen((prev) => prev.filter((t) => t.id !== id));
            }
          }
        } catch {
          /* ignore a malformed frame */
        }
      },
    });
    stream.start();
    return () => {
      window.clearInterval(flush);
      stream.stop();
    };
  }, [onLock, loadExecution]);

  /* --------------------------------- actions -------------------------------- */

  async function run<T>(fn: () => Promise<T>, ok: (v: T) => string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(ok(await fn()));
    } catch (err) {
      setError(describeRequestFailure(err));
    } finally {
      setBusy(false);
    }
  }

  const running = status?.running === true;

  const toggleRun = () =>
    void run(
      async () => {
        const s = running ? await stopSynth() : await startSynth();
        setStatus(s);
        if (!s.running) setOpps([]);
        return s;
      },
      (s) =>
        s.running
          ? s.execution_mode === "live"
            ? s.live_orders
              ? "Scanner running LIVE and armed: confirmed ELIGIBLE opportunities are entered with real orders when auto-entry is on."
              : "Scanner running in live mode, not armed: no entry order is sent until you arm it in the Execution tab."
            : `Scanner running. Confirmed ELIGIBLE opportunities are traded in ${MODE_LABEL[s.execution_mode] ?? s.execution_mode} when auto-entry is on.`
          : "Scanner stopped and live disarmed. No new entries; open positions stay under their exit rules.",
    );

  const submitChange = useCallback(
    async (setting: SynthSetting, value: SynthSettingValue) => {
      if (!settings) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const r = await patchSynthSettings(settings.version, { [setting.key]: value });
        setSettings(r.settings);
        setStatus(r.status);
        setNotice(`${setting.label}: ${formatSettingValue(setting, value)}. Saved on the server.`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) void loadSettings();
        setError(describeRequestFailure(err));
      } finally {
        setBusy(false);
      }
    },
    [settings, loadSettings],
  );

  /** Risk settings are confirmed first; the server validates either way. */
  const requestChange = useCallback(
    (setting: SynthSetting, value: SynthSettingValue) => {
      if (setting.risk) setPendingChange({ setting, value });
      else void submitChange(setting, value);
    },
    [submitChange],
  );

  const quick = (key: string, value: SynthSettingValue) => {
    const s = byKey.get(key);
    if (s) requestChange(s, value);
  };

  async function handleClose(id: string) {
    setClosingId(id);
    setError(null);
    setNotice(null);
    try {
      const r = await closeSynthTrade(id);
      setOpen(r.open);
      setStatus(r.status);
      if (r.async) {
        setNotice(
          `Closing ${r.trade.underlying} through ${MODE_LABEL[r.trade.execution_mode] ?? r.trade.execution_mode}: the closing orders are being worked, risk-reducing first. The result appears here when they finish.`,
        );
      } else {
        setHistory((prev) => mergeClosed(prev, [r.trade], deletedIds.current));
        setNotice(
          `Closed at the touch: gross ${fmtMoney(r.trade.gross_pnl)}, charges ${fmtMoney(r.trade.total_charges)}, net ${fmtMoney(r.trade.net_pnl)} after charges.`,
        );
      }
    } catch (err) {
      setError(describeRequestFailure(err));
    } finally {
      setClosingId(null);
    }
  }

  async function handleCloseAll() {
    setConfirmCloseAll(false);
    await run(
      async () => {
        const r = await closeAllSynthTrades();
        setOpen(r.open);
        setStatus(r.status);
        void loadHistory("today");
        return r;
      },
      (r) => {
        const done = r.results.filter((x) => x.closed).length;
        const started = r.results.filter((x) => x.started).length;
        const held = r.results.filter((x) => !x.closed && !x.started);
        const head = `Closed ${done} at the touch${started > 0 ? `; ${started} being closed through their execution mode` : ""}`;
        return held.length === 0 ? `${head}.` : `${head}; ${held.length} held: ${held.map((f) => `${f.underlying} (${f.error})`).join("; ")}`;
      },
    );
  }

  /* ------------------------------- live controls ------------------------------ */

  async function liveAction<R extends { execution: SynthExecutionView; status: SynthStatus }>(
    fn: () => Promise<R>,
    ok: string | ((r: R) => string),
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    setExecError(null);
    try {
      const r = await fn();
      setExecView(r.execution);
      setStatus(r.status);
      setNotice(typeof ok === "string" ? ok : ok(r));
      return true;
    } catch (err) {
      setExecError(describeRequestFailure(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const onArm = (phrase: string) =>
    liveAction(() => armSynthLive(phrase), "LIVE ARMED: confirmed entries now send real LIMIT orders. Disarm stops new entries at once.");
  const onDisarm = () =>
    void liveAction(() => disarmSynthLive(), "Live disarmed: no new entry order is sent. Open live positions stay under their exit rules.");
  const onResetBreaker = (phrase: string) =>
    liveAction(() => resetSynthBreaker(phrase), "Circuit breaker reset. Live stays disarmed until you arm it again.");
  const onReconcile = () =>
    void liveAction(
      async () => {
        const r = await reconcileSynthLive();
        setOpen(r.open.filter((p) => !deletedIds.current.has(p.id)));
        return r;
      },
      (r) => {
        const left = r.reconcile.unresolved_intents.length;
        return left === 0
          ? `Reconciled ${r.reconcile.examined} order(s) with the broker; nothing is unresolved.`
          : `Reconciled ${r.reconcile.examined} order(s); ${left} still unproven at the broker.`;
      },
    );

  async function handleDelete() {
    const t = deleteTarget;
    if (!t) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const r = await deleteSynthTrade(t.id, t.status, deleteReason.trim() || undefined);
      deletedIds.current.add(t.id);
      setStatus(r.status);
      setOpen(r.open.filter((p) => !deletedIds.current.has(p.id)));
      setHistory((prev) => mergeClosed(prev.filter((x) => x.id !== t.id), r.closed_today, deletedIds.current));
      setDeleteTarget(null);
      setDeleteReason("");
      setNotice(
        r.already_deleted
          ? `That trade on ${t.underlying} had already been deleted.`
          : `Trade on ${t.underlying} deleted; P&L and margin were recalculated.`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        deletedIds.current.add(t.id);
        setHistory((prev) => prev.filter((x) => x.id !== t.id));
        setDeleteTarget(null);
        setNotice(`That trade on ${t.underlying} no longer exists on the server.`);
      } else {
        setDeleteError(describeRequestFailure(err));
      }
    } finally {
      setDeleting(false);
    }
  }

  const onBrokersChanged = (list: SynthBrokerView[] | null, ok: string | null, err: string | null) => {
    if (list) setBrokers(list);
    setNotice(ok);
    setError(err);
  };

  /* ---------------------------------- view ---------------------------------- */

  const marketOpen = status?.market_open ?? true;
  const strikeLevel = status?.strike_level ?? 3;
  const brokerSetting = String(byKey.get("broker")?.value ?? status?.broker_mode ?? "zerodha") as SynthBrokerId;
  const autoEntry = byKey.get("auto_entry")?.value === true;
  const autoExit = byKey.get("auto_exit")?.value === true;
  const lots = Number(byKey.get("lots_per_trade")?.value ?? 1);
  const exitEligible = open.filter((p) => p.exit_eligible).length;
  const closedNet = history.reduce((s, t) => s + (t.net_pnl ?? 0), 0);
  const connectedCount = brokers.filter((b) => b.connected).length;
  const stateTone = !status ? "neutral" : !running ? "neutral" : !marketOpen ? "warning" : live && status.feed_healthy ? "live" : "warning";
  const stateText = !status
    ? "Loading…"
    : !running
      ? "Stopped"
      : !marketOpen
        ? "Market closed"
        : !live
          ? "Reconnecting…"
          : status.feed_healthy
            ? "Scanning"
            : "Feed stale";

  const mode = (status?.execution_mode ?? byKey.get("execution_mode")?.value ?? "paper_touch") as SynthExecutionMode;
  const badge = modeBadge(status);
  const execAlerts = (status?.unresolved_intents ?? 0) + (status?.quarantined_count ?? 0) + (status?.live_breaker ? 1 : 0);

  const tabs: [View, string, number, number][] = [
    ["opportunities", "Opportunities", status?.opportunity_count ?? opps.length, status?.eligible_count ?? 0],
    ["open", "Open trades", open.length, exitEligible + (status?.residual_count ?? 0)],
    ["history", "Closed trades", history.length, 0],
    ["execution", "Execution", execView?.attempts.length ?? 0, execAlerts],
    ["brokers", "Brokers", connectedCount, 0],
    ["settings", "Settings", settings?.settings.length ?? 0, 0],
  ];

  return (
    <div className="synth-page">
      <header className="synth-header">
        <div className="synth-header-id">
          <GTSWordmark
            variant="product"
            markSize={20}
            subtitle={<span className="synth-dim">Synthetic · K + CE − PE · {MODE_LABEL[mode] ?? mode}</span>}
          />
        </div>
        <div className="synth-header-state">
          <StatusBadge tone={badge.tone} title={badge.title}>
            {badge.text}
          </StatusBadge>
          <StatusBadge tone={stateTone} announce>
            {stateText}
          </StatusBadge>
          {status && (
            <StatusBadge
              tone={status.authenticated ? "positive" : "negative"}
              title={status.authenticated ? "Broker session is usable" : `Broker not connected (${status.auth_reason ?? "unknown"})`}
            >
              {(BROKER_LABEL[status.broker] ?? "no broker").toUpperCase()}
              {status.authenticated ? "" : " · not connected"}
            </StatusBadge>
          )}
        </div>
        <div className="synth-header-actions">
          <ThemeToggle />
          <Button variant="quiet" onClick={onLock} aria-label="Lock the synthetic workspace" title="End this session">
            <LockKeyIcon size={16} weight="regular" aria-hidden="true" />
            <span>Lock</span>
          </Button>
          <Button
            variant={running ? "danger" : "primary"}
            onClick={toggleRun}
            disabled={busy || !status}
            title={running ? "Stop discovery (open positions stay monitored)" : "Start scanning"}
          >
            {running ? "STOP" : "RUN"}
          </Button>
        </div>
      </header>

      {error && <div className="banner banner--error">{error}</div>}
      {notice && !error && <div className="banner banner--info">{notice}</div>}
      {status?.last_error && <div className="banner banner--warn">{status.last_error}</div>}
      {status?.live_breaker && (
        <div className="banner banner--error">
          <strong>Live circuit breaker open:</strong> {status.live_breaker}. No new live entry is sent until every order is
          reconciled and the breaker reset in the{" "}
          <button type="button" className="synth-link" onClick={() => setView("execution")}>
            Execution
          </button>{" "}
          tab.
        </div>
      )}
      {status && (status.unresolved_intents > 0 || status.quarantined_count > 0) && (
        <div className="banner banner--error">
          <strong>Unproven live orders.</strong> {status.unresolved_intents} order(s) unresolved, {status.quarantined_count} position(s)
          quarantined. Nothing automatic happens to a quarantined position: reconcile it with the broker in the{" "}
          <button type="button" className="synth-link" onClick={() => setView("execution")}>
            Execution
          </button>{" "}
          tab.
        </div>
      )}
      {status && status.residual_count > 0 && (
        <div className="banner banner--warn">
          <strong>{status.residual_count} incomplete position(s).</strong> A partial entry or exit left legs that are not a full
          synthetic; their outstanding legs are being flattened, risk-reducing first. See{" "}
          <button type="button" className="synth-link" onClick={() => setView("open")}>
            Open trades
          </button>
          .
        </div>
      )}
      {status?.execution_mode === "live" && status.live_orders && (
        <div className="banner banner--error">
          <strong>LIVE and armed.</strong> Confirmed entries send real LIMIT orders to {BROKER_LABEL[status.broker] ?? status.broker}.
        </div>
      )}
      {status && !status.authenticated && (
        <div className="banner banner--warn">
          <strong>No usable {BROKER_LABEL[status.broker] ?? "broker"} session.</strong> Connect it in the{" "}
          <button type="button" className="synth-link" onClick={() => setView("brokers")}>
            Brokers
          </button>{" "}
          tab, or switch the scanner to the other broker.
        </div>
      )}
      {status && !status.store_ready && (
        <div className="banner banner--warn">
          <strong>Storage not ready.</strong> Saved settings and trades are loading from PostgreSQL; entries and
          setting changes wait for it.
        </div>
      )}
      {status && status.unlinked_positions > 0 && (
        <div className="banner banner--warn">
          {status.unlinked_positions} open position(s) are not yet resolved on the active broker, so they cannot be priced
          or closed. They re-link automatically.
        </div>
      )}
      {status && marketOpen && (running || status.open_count > 0) && !status.feed_healthy && (
        <div className="banner banner--error">
          <strong>Feed stale.</strong> No tick for{" "}
          {status.feed_age_ms === null ? "some time" : `${(status.feed_age_ms / 1000).toFixed(1)}s`}
          {status.feed_error ? ` (${status.feed_error})` : ""}. Entries and automatic exits pause until it recovers.
        </div>
      )}
      {status && !marketOpen && (running || status.open_count > 0) && (
        <div className="banner banner--warn">
          <strong>Market closed.</strong> Figures use last traded prices
          {status.close_session_day ? ` from ${status.close_session_day}` : ""}. Nothing is entered or exited until the
          market reopens.
        </div>
      )}
      {status && !status.calendar_covered && (
        <div className="banner banner--warn">The NSE holiday calendar does not cover this year, so no new entries are taken.</div>
      )}

      <section className="synth-controls" aria-label="Quick controls">
        <div className="synth-control" role="group" aria-label="Strike window">
          <span className="synth-control-k">ATM ±</span>
          {[1, 2, 3, 4, 5].map((lvl) => (
            <Button
              key={lvl}
              size="sm"
              variant={strikeLevel === lvl ? "primary" : "secondary"}
              aria-pressed={strikeLevel === lvl}
              disabled={busy || !settings}
              onClick={() => strikeLevel !== lvl && quick("strike_level", lvl)}
            >
              {lvl}
            </Button>
          ))}
        </div>
        <label className="synth-control">
          <span className="synth-control-k">Broker</span>
          <select
            className="synth-select"
            value={brokerSetting}
            disabled={busy || !settings}
            onChange={(e) => quick("broker", e.target.value)}
          >
            {(["zerodha", "dhan"] as const).map((b) => {
              const s = brokers.find((x) => x.broker === b);
              return (
                <option key={b} value={b}>
                  {BROKER_LABEL[b]}
                  {s ? (s.connected ? " ✓" : " (not connected)") : ""}
                </option>
              );
            })}
          </select>
        </label>
        <label className="synth-control">
          <span className="synth-control-k">Execution</span>
          <select
            className="synth-select"
            value={mode}
            disabled={busy || !settings}
            title="How decisions become fills (confirmed first). Live also needs the server's consent and an ARM."
            onChange={(e) => quick("execution_mode", e.target.value)}
          >
            {(byKey.get("execution_mode")?.options ?? ["paper_touch"]).map((m) => (
              <option key={m} value={m} disabled={m === "live" && execView !== null && !execView.live.permitted}>
                {MODE_LABEL[m as SynthExecutionMode] ?? m}
                {m === "live" && execView !== null && !execView.live.permitted ? " (not permitted by the server)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="synth-control">
          <span className="synth-control-k">Lots</span>
          <select
            className="synth-select"
            value={lots}
            disabled={busy || !settings}
            onChange={(e) => quick("lots_per_trade", Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="synth-control">
          <span className="synth-control-k">Auto entry</span>
          <button
            type="button"
            role="switch"
            aria-checked={autoEntry}
            aria-label="Automatic entries"
            className={`synth-toggle${autoEntry ? " is-on" : ""}`}
            disabled={busy || !settings}
            onClick={() => quick("auto_entry", !autoEntry)}
          />
        </div>
        <div className="synth-control">
          <span className="synth-control-k">Auto exit</span>
          <button
            type="button"
            role="switch"
            aria-checked={autoExit}
            aria-label="Automatic rule exits"
            className={`synth-toggle${autoExit ? " is-on" : ""}`}
            disabled={busy || !settings}
            onClick={() => quick("auto_exit", !autoExit)}
          />
        </div>
        <span className="synth-controls-note">Every change is saved on the server. More in Settings.</span>
      </section>

      <section className="synth-strip">
        <Stat k="Broker" v={status ? BROKER_LABEL[status.broker] ?? "-" : "-"} />
        <Stat
          k="Underlyings"
          v={status ? `${status.monitored_underlyings} / ${status.paired_underlyings}` : "-"}
          title={status ? `Watched / paired. ${status.skipped_for_budget} left out by the token budget.` : undefined}
        />
        <Stat k="Tokens" v={status ? `${status.subscribed_tokens} / ${status.token_budget}` : "-"} title={status ? `Books received: ${status.ready_books}` : undefined} />
        <Stat k="Open" v={status ? `${status.open_count} / ${status.max_open_positions > 0 ? status.max_open_positions : "no limit"}` : "-"} />
        <Stat k="Eligible" v={status ? String(status.eligible_count) : "-"} />
        <Stat k="Net gate" v={fmtMoney(Number(byKey.get("min_expected_net_profit")?.value ?? NaN))} />
        <Stat k="Safety" v={fmtMoney(Number(byKey.get("safety_buffer")?.value ?? NaN))} />
        <Stat k="Carry" v={byKey.get("include_carry")?.value === true ? `${String(byKey.get("rf_pct")?.value ?? 0)}%` : "off"} />
      </section>

      <SynthDayPnlStrip dayPnl={status?.day_pnl} />

      <nav className="synth-tabs" role="tablist" aria-label="Synthetic view">
        {tabs.map(([v, text, count, badge]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            className="synth-tab"
            onClick={() => {
              setView(v);
              if (v === "history") void loadHistory("today").then(() => loadHistory("all"));
              if (v === "brokers") void loadBrokers();
              if (v === "execution") void loadExecution();
            }}
          >
            <span>{text}</span>
            <span className="synth-tab-count">{count}</span>
            {badge > 0 && <span className="synth-badge">{badge}</span>}
          </button>
        ))}
        {view === "history" && history.length > 0 && (
          <span className="synth-tabs-total">
            <span className={pnlClass(closedNet)}>Net {fmtMoney(closedNet)}</span>
          </span>
        )}
      </nav>

      {view === "opportunities" && <SynthOpportunities rows={opps} running={running} strikeLevel={strikeLevel} />}
      {view === "open" && (
        <SynthOpenCards
          positions={open}
          closingId={closingId}
          busy={busy}
          onClose={(id) => void handleClose(id)}
          onCloseAll={() => setConfirmCloseAll(true)}
          onDelete={(t) => {
            setDeleteError(null);
            setDeleteTarget(t);
          }}
        />
      )}
      {view === "history" && (
        <SynthClosedHistory
          trades={history}
          loading={historyLoading}
          error={historyError}
          onDelete={(t) => {
            setDeleteError(null);
            setDeleteTarget(t);
          }}
        />
      )}
      {view === "execution" && (
        <SynthExecution
          view={execView}
          settings={settings}
          busy={busy}
          error={execError}
          onRequestChange={requestChange}
          onArm={onArm}
          onDisarm={onDisarm}
          onResetBreaker={onResetBreaker}
          onReconcile={onReconcile}
          onOpenSettings={() => setView("settings")}
        />
      )}
      {view === "brokers" && (
        <SynthBrokerPanel
          brokers={brokers}
          activeBroker={status?.broker ?? ""}
          busy={busy}
          onChanged={onBrokersChanged}
          onUse={(b) => quick("broker", b)}
        />
      )}
      {view === "settings" && (
        <SynthSettingsPanel settings={settings} busy={busy} onRequestChange={requestChange} onReload={() => void loadSettings()} />
      )}

      {pendingChange && (
        <Modal title="Confirm a risk setting" onClose={() => setPendingChange(null)}>
          <p>
            <strong>{pendingChange.setting.label}</strong>: {formatSettingValue(pendingChange.setting, pendingChange.setting.value)} →{" "}
            <strong>{formatSettingValue(pendingChange.setting, pendingChange.value)}</strong>
          </p>
          <p className="synth-dim">{pendingChange.setting.help}</p>
          <div className="synth-modal-actions">
            <Button variant="quiet" onClick={() => setPendingChange(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                const p = pendingChange;
                setPendingChange(null);
                void submitChange(p.setting, p.value);
              }}
            >
              Apply
            </Button>
          </div>
        </Modal>
      )}

      {confirmCloseAll && (
        <Modal title="Close every open position?" onClose={() => setConfirmCloseAll(false)}>
          <p>
            paper_touch positions close at the current executable touch; a position whose legs do not show the full quantity
            there is held and reported, never filled at an invented price. Every other position is closed through its own
            execution mode, risk-reducing first{open.some((p) => p.execution_mode === "live") ? " — live positions with REAL orders" : ""};
            a quarantined position is skipped until it is reconciled.
          </p>
          <div className="synth-modal-actions">
            <Button variant="quiet" onClick={() => setConfirmCloseAll(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void handleCloseAll()}>
              Close all
            </Button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title={`Delete ${isPaperMode(deleteTarget.execution_mode) ? "paper" : "live"} trade on ${deleteTarget.underlying}?`}
          subtitle={`${deleteTarget.direction} · K ${deleteTarget.strike} · ${deleteTarget.status}`}
          onClose={() => !deleting && setDeleteTarget(null)}
          dismissible={!deleting}
        >
          <p>
            It leaves every list, P&amp;L and margin figure{deleteTarget.status === "open" ? " and stops being monitored" : ""}.
            It is kept on the server as an audit record.
          </p>
          <label className="synth-field">
            <span>Reason (optional)</span>
            <input className="synth-input" value={deleteReason} maxLength={500} onChange={(e) => setDeleteReason(e.target.value)} />
          </label>
          {deleteError && <div className="banner banner--error">{deleteError}</div>}
          <div className="synth-modal-actions">
            <Button variant="quiet" disabled={deleting} onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
