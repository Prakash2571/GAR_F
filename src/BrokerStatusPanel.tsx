/**
 * The broker status panel.
 *
 * A focused, read-mostly status surface for the DUAL-BROKER world: exactly one broker is
 * active at a time, but BOTH stored sessions are always shown so the operator can see
 * standby readiness and every reason a switch is refused.
 *
 * WHY THIS FILE WAS REWRITTEN
 * An earlier version was written against a `GET /api/broker/status` shape the backend does
 * not produce. Verified against a running backend, the real response is
 *   { active_broker, generation, brokers: [{ broker, session, health }, …] }
 * whereas this component read `status.broker`, `status.session`, `status.health`,
 * `status.feed`, `status.dhan_configured`, `status.dhan_instruments`,
 * `status.dhan_static_ip` and `status.last_margin_source`. Only the first three had any
 * counterpart at all, and `last_margin_source` exists nowhere in the backend — it was
 * invented. It also assumed `blockers` was an array of `{reason, detail}` objects and that
 * `POST /api/broker/select` returned a status; the backend returns `string[]` and
 * `{ ok, broker, blockers }`.
 *
 * Because the old types made those fields optional-or-absent, the project typechecked and
 * built while this panel would have rendered `undefined` in production. The types are now
 * exact, which is what surfaced all of it as compiler errors.
 *
 * ABSOLUTE RULES
 *   • NEVER render a raw token, encrypted token, passcode or any encryption metadata. There
 *     is no "copy access token" affordance anywhere in this component. `account_label` is
 *     already redacted server-side.
 *   • Session and feed are reported SEPARATELY, and neither is derived from the site
 *     passcode: "active" means the broker session is usable, not that someone unlocked the
 *     app.
 *   • Broker selection is guarded: it posts {"broker": …} and, on refusal, lists every
 *     blocker the backend returns.
 *
 * FEED STATE comes from `GET /api/runtime/status`, not from this endpoint — the broker
 * status deliberately carries no feed field. It is passed in as a prop so there is one
 * source of truth and no second poll.
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchBrokerStatus,
  fetchBrokerSwitchBlockers,
  logoutBroker,
  selectBroker,
  startBrokerLogin,
} from "./api/box.ts";
import StatusBadge from "./components/ui/StatusBadge.tsx";
import {
  brokerLabel,
  describeBrokerLoginOutcome,
  readBrokerLoginOutcome,
  stripBrokerLoginParams,
} from "./lib/brokerLogin.ts";
import type {
  BrokerHealthView,
  BrokerId,
  BrokerLoginOutcome,
  BrokerSessionView,
  BrokerStatus,
  RuntimeStatus,
} from "./api/types.ts";

/**
 * The exact sentence the specification requires when the morning Zerodha default was
 * blocked because Dhan still owns exposure or unresolved broker state. Rendered verbatim.
 */
const DHAN_HOLDS_EXPOSURE_MESSAGE =
  "Dhan remains active because it owns exposure or unresolved broker state. " +
  "Zerodha cannot become active until Dhan is safely flat and reconciled.";

const BROKERS: BrokerId[] = ["zerodha", "dhan"];

/**
 * The operator-facing token state.
 *
 * The backend already computes a `session.state` of waiting | ready | standby | expired.
 * A CONFIGURATION ERROR is not one of those — it surfaces in `health.problems` — and it
 * matters more than any of them, because polling will never clear it. So it is checked
 * first and never collapsed into "waiting".
 */
function tokenStateLabel(
  session: BrokerSessionView,
  health: BrokerHealthView,
  active: boolean,
): string {
  if (health.problems.some((p) => /not configured|configuration/i.test(p))) {
    return "configuration error";
  }
  switch (session.state) {
    case "expired":
      return "token expired";
    case "ready":
      return active ? "ready" : "ready — standby";
    case "standby":
      return "ready — standby";
    case "waiting":
    default:
      return "token waiting";
  }
}

/**
 * Dhan's expiry is its own contract: an explicit future timestamp is honoured, and a NULL
 * expiry means UNKNOWN — never "never expires". That distinction is shown rather than
 * flattened, because an operator treating unknown as permanent is the failure mode.
 */
function expiryLabel(broker: BrokerId, session: BrokerSessionView): string {
  if (session.expires_at) return `Expires ${whenIso(session.expires_at)}`;
  if (broker === "dhan") {
    return session.state === "waiting" ? "Expiry —" : "Expiry unknown (validated on use)";
  }
  return session.established_at ? `Established ${whenIso(session.established_at)}` : "Login —";
}

