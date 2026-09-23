/**
 * ONE CONTROL BOX — the single place an operator sees and changes what the engine will do.
 *
 * WHAT WAS WRONG
 *
 * Nothing was missing from this page; everything was *scattered and duplicated*. `BoxExecutionControl`,
 * `BoxSessionControl`, `BoxRiskControl` and `BoxGates` were four sibling `<section>`s stacked down the
 * page with unrelated banners interleaved between them, and the same parameters appeared a third time
 * in the read-only status strip and a fourth time inside the help modal's Params tables. An operator
 * looking for "what is armed, and what will it risk?" had to scroll past three screens and hold the
 * answer in their head.
 *
 * WHAT THIS IS
 *
 * A container, and deliberately nothing more. It re-parents the EXISTING panels into one framed
 * section with a tab strip, so each concern is one click away instead of one scroll away. It owns no
 * state that matters, makes no API calls, and does not reimplement a single control:
 *
 *   - every panel keeps its own `busy`/`error` state and its own `runOnce`/`ControlRequests`
 *     single-flight guard. Hoisting those here would have meant reimplementing them, which is exactly
 *     how a refactor of a safety surface introduces a double-submit;
 *   - the props are passed straight through, unchanged;
 *   - the only local state is which tab is open.
 *
 * WHY A TAB STRIP RATHER THAN ACCORDIONS OR A GRID
 *
 * These four groups are read at different moments. Execution and Session are read while arming;
 * Universe while choosing what to watch; Risk and Thresholds while deciding how much. Showing all
 * four at once is what produced the wall of text in the first place, and an accordion that can be
 * fully collapsed can hide an armed state — which is the one thing this surface must never do.
 *
 * Hence the two rules the tab strip follows:
 *   1. THE HEADLINE STAYS VISIBLE ON EVERY TAB. Mode, entry state and armed session are rendered in
 *      the header, outside the tab body, so "is this live and armed?" can never be behind a tab.
 *   2. A TAB THAT NEEDS ATTENTION SAYS SO on its own label — an unreadable blocklist is refusing all
 *      entry, and that must be visible without opening the Universe tab to find out.
 */

import { useState } from "react";
import { BoxExecutionControl } from "../../BoxExecutionControl.tsx";
import { BoxSessionControl } from "../../BoxSessionControl.tsx";
import { BoxRiskControl } from "../../BoxRiskControl.tsx";
import { BoxGates } from "../../BoxGates.tsx";
import { BoxExclusions } from "../../BoxExclusions.tsx";
import { UniversePicker } from "./UniversePicker.tsx";
import { ConfigurationPanel } from "./configuration/ConfigurationPanel.tsx";
import type {
  BoxConfigView,
  BoxExcludedUnderlyings,
  BoxExecutionControl as BoxExecutionControlView,
  BoxStatus,
} from "../../api";

type Tab = "execution" | "session" | "universe" | "risk" | "configuration";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "execution", label: "Execution", hint: "Mode, live arming and pacing" },
  { id: "session", label: "Session", hint: "How many box lifecycles are authorised" },
  { id: "universe", label: "Universe", hint: "Which underlyings may be entered" },
  { id: "risk", label: "Risk & gates", hint: "Caps, and the thresholds a box must clear" },
  // The CONFIGURATION tab, added last so the four existing tabs keep their positions and an operator's
  // muscle memory is unaffected. It is a peer rather than a replacement: the panels above are the
  // moment-to-moment controls (run, arm, exclude), while this one is the persisted policy underneath
  // them. Folding the two together is what produced the wall of text this container was built to fix.
  { id: "configuration", label: "Configuration", hint: "Persisted strategy, risk and market-data policy" },
];

