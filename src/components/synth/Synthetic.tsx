/**
 * The Synthetic workspace: futures vs synthetic futures (K + CE − PE), paper trading.
 *
 * The Go service (gts-synth) is the authority on everything this page shows: eligibility, fills,
 * P&L, what a setting may be. This component renders its snapshot and sends the operator's
 * controls back to it. Almost every knob is a runtime setting, changed here, saved on the server.
 *
 * Nothing on this page can place a real order: the service has no order-placement code, and the
 * header says PAPER from `status.live_orders === false`, not from an assumption.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LockKeyIcon, SquaresFourIcon } from "@phosphor-icons/react";
import GTSWordmark from "../brand/GTSWordmark.tsx";
import StatusBadge from "../ui/StatusBadge.tsx";
import Button from "../ui/Button.tsx";
import Modal from "../ui/Modal.tsx";
import ThemeToggle from "../../ThemeToggle.tsx";
import { navigate } from "../../app/router.ts";
import { ROUTE_PATHS } from "../../lib/routing.ts";
import { ReconnectingBoxStream } from "../../lib/boxStream.ts";
import { accessStatus } from "../../api/access.ts";
import { ApiError, describeRequestFailure } from "../../api/http.ts";
import { fmtMoney } from "../../format.ts";
import {
  closeAllSynthTrades,
  closeSynthTrade,
  deleteSynthTrade,
  fetchSynthHistory,
  fetchSynthOpen,
  fetchSynthOpportunities,
  fetchSynthSettings,
  patchSynthSettings,
  startSynth,
  stopSynth,
  synthStreamUrl,
  type SynthOpenPosition,
  type SynthOpportunity,
  type SynthSetting,
  type SynthSettingValue,
  type SynthSettings,
  type SynthSnapshot,
  type SynthStatus,
  type SynthTrade,
} from "../../api/synth.ts";
import { BROKER_MODE_LABEL, formatSettingValue, mergeClosed, pnlClass } from "../../lib/synthView.ts";
import SynthOpportunities from "./SynthOpportunities.tsx";
import { SynthClosedHistory, SynthDayPnlStrip, SynthOpenCards } from "./SynthPositions.tsx";
import SynthSettingsPanel from "./SynthSettingsPanel.tsx";

type View = "opportunities" | "open" | "history" | "settings";

interface PendingChange {
  setting: SynthSetting;
  value: SynthSettingValue;
}

function Stat({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="box-stat" title={title}>
      <span className="box-stat-k">{k}</span>
      <span className="box-stat-v">{v}</span>
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
  const pendingSnap = useRef<SynthSnapshot | null>(null);
  const deletedIds = useRef<Set<string>>(new Set());

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
    fetchSynthOpportunities()
      .then((r) => {
        setStatus(r.status);
        setOpps(r.opportunities);
      })
      .catch((err) => setError(describeRequestFailure(err)));
    fetchSynthOpen()
      .then((o) => setOpen(o))
      .catch(() => {
        /* the stream carries them too */
      });
    void loadSettings();
    void loadHistory("today");
  }, [loadSettings, loadHistory]);

  // Another tab (or operator) changed the settings: reload them, so this page never edits a
  // stale version (the server would refuse with 409 anyway).
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
    const stream = new ReconnectingBoxStream({
      url: synthStreamUrl(),
      events: ["snapshot", "entry", "exit", "trade_deleted", "session_ended"],
      onOpen: () => setLive(true),
      onDisconnect: () => setLive(false),
      probeUnauthorized: async () => {
        try {
          return !(await accessStatus()).authenticated;
        } catch {
          return true;
        }
      },
      onUnauthorized: () => setLive(false),
      onEvent: (type, data) => {
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
  }, []);

  /* --------------------------------- actions -------------------------------- */

  async function run<T>(fn: () => Promise<T>, ok: (v: T) => string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const v = await fn();
      setNotice(ok(v));
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
          ? "Scanner running. Confirmed ELIGIBLE opportunities are paper-traded when auto-entry is on."
          : "Scanner stopped. No new entries; open paper positions stay monitored under the exit rules.",
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

  /** Risk settings are confirmed first; the server accepts either way, so this is for the operator. */
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
      setHistory((prev) => mergeClosed(prev, [r.trade], deletedIds.current));
      setNotice(
        `Closed at the touch: gross ${fmtMoney(r.trade.gross_pnl)}, charges ${fmtMoney(r.trade.total_charges)}, net ${fmtMoney(r.trade.net_pnl)} after charges.`,
      );
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
        const failed = r.results.filter((x) => !x.closed);
        return failed.length === 0
          ? `Closed ${done} position(s) at the touch.`
          : `Closed ${done}; ${failed.length} held: ${failed.map((f) => `${f.underlying} (${f.error})`).join("; ")}`;
      },
    );
  }

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
          : `Paper trade on ${t.underlying} deleted; P&L and margin were recalculated.`,
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

  /* ---------------------------------- view ---------------------------------- */

  const marketOpen = status?.market_open ?? true;
  const strikeLevel = status?.strike_level ?? 3;
  const brokerMode = String(byKey.get("broker")?.value ?? status?.broker_mode ?? "follow_active");
  const autoEntry = byKey.get("auto_entry")?.value === true;
  const autoExit = byKey.get("auto_exit")?.value === true;
  const lots = Number(byKey.get("lots_per_trade")?.value ?? 1);
  const exitEligible = open.filter((p) => p.exit_eligible).length;
  const closedNet = history.reduce((s, t) => s + (t.net_pnl ?? 0), 0);
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

  return (
    <div className="gts-workspace synth-page">
      <header className="gts-workbar">
        <div className="gts-workbar-identity">
          <GTSWordmark
            variant="product"
            markSize={20}
            subtitle={<span className="gts-workbar-sub">Synthetic · K + CE − PE · paper</span>}
          />
        </div>
        <div className="gts-workbar-state">
          <StatusBadge
            tone={status?.live_orders ? "negative" : "info"}
            title="Fills are simulated at the observed touch. The synthetic service has no order-placement code."
          >
            {status?.live_orders ? "LIVE" : "PAPER"}
          </StatusBadge>
          <StatusBadge tone={stateTone} announce>
            {stateText}
          </StatusBadge>
          {status && (
            <StatusBadge
              tone={status.authenticated ? "positive" : "negative"}
              title={status.authenticated ? "Broker session is usable" : `Broker not connected (${status.auth_reason ?? "unknown"})`}
            >
              {(status.broker || "no broker").toUpperCase()}
              {status.authenticated ? "" : " · not connected"}
            </StatusBadge>
          )}
        </div>
        <div className="gts-workbar-session">
          <Button variant="quiet" onClick={() => navigate(ROUTE_PATHS.box)} title="Go to the Box workspace">
            <SquaresFourIcon size={16} weight="regular" aria-hidden="true" />
            <span>Box</span>
          </Button>
          <ThemeToggle />
          <Button variant="quiet" onClick={onLock} aria-label="Lock workspace" title="End this session">
            <LockKeyIcon size={16} weight="regular" aria-hidden="true" />
            <span>Lock</span>
          </Button>
        </div>
        <div className="gts-workbar-command">
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
      {status && !status.authenticated && (
        <div className="banner banner--warn">
          <strong>No usable {status.broker || "broker"} session.</strong> Connect the broker from the Box page (the
          synthetic service reads the same session), or pick the other broker below.
        </div>
      )}
      {status && !status.store_ready && (
        <div className="banner banner--warn">
          <strong>Storage not ready.</strong> Saved settings and paper trades are loading from PostgreSQL; entries and
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
        <div className="banner banner--warn">
          The NSE holiday calendar does not cover this year, so no new entries are taken.
        </div>
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
            className="cfg-select"
            value={brokerMode}
            disabled={busy || !settings}
            onChange={(e) => quick("broker", e.target.value)}
          >
            {["follow_active", "zerodha", "dhan"].map((b) => (
              <option key={b} value={b}>
                {BROKER_MODE_LABEL[b]}
                {b !== "follow_active" && status?.brokers?.[b as "zerodha" | "dhan"]
                  ? status.brokers[b as "zerodha" | "dhan"]!.connected
                    ? " ✓"
                    : " (not connected)"
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="synth-control">
          <span className="synth-control-k">Lots</span>
          <select
            className="cfg-select"
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
            className={`cfg-toggle${autoEntry ? " is-on" : ""}`}
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
            className={`cfg-toggle${autoExit ? " is-on" : ""}`}
            disabled={busy || !settings}
            onClick={() => quick("auto_exit", !autoExit)}
          />
        </div>
        <span className="synth-controls-note">Every change is saved on the server. More in Settings.</span>
      </section>

      <section className="box-strip">
        <Stat k="Broker" v={status ? `${status.broker || "-"}${status.broker_mode === "follow_active" ? " (follows Box)" : ""}` : "-"} />
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
        <Stat
          k="Carry"
          v={byKey.get("include_carry")?.value === true ? `${String(byKey.get("rf_pct")?.value ?? 0)}%` : "off"}
        />
      </section>

      <SynthDayPnlStrip dayPnl={status?.day_pnl} />

      <nav className="box-views" role="tablist" aria-label="Synthetic view">
        {(
          [
            ["opportunities", "Opportunities", status?.opportunity_count ?? opps.length, status?.eligible_count ?? 0],
            ["open", "Open trades", open.length, exitEligible],
            ["history", "Closed trades", history.length, 0],
            ["settings", "Settings", settings?.settings.length ?? 0, 0],
          ] as const
        ).map(([v, text, count, badge]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            className="box-view-tab"
            onClick={() => {
              setView(v);
              if (v === "history") void loadHistory("today").then(() => loadHistory("all"));
            }}
          >
            <span className="box-view-tab-label">{text}</span>
            <span className="pill-count">{count}</span>
            {badge > 0 && <span className="synth-badge">{badge}</span>}
          </button>
        ))}
        {view === "history" && history.length > 0 && (
          <span className="box-views-total">
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
      {view === "settings" && (
        <SynthSettingsPanel settings={settings} busy={busy} onRequestChange={requestChange} onReload={() => void loadSettings()} />
      )}

      {pendingChange && (
        <Modal title="Confirm a risk setting" onClose={() => setPendingChange(null)}>
          <p>
            <strong>{pendingChange.setting.label}</strong>:{" "}
            {formatSettingValue(pendingChange.setting, pendingChange.setting.value)} →{" "}
            <strong>{formatSettingValue(pendingChange.setting, pendingChange.value)}</strong>
          </p>
          <p className="box-dim">{pendingChange.setting.help}</p>
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
        <Modal title="Close every open paper position?" onClose={() => setConfirmCloseAll(false)}>
          <p>
            Each position is closed at the current executable touch. A position whose legs do not show the full quantity
            at the touch is held and reported, never filled at an invented price.
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
          title={`Delete paper trade on ${deleteTarget.underlying}?`}
          subtitle={`${deleteTarget.direction} · K ${deleteTarget.strike} · ${deleteTarget.status}`}
          onClose={() => !deleting && setDeleteTarget(null)}
          dismissible={!deleting}
        >
          <p>
            It leaves every list, P&amp;L and margin figure
            {deleteTarget.status === "open" ? " and stops being monitored" : ""}. It is kept on the server as an audit
            record.
          </p>
          <label className="synth-field">
            <span>Reason (optional)</span>
            <input
              className="cfg-input"
              value={deleteReason}
              maxLength={500}
              onChange={(e) => setDeleteReason(e.target.value)}
            />
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
