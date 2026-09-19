/**
 * THE CONFIGURATION AREA — a dedicated surface inside the protected Box workspace.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A NEW COMPONENT AND NOT MORE OF `Box.tsx`
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `Box.tsx` is already ~100 KB. Adding a fifty-field form to it would make the largest file in the
 * repository larger and put a risk-limit editor inside a component nobody can review in one sitting.
 * This follows `ControlBox`'s own precedent instead: a container that owns the tab, the fetch and the
 * pending confirmation, and delegates each row to `SettingRow`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS COMPONENT OWNS, AND WHAT IT DELIBERATELY DOES NOT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It owns exactly three things: which tab is open, the version-aware view state, and the pending
 * confirmation. Every DECISION — is this risk-increasing, may this be submitted, what does the
 * confirmation say, which version are we editing — lives in `src/lib/operatorConfig.ts` and is
 * unit-tested there. This file is wiring, because a risk surface whose logic is trapped inside JSX
 * cannot be tested, and the harness here cannot render JSX at all.
 *
 * SINGLE-FLIGHT uses the EXISTING `ControlRequests`/`runOnce` from `lib/statusIntegrity.ts`, under its
 * own `"configuration"` class. Reimplementing a guard is how a refactor of a safety surface introduces
 * a double-submit — the same reason `ControlBox` refuses to hoist its children's busy state. A
 * configuration PATCH carries an optimistic-concurrency version, so two concurrent writes would have
 * the second refused as stale and the operator would see a spurious failure for one intent.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * STALENESS IS VISIBLE, AND BLOCKS WRITES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A failed refresh keeps the numbers (blanking a risk screen over one dropped request would be worse)
 * but marks them stale and disables every control. A stale view's version is by definition possibly
 * behind the backend, so a PATCH from it would either be refused as stale or — worse, if the version
 * still happens to match — be based on values the operator has not seen.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ControlRequests, runOnce } from "../../../lib/statusIntegrity.ts";
import { fetchOperatorConfig, patchOperatorConfig } from "../../../api/operatorConfig.ts";
import {
  canSubmit,
  describeChange,
  editingVersion,
  groupByCategory,
  lockedCount,
  needsConfirmation,
  onConfigFailed,
  onConfigLoaded,
  startingValue,
  type ChangeSummary,
  type ConfigViewState,
  type OperatorConfig,
  type OperatorSetting,
  type SettingValue,
} from "../../../lib/operatorConfig.ts";
import { SettingRow } from "./SettingRow.tsx";
import { DangerousChangeModal } from "./DangerousChangeModal.tsx";
import { DeploymentFacts } from "./DeploymentFacts.tsx";

type Tab = "overview" | "strategy" | "risk" | "market_data" | "paper" | "universe" | "charges" | "advanced";

interface PendingChange {
  readonly setting: OperatorSetting;
  readonly next: SettingValue;
  readonly summary: ChangeSummary;
}

export function ConfigurationPanel({ canTrade }: { canTrade: boolean }) {
  const [state, setState] = useState<ConfigViewState>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("overview");
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // One guard instance for the life of the panel, exactly as BoxExecutionControl does.
  const requests = useRef(new ControlRequests());

  // Tracks the newest request so a late response cannot overwrite a newer one even before the version
  // check sees it. The version check in `onConfigLoaded` is the real defence; this avoids a pointless
  // re-render from a straggler.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const config = await fetchOperatorConfig();
      if (mine !== seq.current) return;
      setState((prev) => onConfigLoaded(prev, config));
    } catch (error) {
      if (mine !== seq.current) return;
      setState((prev) => onConfigFailed(prev, error instanceof Error ? error.message : "Unknown error"));
    }
  }, []);

  useEffect(() => {
    if (!canTrade) return;
    void refresh();
  }, [canTrade, refresh]);

  // DECLARED BEFORE `requestChange`, which calls it.
  //
  // The reverse order needed an eslint-disable to suppress exhaustive-deps, and that suppression was
  // hiding a real fragility rather than a lint quibble: `requestChange` closes over whichever `submit`
  // existed in its render, so the two staying in step depended on their dependency lists happening to
  // change together. Declaring `submit` first lets it be a genuine dependency and the compiler keep
  // them consistent.
  const submit = useCallback(
    async (setting: OperatorSetting, next: SettingValue) => {
      const version = editingVersion(state);
      if (version === null || !canSubmit(state)) {
        setNotice("The configuration shown may be out of date. Refresh before changing anything.");
        return;
      }

      setBusy(true);
      const outcome = await runOnce(requests.current, "configuration", () =>
        patchOperatorConfig({ version, changes: { [setting.key]: next } }),
      );
      setBusy(false);
      setPending(null);

      if (!outcome.sent) {
        setNotice(outcome.reason);
        return;
      }

      const result = outcome.result;
      if (result.outcome === "applied") {
        setState((prev) => onConfigLoaded(prev, result.config));
        setNotice(null);
        return;
      }

      // REFUSED. Show the backend's own reasons verbatim, and resynchronise: the refusal carries the
      // current authoritative version, so a stale write is followed by a re-read rather than a retry.
      setNotice(result.refusal.problems.map((p) => p.message).join(" "));
      if (result.refusal.reason === "stale_version") void refresh();
    },
    [state, refresh],
  );

  /** A row asked to change something. Confirm first when the change warrants it. */
  const requestChange = useCallback(
    (setting: OperatorSetting, next: SettingValue) => {
      setNotice(null);
      const current = startingValue(setting);
      if (current === next) return;
      const summary = describeChange(setting, current, next);
      if (needsConfirmation(setting, current, next)) {
        setPending({ setting, next, summary });
        return;
      }
      void submit(setting, next);
    },
    [submit],
  );

  if (!canTrade) return null;

  if (state.kind === "loading") {
    return <section className="cfg"><p className="cfg-loading">Loading configuration…</p></section>;
  }

  if (state.kind === "failed") {
    // UNKNOWN, and shown as unknown. Never an empty form that reads as "nothing is configured".
    return (
      <section className="cfg">
        <div className="banner banner--warn">
          The configuration could not be read ({state.error}). No values are shown, because showing
          defaults here would look like the deployment's actual settings.
        </div>
        <button type="button" className="btn" onClick={() => void refresh()}>
          Retry
        </button>
      </section>
    );
  }

  const config = state.config;

  // NARROWED ONCE, HERE, rather than tested again at each use.
  //
  // `ConfigViewState` carries `error` only on the `stale: true` member, so a boolean local does not
  // give the compiler permission to read `state.error` later in the JSX — the discriminant has to be
  // tested where the property is accessed. Resolving it to `string | null` in one place keeps the
  // render readable and keeps the two facts ("is it stale" and "why") from drifting apart.
  const staleError = state.stale === true ? state.error : null;
  const stale = staleError !== null;
  const groups = groupByCategory(config.settings);
  const readOnly = stale || busy;

  const TABS: { id: Tab; label: string; flag: string | null }[] = [
    { id: "overview", label: "Overview", flag: null },
    ...groups.map((g) => {
      const locked = lockedCount(g.settings);
      return { id: g.category as Tab, label: g.label, flag: locked > 0 ? String(locked) : null };
    }),
    { id: "advanced", label: "Deployment", flag: null },
  ];

  const activeGroup = groups.find((g) => g.category === tab);

  return (
    <section className="cfg">
      {/* THE HEADLINE, OUTSIDE THE TABS, following ControlBox's rule: the state that must never be
          hidden behind a tab is rendered in the header. */}
      <header className="cfg-head">
        <h3 className="cfg-title">Configuration</h3>
        <div className="cfg-headline">
          <span className="cfg-headline-k">Mode</span>
          <span className={`cfg-headline-v ${config.deployment.live_capable ? "is-warn" : "is-good"}`}>
            {config.deployment.live_capable ? "LIVE-CAPABLE" : "PAPER"}
          </span>
          <span className="cfg-headline-k">Session</span>
          <span className="cfg-headline-v">{config.state.session_armed ? "ARMED" : "IDLE"}</span>
          <span className="cfg-headline-k">Exposure</span>
          <span className="cfg-headline-v">{config.state.flat ? "FLAT" : "OPEN"}</span>
          <span className="cfg-headline-k">Version</span>
          <span className="cfg-headline-v">{config.version}</span>
        </div>
      </header>

      {stale && (
        <div className="banner banner--warn">
          These values may be out of date — the last refresh failed ({staleError}). Changes are
          disabled until a refresh succeeds.{" "}
          <button type="button" className="btn btn--sm" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}

      {notice !== null && <div className="banner banner--warn">{notice}</div>}

      <div className="cfg-tabs" role="tablist" aria-label="Configuration sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className="box-view-tab cfg-tab"
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.flag !== null && <span className="cfg-tab-flag">{t.flag}</span>}
          </button>
        ))}
      </div>

      <div className="cfg-body" role="tabpanel">
        {tab === "overview" && <OverviewTab config={config} />}

        {tab === "advanced" && <DeploymentFacts config={config} />}

        {activeGroup !== undefined &&
          activeGroup.settings.map((s) => (
            <SettingRow key={s.key} setting={s} disabled={readOnly} onRequestChange={requestChange} />
          ))}
      </div>

      {config.recent_changes.length > 0 && (
        <details className="cfg-history">
          <summary>Recent configuration changes ({config.recent_changes.length})</summary>
          <ul>
            {config.recent_changes.map((c, i) => (
              <li key={`${c.changed_at}-${c.setting_key}-${i}`}>
                <time dateTime={c.changed_at}>{new Date(c.changed_at).toLocaleString("en-IN")}</time>{" "}
                <strong>{c.setting_key}</strong>{" "}
                {String(c.previous_effective_value)} → {String(c.new_effective_value)}{" "}
                <span className="cfg-history-actor">by {c.actor_role ?? "unknown"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <DangerousChangeModal
        summary={pending?.summary ?? null}
        busy={busy}
        onConfirm={() => {
          if (pending !== null) void submit(pending.setting, pending.next);
        }}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}

/** The at-a-glance state an operator checks before changing anything. */
function OverviewTab({ config }: { config: OperatorConfig }) {
  const rows: { k: string; v: string; warn?: boolean }[] = [
    { k: "Execution mode", v: config.deployment.execution_mode.replace(/_/g, " ") },
    {
      k: "Live capability",
      v: config.deployment.live_capable ? "Real orders are possible" : "No order reaches any broker",
      warn: config.deployment.live_capable,
    },
    { k: "Active broker", v: config.deployment.active_broker ?? "—" },
    { k: "Entry", v: config.state.entry_armed ? "ARMED" : "DISARMED", warn: config.state.entry_armed },
    { k: "Trading session", v: config.state.session_armed ? "ARMED" : "IDLE" },
    { k: "Open Boxes", v: String(config.state.open_boxes) },
    { k: "Residual legs", v: String(config.state.residual_legs) },
    { k: "Working orders", v: String(config.state.working_orders) },
    {
      k: "Reconciliation",
      v: config.state.reconciliation_clean ? "Clean" : "Pending",
      warn: !config.state.reconciliation_clean,
    },
    { k: "Flat", v: config.state.flat ? "Yes" : "No" },
    { k: "Your role", v: config.operator_role ?? "unknown" },
  ];

  return (
    <dl className="cfg-overview">
      {rows.map((r) => (
        <div key={r.k}>
          <dt>{r.k}</dt>
          <dd className={r.warn === true ? "is-warn" : undefined}>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}
