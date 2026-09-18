/**
 * The GTS Box workspace top bar.
 *
 * Extracted out of the dashboard so the header is one readable unit with an explicit
 * contract, and so the operational controls it carries are grouped by RISK rather than by
 * the order they were added:
 *
 *   identity   the mark, "GTS Box", and — derived from the backend's own `execution_mode` —
 *              what this deployment is actually doing.
 *   state      execution mode, scanner state and the ATM window. Read-mostly.
 *   session    sound, theme, help, lock. Utilities; nothing here can place an order.
 *   command    RUN / STOP. Visually separated, on its own, at the end.
 *
 * EVERY VALUE IS THE BACKEND'S. This component derives no readiness, no mode and no
 * tradability of its own: it renders what it is handed. In particular the mode label comes
 * from `modeLabel(status.execution_mode)` — never from whether a socket happens to be
 * connected, and never a hardcoded "paper", which is the single most dangerous label a
 * trading UI can get wrong.
 */

import { LockKeyIcon } from "@phosphor-icons/react";
import GTSWordmark from "../brand/GTSWordmark.tsx";
import StatusBadge from "../ui/StatusBadge.tsx";
import Button from "../ui/Button.tsx";
import ThemeToggle from "../../ThemeToggle.tsx";
import BoxSoundToggle from "../../BoxSoundToggle.tsx";
import { BoxHelp } from "../../BoxHelp.tsx";
import BoxAlertsBell from "../box/BoxAlertsBell.tsx";
import type { BoxConfigView, BoxStatus } from "../../api.ts";
import type { ModeLabel } from "../../lib/honestLabels.ts";

export interface BoxHeaderProps {
  status: BoxStatus | null;
  cfg: BoxConfigView | undefined;
  /** The backend-derived mode label. Never computed here. */
  headerMode: ModeLabel;
  /** Scanner running, per the backend. */
  running: boolean;
  /** SSE stream currently connected. Presentation only — NOT evidence of tradability. */
  live: boolean;
  /** Market hours, per the backend. */
  marketOpen: boolean;
  busy: boolean;
  canTrade: boolean;
  soundEnabled: boolean;
  onToggleSound: () => void;
  onTestSound: () => void;
  onToggleScanner: () => void;
  onStrikeLevel: (level: 1 | 2 | 3) => void;
  onLock: () => void;
}

/**
 * The scanner state pill.
 *
 * Four distinct states, each with its own tone AND its own words. "Stopped" and
 * "Market closed" are not the same thing and must never collapse into one grey dot.
 */
function scannerBadge(running: boolean, marketOpen: boolean, live: boolean) {
  if (!running) return { tone: "neutral" as const, text: "Scanner stopped" };
  if (!marketOpen) return { tone: "info" as const, text: "Market closed" };
  if (!live) return { tone: "warning" as const, text: "Stream connecting…" };
  return { tone: "positive" as const, text: "Scanning" };
}

export default function BoxHeader({
  status,
  cfg,
  headerMode,
  running,
  live,
  marketOpen,
  busy,
  canTrade,
  soundEnabled,
  onToggleSound,
  onTestSound,
  onToggleScanner,
  onStrikeLevel,
  onLock,
}: BoxHeaderProps) {
  const scanner = scannerBadge(running, marketOpen, live);
  const modeText = (status?.execution_mode ?? "paper").replace(/_/g, " ").toUpperCase();
  /**
   * Which ATM window is SELECTED, straight off the live control (`status.strike_level`) with
   * no fallback. Deliberately not `?? cfg.strike_level ?? 3`: before the first status arrives
   * nothing is known to be selected, and defaulting the pressed state to 3 would assert a
   * window the backend has not confirmed. No button is pressed until the backend says so.
   */
  const activeStrikeLevel = status?.strike_level ?? null;

  return (
    <header className="gts-workbar">
      <div className="gts-workbar-identity">
        <GTSWordmark
          variant="product"
          markSize={20}
          subtitle={
            <span
              className={headerMode.live ? "gts-workbar-sub is-live" : "gts-workbar-sub"}
              title={headerMode.detail}
            >
              {headerMode.subtitle}
            </span>
          }
        />
      </div>

      <div className="gts-workbar-state">
        {/* EXECUTION MODE FIRST. "Are these real orders?" outranks every other question on
            this page, so it is the leftmost, highest-contrast thing after the product name. */}
        <StatusBadge
          tone={headerMode.live ? "live" : "info"}
          announce
          title={
            status?.execution_mode === "live"
              ? "The execution model the backend is actually running. LIVE: fills are real broker orders, gated by the fail-closed durable order manager."
              : "The execution model the backend is actually running. Fills are simulated from observed executable books — never real orders."
          }
        >
          {modeText}
        </StatusBadge>
        <StatusBadge tone={scanner.tone} announce>
          {scanner.text}
        </StatusBadge>
        <div
          className="gts-strike-window"
          role="group"
          aria-label="Strikes each side of ATM"
          title="How many strikes up/down from ATM are monitored and traded. Narrowing this only limits NEW boxes — positions already open are unaffected."
        >
          <span className="gts-strike-window-label">ATM ±</span>
          {([1, 2, 3] as const).map((level) => (
            <Button
              key={level}
              size="sm"
              variant={activeStrikeLevel === level ? "primary" : "quiet"}
              aria-pressed={activeStrikeLevel === level}
              disabled={busy || !canTrade}
              onClick={() => onStrikeLevel(level)}
            >
              {level}
            </Button>
          ))}
        </div>
      </div>

      <div className="gts-workbar-session">
        {/* ENTRY ALERTS — which underlying was refused, and why.
 
            Placed FIRST among the utilities, and before the help panel, because it is the control an
            operator reaches for when the page says entries are failing and does not say why. It is a
            read-only surface: nothing in it can place, cancel or modify an order, which is why it
            belongs in this group rather than beside RUN/STOP. */}
        <BoxAlertsBell alerts={status?.entry_alerts} />
        {/* The help panel is given the LIVE mode and config so it explains what this server is
            actually running — a help page quoting stale defaults is worse than none, and its
            lead paragraph must not promise "paper" under live. */}
        <BoxHelp mode={status?.execution_mode} cfg={cfg} />
        <BoxSoundToggle enabled={soundEnabled} onToggle={onToggleSound} onTest={onTestSound} />
        <ThemeToggle />
        <Button
          variant="quiet"
          onClick={onLock}
          title="End this session and return to the public GTS Algo Research page"
          aria-label="Lock workspace"
        >
          <LockKeyIcon size={16} weight="regular" aria-hidden="true" />
          <span>Lock</span>
        </Button>
      </div>

      {/* COMMAND. Separated from the utilities above so the one control that starts and stops
          automated entry is never mistaken for a toolbar toggle. */}
      <div className="gts-workbar-command">
        <Button
          variant={running ? "danger" : "primary"}
          onClick={onToggleScanner}
          disabled={busy}
          title={
            running
              ? "Stop opening new boxes (open positions stay monitored)"
              : "Start discovering and auto-opening boxes in the backend's current execution mode"
          }
        >
          {running ? "STOP" : "RUN"}
        </Button>
      </div>
    </header>
  );
}