export function ControlBox({
  control,
  cfg,
  status,
  blocklist,
  canTrade,
  isFullAdmin,
  executionError,
  pricesStale,
  onControlChanged,
  onSettingsSaved,
  onBlocklistChanged,
}: {
  control: BoxExecutionControlView | undefined;
  cfg: BoxConfigView | undefined;
  status: BoxStatus | null;
  blocklist: BoxExcludedUnderlyings | undefined;
  canTrade: boolean;
  isFullAdmin: boolean;
  executionError: string | null;
  /**
   * True when the SSE snapshot driving the page has gone stale. Threaded down to
   * `BoxExecutionControl`, which uses it to block ARMING entry only — never any reduction.
   */
  pricesStale?: boolean;
  onControlChanged: () => void;
  onSettingsSaved: (next: { config: BoxConfigView; status: BoxStatus }) => void;
  onBlocklistChanged: (next: BoxExcludedUnderlyings) => void;
}) {
  const [tab, setTab] = useState<Tab>("execution");

  if (!canTrade) return null;

  // ATTENTION MARKERS. Each is a state an operator must not have to open a tab to discover.
  // `readable === false` is the sharp one: the backend is refusing ALL new entry.
  const blocklistBroken = blocklist !== undefined && !blocklist.readable;
  const excludedCount = blocklist?.excluded.length ?? 0;
  const attention: Record<Tab, string | null> = {
    execution: executionError === null ? null : "!",
    session: null,
    universe: blocklistBroken ? "!" : excludedCount > 0 ? String(excludedCount) : null,
    risk: null,
    // The panel owns its own staleness and locked-setting markers, because only it has fetched the
    // configuration. Surfacing them here would need this container to duplicate that fetch.
    configuration: null,
  };

  return (
    <section className="box-controlbox">
      <header className="box-controlbox-h">
        <h2 className="box-controlbox-title">Controls</h2>
        {/* THE HEADLINE, OUTSIDE THE TABS. Never hidden by the active tab. */}
        <div className="box-controlbox-headline">
          <span className="box-controlbox-headline-k">Mode</span>
          <span className="box-controlbox-headline-v">
            {(status?.execution_mode ?? "unknown").replace(/_/g, " ").toUpperCase()}
          </span>
          <span className="box-controlbox-headline-k">Entry</span>
          <span
            className={`box-controlbox-headline-v ${control?.entry_enabled ? "is-good" : "is-warn"}`}
          >
            {control === undefined ? "—" : control.entry_enabled ? "ARMED" : "DISARMED"}
          </span>
          <span className="box-controlbox-headline-k">Session</span>
          <span className="box-controlbox-headline-v">
            {control === undefined
              ? "—"
              : control.session.armed
                ? `${control.session.state} · ${control.session.remaining_trades ?? "∞"} left`
                : "IDLE"}
          </span>
        </div>
      </header>

      <div className="box-controlbox-tabs" role="tablist" aria-label="Engine controls">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`controlbox-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`controlbox-panel-${t.id}`}
            className="box-view-tab box-controlbox-tab"
            title={t.hint}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {attention[t.id] !== null && (
              <span
                className={`box-controlbox-flag${
                  attention[t.id] === "!" ? " box-controlbox-flag--bad" : ""
                }`}
              >
                {attention[t.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      <div
        className="box-controlbox-body"
        role="tabpanel"
        id={`controlbox-panel-${tab}`}
        aria-labelledby={`controlbox-tab-${tab}`}
      >
        {tab === "execution" && (
          <>
            <BoxExecutionControl
              control={control}
              canTrade={canTrade}
              isFullAdmin={isFullAdmin}
              onChanged={onControlChanged}
              {...(pricesStale === undefined ? {} : { pricesStale })}
            />
            {executionError && (
              <div className="banner banner--warn">
                {executionError} Prices and positions are unaffected.
              </div>
            )}
          </>
        )}

        {tab === "session" && (
          <BoxSessionControl
            control={control}
            canTrade={canTrade}
            isFullAdmin={isFullAdmin}
            onChanged={onControlChanged}
          />
        )}

        {tab === "universe" && (
          <>
            {/*
              THE PICKER FIRST, because browsing the real board is how this decision is actually made.
              Typing a symbol required the operator to already know every name they might decline,
              which is unusable once the whole F&O universe is being watched. `BoxExclusions` stays
              below it as the authoritative list of what IS excluded and as the by-name fallback for a
              symbol the board has not resolved yet (before the first universe pass, say).
            */}
            <UniversePicker
              canTrade={canTrade}
              isFullAdmin={isFullAdmin}
              persistent={blocklist?.persistent ?? false}
              // Drives the picker's refresh: it re-reads whenever the engine finishes a universe
              // pass, which is what stops a tab opened during boot from showing an empty list forever.
              universeBuiltAt={status?.universe_built_at ?? null}
              onChanged={onBlocklistChanged}
            />
            <BoxExclusions
              blocklist={blocklist}
              canTrade={canTrade}
              isFullAdmin={isFullAdmin}
              onChanged={onBlocklistChanged}
            />
          </>
        )}

        {/*
          OWNS ITS OWN FETCH, STATE AND SINGLE-FLIGHT GUARD, exactly as the sibling panels do. This
          container deliberately passes no configuration data down and holds no mutation state: the
          header comment above explains why hoisting a panel's busy/error state here is how a refactor
          of a safety surface introduces a double-submit.
        */}
        {tab === "configuration" && <ConfigurationPanel canTrade={canTrade} />}

        {tab === "risk" && (
          <>
            <BoxRiskControl control={control} canTrade={canTrade} />
            <BoxGates cfg={cfg} canTrade={canTrade} onSaved={onSettingsSaved} />
          </>
        )}
      </div>
    </section>
  );
}
