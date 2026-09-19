/**
 * DEPLOYMENT FACTS — read-only, and structurally incapable of being anything else.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS TAB EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * An operator needs to SEE the deployment's ceiling to reason about the settings they can change:
 * "why is my capital cap not in force?" is answered by the deployment gate above it. So the four
 * live-capability gates, the coordinator gate and the region are displayed here.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THERE IS NO onChange IN THIS FILE, AND THAT IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * These values are owned by the process environment. `BOX_EXECUTION_MODE` decides which execution
 * engine was CONSTRUCTED at startup and is immutable for the life of the process;
 * `BOX_LIVE_TRADING_ENABLED` is enforced three separate times (a hard exit at boot, a throw inside
 * config load, and the adapter's own send predicate); the two per-broker gates are enforced by
 * REFUSING to build a live adapter at all, so with the gate off there is no transport for an order to
 * travel down.
 *
 * None of that is expressible as a form field, and a runtime control must never be able to turn a
 * paper deployment into a live-capable one. This component therefore takes no mutation callback and
 * renders no input — the read-only-ness is a property of the code, not a `disabled` attribute somebody
 * could remove. A frontend test asserts none of these names appears as an editable setting.
 *
 * `live_capable` is the BACKEND's own verdict and is displayed as given. The UI must never derive its
 * own paper/live answer — the repository already has a documented defect where a safety reassurance
 * was computed from a stream's connection state, and a genuinely live deployment whose stream had
 * briefly dropped promised that nothing reached the broker.
 */

import type { OperatorConfig } from "../../../lib/operatorConfig.ts";

/** One env-owned fact. `warn` marks a state that widens what the deployment can do. */
function Fact({ k, v, warn, note }: { k: string; v: string; warn?: boolean; note?: string }) {
  return (
    <div className="cfg-fact">
      <dt>{k}</dt>
      <dd className={warn === true ? "is-warn" : undefined}>
        {v}
        {note !== undefined && <span className="cfg-fact-note">{note}</span>}
      </dd>
    </div>
  );
}

const onOff = (b: boolean) => (b ? "ENABLED" : "disabled");

export function DeploymentFacts({ config }: { config: OperatorConfig }) {
  const d = config.deployment;

  return (
    <div className="cfg-deployment">
      <p className="cfg-deployment-intro">
        These are set by the deployment environment and cannot be changed from this screen. They are the
        ceiling every operator setting sits underneath: a runtime control can only remove permission
        beneath them, never widen it.
      </p>

      <dl className="cfg-deployment-facts">
        <Fact
          k="Execution mode"
          v={d.execution_mode.replace(/_/g, " ").toUpperCase()}
          warn={d.execution_mode === "live"}
          note="Decided at startup — which execution engine was built. Immutable while the process runs."
        />
        <Fact
          k="Live capability"
          v={d.live_capable ? "REAL ORDERS POSSIBLE" : "no order reaches any broker"}
          warn={d.live_capable}
          note="The backend's own verdict, not derived here."
        />
        <Fact
          k="Deployment live gate"
          v={onOff(d.live_trading_enabled)}
          warn={d.live_trading_enabled}
          note="BOX_LIVE_TRADING_ENABLED"
        />
        <Fact
          k="Zerodha live gate"
          v={onOff(d.zerodha_live_trading_enabled)}
          warn={d.zerodha_live_trading_enabled}
          note="ZERODHA_LIVE_TRADING_ENABLED — with this off, no Zerodha live adapter is built at all"
        />
        <Fact
          k="Dhan live gate"
          v={onOff(d.dhan_live_trading_enabled)}
          warn={d.dhan_live_trading_enabled}
          note="DHAN_LIVE_TRADING_ENABLED — with this off, no Dhan live adapter is built at all"
        />
        <Fact
          k="Shadow mode"
          v={onOff(d.shadow_mode_enabled)}
          note="Runs the real strategy against the real feed while submitting nothing. Cannot be combined with live."
        />
        <Fact
          k="Execution coordinator"
          v={onOff(d.execution_coordinator_enabled)}
          warn={!d.execution_coordinator_enabled}
          note="The entry prologue is the only enforcement point for the inventory ceiling, the session attempt budget and every instrument reservation. Live execution refuses to start without it."
        />
        <Fact k="Active broker" v={d.active_broker ?? "—"} />
        <Fact k="Region" v={d.region ?? "—"} />
        <Fact
          k="Configuration version"
          v={String(config.version)}
          note="Increments once per accepted change. A save echoes this value so a stale write is refused rather than overwriting someone else's change."
        />
      </dl>
    </div>
  );
}
