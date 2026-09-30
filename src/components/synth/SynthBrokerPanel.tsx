/**
 * Zerodha and Dhan sessions of the synthetic service: connect (broker login redirect, or a
 * pasted access token the server validates first), disconnect, and choose which broker the
 * scanner uses. Tokens never reach this page: the server stores them encrypted and only
 * reports whether a session is usable.
 */

import { useState } from "react";
import Button from "../ui/Button.tsx";
import StatusBadge from "../ui/StatusBadge.tsx";
import { describeRequestFailure } from "../../api/http.ts";
import {
  logoutSynthBroker,
  saveSynthBrokerToken,
  startSynthBrokerLogin,
  type SynthBrokerId,
  type SynthBrokerView,
} from "../../api/synth.ts";
import { BROKER_LABEL, brokerReasonText } from "../../lib/synthView.ts";

function BrokerCard({
  b,
  active,
  busy,
  onChanged,
  onUse,
}: {
  b: SynthBrokerView;
  active: boolean;
  busy: boolean;
  onChanged: (list: SynthBrokerView[] | null, notice: string | null, error: string | null) => void;
  onUse: () => void;
}) {
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [working, setWorking] = useState(false);
  const label = BROKER_LABEL[b.broker];

  async function login() {
    setWorking(true);
    try {
      const r = await startSynthBrokerLogin(b.broker);
      window.location.assign(r.login_url);
    } catch (err) {
      onChanged(null, null, describeRequestFailure(err));
      setWorking(false);
    }
  }

  async function paste() {
    setWorking(true);
    try {
      const list = await saveSynthBrokerToken(b.broker, token.trim(), clientId.trim() || undefined);
      setToken("");
      onChanged(list, `${label} connected with the pasted token.`, null);
    } catch (err) {
      onChanged(null, null, describeRequestFailure(err));
    } finally {
      setWorking(false);
    }
  }

  async function disconnect() {
    setWorking(true);
    try {
      onChanged(await logoutSynthBroker(b.broker), `${label} disconnected.`, null);
    } catch (err) {
      onChanged(null, null, describeRequestFailure(err));
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working;
  return (
    <div className={`synth-card${active ? " synth-card--active" : ""}`}>
      <div className="synth-card-head">
        <div>
          <span className="synth-sym">{label}</span>{" "}
          <StatusBadge tone={b.connected ? "positive" : "negative"} title={b.reason ? brokerReasonText(b.reason) : undefined}>
            {b.connected ? "Connected" : "Not connected"}
          </StatusBadge>
          {active && <span className="synth-tag">scanner uses this</span>}
        </div>
        <div className="synth-card-actions">
          {!active && (
            <Button size="sm" disabled={disabled} onClick={onUse} title="Make the scanner use this broker">
              Use {label}
            </Button>
          )}
          {b.connected && (
            <Button size="sm" variant="danger" disabled={disabled} onClick={() => void disconnect()}>
              Disconnect
            </Button>
          )}
        </div>
      </div>
      <dl className="synth-kv">
        {b.identity?.user_id && (
          <>
            <dt>Account</dt>
            <dd>
              {b.identity.user_id}
              {b.identity.user_name ? ` · ${b.identity.user_name}` : ""}
            </dd>
          </>
        )}
        {b.login_date && (
          <>
            <dt>Logged in</dt>
            <dd>
              {b.login_date}
              {b.source ? ` (${b.source === "manual" ? "pasted token" : "broker login"})` : ""}
            </dd>
          </>
        )}
        {b.expires_at && (
          <>
            <dt>Expires</dt>
            <dd>{new Date(b.expires_at).toLocaleString("en-IN")}</dd>
          </>
        )}
        {!b.connected && b.reason && (
          <>
            <dt>Why</dt>
            <dd>{brokerReasonText(b.reason)}</dd>
          </>
        )}
      </dl>
      <div className="synth-broker-actions">
        {b.login_configured ? (
          <Button variant="primary" size="sm" disabled={disabled} onClick={() => void login()}>
            {b.connected ? `Log in to ${label} again` : `Log in with ${label}`}
          </Button>
        ) : (
          <span className="synth-dim">Broker login is not configured on the server; paste a token instead.</span>
        )}
      </div>
      <details className="synth-fills">
        <summary>Paste an access token</summary>
        <div className="synth-paste">
          <input
            className="synth-input"
            placeholder={b.broker === "zerodha" ? "Kite api_key (optional if configured)" : "Dhan client id"}
            value={clientId}
            disabled={disabled}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
          />
          <input
            className="synth-input"
            type="password"
            placeholder="Access token"
            value={token}
            disabled={disabled}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
          <Button size="sm" disabled={disabled || token.trim().length < 8} onClick={() => void paste()}>
            Validate &amp; save
          </Button>
        </div>
        <p className="synth-dim">The server checks the token with {label} before storing it, encrypted.</p>
      </details>
    </div>
  );
}

export default function SynthBrokerPanel({
  brokers,
  activeBroker,
  busy,
  onChanged,
  onUse,
}: {
  brokers: SynthBrokerView[];
  activeBroker: SynthBrokerId | "";
  busy: boolean;
  onChanged: (list: SynthBrokerView[] | null, notice: string | null, error: string | null) => void;
  onUse: (b: SynthBrokerId) => void;
}) {
  if (brokers.length === 0) {
    return (
      <section className="synth-section">
        <p className="synth-empty">
          <span className="spinner" /> Loading broker sessions…
        </p>
      </section>
    );
  }
  return (
    <section className="synth-section">
      <div className="synth-cards">
        {brokers.map((b) => (
          <BrokerCard
            key={b.broker}
            b={b}
            active={b.broker === activeBroker}
            busy={busy}
            onChanged={onChanged}
            onUse={() => onUse(b.broker)}
          />
        ))}
      </div>
    </section>
  );
}