function whenIso(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

/** Feed state for a broker, from the runtime status. Only the ACTIVE broker has a feed. */
function feedLabel(runtime: RuntimeStatus | null, broker: BrokerId, active: boolean): string {
  if (!active) return "standby — no socket";
  const r = runtime?.brokers.find((b) => b.broker === broker);
  if (!r) return "—";
  if (!r.feed_connected) return "connecting";
  if (r.last_depth_age_ms === null) return "connected — no depth yet";
  return `live — depth ${Math.round(r.last_depth_age_ms)}ms, ${r.subscribed_token_count}/${r.wanted_token_count} tokens`;
}

/** Turn a machine-readable blocker code into something an operator can act on. */
function blockerText(code: string): string {
  return code.replace(/_/g, " ");
}

export function BrokerStatusPanel({ runtime }: { runtime?: RuntimeStatus | null }) {
  const [status, setStatus] = useState<BrokerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<BrokerId | null>(null);
  const [blockers, setBlockers] = useState<Record<BrokerId, string[]>>({
    zerodha: [],
    dhan: [],
  });
  /** Which broker is mid-handoff to the broker's own login page. */
  const [connecting, setConnecting] = useState<BrokerId | null>(null);
  const [signingOut, setSigningOut] = useState<BrokerId | null>(null);
  /** The result of a sign-in the operator has just returned from, read off the URL. */
  const [loginOutcome, setLoginOutcome] = useState<BrokerLoginOutcome | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchBrokerStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the broker status.");
    }
  }, []);

  // Pre-fetch the switch blockers for the INACTIVE broker(s) so the panel can pre-warn
  // WITHOUT the operator having to attempt a refused switch first.
  const loadBlockers = useCallback(async (active: BrokerId) => {
    const others = BROKERS.filter((b) => b !== active);
    const results = await Promise.allSettled(others.map((b) => fetchBrokerSwitchBlockers(b)));
    setBlockers((prev) => {
      const next = { ...prev };
      results.forEach((r, i) => {
        const broker = others[i];
        if (r.status === "fulfilled" && broker) next[broker] = r.value.blockers;
      });
      return next;
    });
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (status) void loadBlockers(status.active_broker);
  }, [status, loadBlockers]);

  /**
   * READ THE SIGN-IN RESULT OFF THE URL, ONCE, THEN REMOVE IT.
   *
   * The browser left this app entirely to authenticate at the broker, so no component state
   * survived — the backend's redirect query string is the only channel. It is read on mount
   * and then stripped with `replaceState`, because `?status=connected` left in the address
   * bar would re-announce a stale success on every reload and would announce someone else's
   * sign-in if the URL were shared.
   *
   * `replaceState` (not `pushState`) so Back does not walk the operator through the redirect.
   * Nothing here grants anything: the URL only produces a MESSAGE, and the authoritative
   * session state always comes from the `GET /api/broker/status` poll below.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const outcome = readBrokerLoginOutcome(window.location.search);
    if (!outcome) return;
    setLoginOutcome(outcome);
    const cleaned = stripBrokerLoginParams(window.location.search);
    window.history.replaceState({}, "", `${window.location.pathname}${cleaned}${window.location.hash}`);
    // A sign-in changes session state, so refetch rather than waiting up to 5s for the poll.
    void load();
  }, [load]);

  /**
   * Hand the operator off to the broker's own login page.
   *
   * The consent URL is built SERVER-SIDE and simply followed here. The frontend deliberately
   * cannot construct it: that would require shipping broker hostnames and an api key into a
   * public bundle. Nothing is stored locally across the redirect — the single-use nonce
   * round-trips through the broker and is verified against a server-side record.
   *
   * Scoped to one broker: connecting the STANDBY broker cannot disturb the active one.
   */
  const onConnect = useCallback(async (broker: BrokerId) => {
    setConnecting(broker);
    setError(null);
    setLoginOutcome(null);
    try {
      const { login_url } = await startBrokerLogin(broker);
      // Full navigation away from the SPA. `connecting` is intentionally left set: the page
      // is being replaced, and clearing it would only flicker the button.
      window.location.assign(login_url);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to start the ${brokerLabel(broker)} sign-in.`,
      );
      setConnecting(null);
    }
  }, []);

  /**
   * Sign out of ONE broker.
   *
   * Confirmed first when it is the ACTIVE broker, because that stops its feed and
   * invalidates its books — a destructive action on a live runtime, unlike signing out of a
   * standby session, which changes nothing operational.
   */
  const onSignOut = useCallback(
    async (broker: BrokerId, isActive: boolean) => {
      if (isActive && typeof window !== "undefined") {
        const ok = window.confirm(
          `${brokerLabel(broker)} is the ACTIVE broker. Signing out stops its market-data feed ` +
            `and discards its order books. Open positions are NOT closed. Continue?`,
        );
        if (!ok) return;
      }
      setSigningOut(broker);
      setError(null);
      setLoginOutcome(null);
      try {
        await logoutBroker(broker);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : `Failed to sign out of ${brokerLabel(broker)}.`,
        );
      } finally {
        setSigningOut(null);
        await load();
      }
    },
    [load],
  );

  const onSelect = useCallback(
    async (broker: BrokerId) => {
      setSwitching(broker);
      setError(null);
      try {
        const result = await selectBroker(broker);
        if (!result.ok) {
          // A REFUSAL IS NOT AN EXCEPTION. The backend answers with the exact blocker list,
          // so show all of them at once rather than one message at a time.
          setBlockers((prev) => ({ ...prev, [broker]: result.blockers }));
          setError(
            `Switch to ${broker} refused: ${result.blockers.map(blockerText).join("; ") || "unknown reason"}`,
          );
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to select ${broker}.`);
        if (status) void loadBlockers(status.active_broker);
      } finally {
        setSwitching(null);
      }
    },
    [load, loadBlockers, status],
  );

  if (!status) {
    return (
      <section className="box-broker-panel">
        <h3 className="box-broker-panel-h">Brokers</h3>
        {error ? (
          <p className="box-broker-panel-msg box-broker-panel-msg--error">{error}</p>
        ) : (
          <p className="box-broker-panel-msg">
            <span className="spinner" /> Loading broker status…
          </p>
        )}
      </section>
    );
  }

  const active = status.active_broker;

  // The mandated exposure message: Dhan is active AND a switch to Zerodha is blocked by
  // exposure or unresolved broker state (as opposed to, say, Zerodha simply having no
  // token yet, which is a different and non-alarming situation).
  const zerodhaBlockedByDhanExposure =
    active === "dhan" &&
    blockers.zerodha.some((b) => /exposure|unresolved|flat|reconcil|open|residual|working|intent/i.test(b));

  return (
    <section className="box-broker-panel">
      <h3 className="box-broker-panel-h">
        Brokers
        <span className="box-dim"> — exactly one active at a time (generation {status.generation})</span>
      </h3>

      {error && <p className="box-broker-panel-msg box-broker-panel-msg--error">{error}</p>}

      {/* The result of a sign-in the operator has just come back from. Announced with
          aria-live because it is the ONLY feedback for an action that navigated away and
          back — a silent return would leave them unsure whether it worked. */}
      {loginOutcome && (
        <p
          className={`box-broker-panel-msg${
            loginOutcome.status === "connected" ? "" : " box-broker-panel-msg--error"
          }`}
          role="status"
          aria-live="polite"
        >
          {describeBrokerLoginOutcome(loginOutcome)}
        </p>
      )}

      {zerodhaBlockedByDhanExposure && (
        <p className="box-broker-panel-msg box-broker-panel-msg--warn">
          {DHAN_HOLDS_EXPOSURE_MESSAGE}
        </p>
      )}

      <div className="box-broker-cards">
        {BROKERS.map((broker) => {
          const entry = status.brokers.find((b) => b.broker === broker);
          if (!entry) return null;
          const isActive = broker === active;
          return (
            <BrokerCard
              key={broker}
              broker={broker}
              active={isActive}
              tokenState={tokenStateLabel(entry.session, entry.health, isActive)}
              expiry={expiryLabel(broker, entry.session)}
              identity={entry.session.account_label ?? "—"}
              feed={feedLabel(runtime ?? null, broker, isActive)}
              dataReady={entry.health.data_ready}
              tradingReady={entry.health.trading_ready}
              problems={entry.health.problems}
              selectable={!isActive}
              switching={switching === broker}
              blockers={blockers[broker]}
              onSelect={() => void onSelect(broker)}
              connected={entry.session.connected}
              loginPending={
                (runtime?.brokers.find((b) => b.broker === broker)?.token_state ?? null) ===
                "polling"
              }
              connecting={connecting === broker}
              signingOut={signingOut === broker}
              onConnect={() => void onConnect(broker)}
              onSignOut={() => void onSignOut(broker, isActive)}
            />
          );
        })}
      </div>

      <p className="box-broker-panel-foot box-dim">
        Charge and margin provenance are recorded per trade in PostgreSQL and shown on the
        trade itself. Selecting a broker never arms live trading.
      </p>
    </section>
  );
}

function BrokerCard({
  broker,
  active,
  tokenState,
  expiry,
  identity,
  feed,
  dataReady,
  tradingReady,
  problems,
  selectable,
  switching,
  blockers,
  onSelect,
  connected,
  loginPending,
  connecting,
  signingOut,
  onConnect,
  onSignOut,
}: {
  broker: BrokerId;
  active: boolean;
  tokenState: string;
  expiry: string;
  identity: string;
  feed: string;
  dataReady: boolean;
  tradingReady: boolean;
  problems: string[];
  selectable: boolean;
  switching: boolean;
  blockers: string[];
  onSelect: () => void;
  /** A usable session exists for THIS broker right now. */
  connected: boolean;
  /** A browser sign-in for this broker is in flight (the operator is at the broker). */
  loginPending: boolean;
  connecting: boolean;
  signingOut: boolean;
  onConnect: () => void;
  onSignOut: () => void;
}) {
  const label = brokerLabel(broker);
  return (
    <article className={`box-broker-card${active ? " box-broker-card--active" : ""}`}>
      <header className="box-broker-card-h">
        <span className="box-broker-card-name">{label}</span>
        <span className={`box-broker-badge${active ? " box-broker-badge--active" : ""}`}>
          {active ? "ACTIVE" : "STANDBY"}
        </span>
      </header>

      {/* SIX SEPARATE FACTS, PER BROKER. Session/token, account identity, market-data feed,
          data readiness and trading permission are reported independently and are never
          reduced to one indicator: an authenticated session with a dead feed, or a healthy
          feed with trading blocked, are ordinary states that a single green light would
          misreport. Every value here is the backend's own — nothing is inferred locally. */}
      <dl className="box-broker-card-dl">
        <dt>Token</dt>
        <dd>{tokenState}</dd>
        <dt>{broker === "dhan" ? "Expiry" : "Session"}</dt>
        <dd>{expiry}</dd>
        <dt>Account</dt>
        <dd>{identity}</dd>
        <dt>Feed</dt>
        <dd>{feed}</dd>
        <dt>Market data</dt>
        <dd>
          <StatusBadge tone={dataReady ? "positive" : "warning"}>
            {dataReady ? "Ready" : "Not ready"}
          </StatusBadge>
        </dd>
        <dt>Order channel</dt>
        <dd>
          {/* Trading permission is the ORDER-side signal and is deliberately reported apart
              from market data above: a live quote socket is not evidence that orders can be
              placed or that fills are observed. */}
          <StatusBadge tone={tradingReady ? "positive" : "negative"}>
            {tradingReady ? "Permitted" : "Blocked"}
          </StatusBadge>
        </dd>
      </dl>

      {problems.length > 0 && (
        <ul className="box-broker-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {/* SESSION CONTROLS, PER BROKER AND INDEPENDENT OF SELECTION.
          Connecting is deliberately separate from "Make X active": a broker can hold a
          usable session while another broker trades, so signing in must not imply
          selecting. Both cards carry these controls, so BOTH brokers can be signed in at
          the same time. */}
      <div className="box-broker-card-actions">
        <button
          type="button"
          className="box-btn box-btn--secondary"
          onClick={onConnect}
          disabled={connecting || signingOut}
          aria-label={connected ? `Reconnect ${label}` : `Connect ${label}`}
        >
          {connecting ? "Opening broker sign-in…" : connected ? `Reconnect ${label}` : `Connect ${label}`}
        </button>
        {connected && (
          <button
            type="button"
            className="box-btn box-btn--secondary"
            onClick={onSignOut}
            disabled={signingOut || connecting}
            aria-label={`Sign out of ${label}`}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        )}
      </div>

      {loginPending && !connected && (
        <p className="box-broker-card-hint box-dim">
          Waiting for the {label} sign-in to finish in the browser. Complete it at {label}, or
          start again if the tab was closed.
        </p>
      )}

      {selectable && (
        <>
          <button
            type="button"
            className="box-btn box-btn--secondary"
            onClick={onSelect}
            disabled={switching || blockers.length > 0}
            aria-label={`Make ${label} the active broker`}
          >
            {switching ? "Switching…" : `Make ${label} active`}
          </button>
          {blockers.length > 0 && (
            <ul className="box-broker-blockers">
              {blockers.map((b) => (
                <li key={b}>{blockerText(b)}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}
