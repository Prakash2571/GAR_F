/**
 * ONE SETTING, WITH EVERYTHING AN OPERATOR NEEDS TO CHANGE IT SAFELY.
 *
 * Every row answers, without the operator opening anything: WHAT it controls, what is EFFECTIVE now,
 * what the DEFAULT is, where the value came from, WHEN a change takes effect, and whether it needs the
 * system flat and disarmed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE-VALUE RULE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * When a deployment ceiling is clamping the operator's figure, BOTH numbers are shown and the clamp is
 * named. Showing only the configured value would report a limit that is not in force; showing only the
 * effective value would hide that the operator's setting is being ignored. On a capital cap either
 * silence is a serious misstatement, so the row refuses to pick one.
 *
 * The input is seeded from the EFFECTIVE value and is LOCAL state, not controlled by the payload — this
 * screen re-renders off a polled/SSE snapshot, and binding the field straight to the payload would
 * fight every keystroke (the same reason `BoxGates` seeds locally).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NO SLIDER, ANYWHERE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `controlKind()` never returns one. Every numeric setting here is a risk limit, a monetary cap or a
 * freshness bound, and a slider expresses "approximately" — the wrong claim for a value that decides
 * how much money one Box may commit. An operator raising a capital cap types the number they mean.
 *
 * The env var appears only inside a collapsed `<details>`, because an operator should not need to know
 * `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` to raise a capital limit.
 */

import { useEffect, useState } from "react";
import Button from "../../ui/Button.tsx";
import {
  controlKind,
  formatValue,
  needsConfirmation,
  policyLabel,
  sourceLabel,
  startingValue,
  takesEffectLabel,
  type OperatorSetting,
  type SettingValue,
} from "../../../lib/operatorConfig.ts";

export function SettingRow({
  setting,
  disabled,
  onRequestChange,
}: {
  setting: OperatorSetting;
  /** True while a write is in flight or the view is stale — the whole screen is read-only then. */
  disabled: boolean;
  /** Hands the requested value up; the panel decides whether to confirm first. */
  onRequestChange: (setting: OperatorSetting, next: SettingValue) => void;
}) {
  const kind = controlKind(setting);
  const current = startingValue(setting);
  const [draft, setDraft] = useState<string>(String(current));

  // Re-seed when the AUTHORITATIVE value changes (another operator, or our own accepted write).
  // Keyed on the effective value so a re-render at the same value does not clobber a half-typed entry.
  useEffect(() => {
    setDraft(String(current));
  }, [current]);

  const locked = disabled || !setting.mutable;
  const dirty = kind !== "toggle" && draft !== String(current);

  function commitNumeric() {
    const parsed = Number(draft);
    // Invalid input is not sent. The backend would refuse it, but a silent round trip to learn that a
    // letter is not a number is a worse experience than simply not submitting.
    if (!Number.isFinite(parsed)) {
      setDraft(String(current));
      return;
    }
    if (parsed === current) return;
    onRequestChange(setting, parsed);
  }

  return (
    <div className={`cfg-row${setting.dangerous ? " cfg-row--dangerous" : ""}`}>
      <div className="cfg-row-head">
        <label className="cfg-row-label" htmlFor={`cfg-${setting.key}`}>
          {setting.label}
        </label>
        {setting.dangerous && (
          <span className="cfg-row-flag" title="Changing this can increase risk">
            RISK
          </span>
        )}
        {!setting.mutable && (
          <span className="cfg-row-flag cfg-row-flag--locked" title="Cannot be changed right now">
            LOCKED
          </span>
        )}
      </div>

      <p className="cfg-row-desc">{setting.description}</p>

      {/* ── THE CONTROL ───────────────────────────────────────────────────────────────── */}
      <div className="cfg-row-control">
        {kind === "toggle" ? (
          <button
            type="button"
            id={`cfg-${setting.key}`}
            role="switch"
            aria-checked={current === true}
            className={`cfg-toggle${current === true ? " is-on" : ""}`}
            disabled={locked}
            onClick={() => onRequestChange(setting, !(current === true))}
          >
            {current === true ? "On" : "Off"}
          </button>
        ) : kind === "select" ? (
          <select
            id={`cfg-${setting.key}`}
            className="cfg-select"
            value={String(current)}
            disabled={locked}
            onChange={(e) => onRequestChange(setting, e.target.value)}
          >
            {(setting.enum_values ?? []).map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        ) : (
          <>
            <span className="cfg-input-prefix" aria-hidden="true">
              {kind === "rupees" ? "₹" : ""}
            </span>
            <input
              id={`cfg-${setting.key}`}
              className="cfg-input"
              type="number"
              inputMode="decimal"
              value={draft}
              min={setting.min ?? undefined}
              max={setting.max ?? undefined}
              step={setting.type === "integer" ? 1 : "any"}
              disabled={locked}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNumeric();
                if (e.key === "Escape") setDraft(String(current));
              }}
            />
            <span className="cfg-input-suffix">
              {kind === "duration" ? "ms" : setting.unit === "percent" ? "%" : ""}
            </span>
            <Button
              size="sm"
              variant={needsConfirmation(setting, current, Number(draft)) ? "danger" : "primary"}
              disabled={locked || !dirty}
              onClick={commitNumeric}
            >
              Apply
            </Button>
          </>
        )}
      </div>

      {/* ── PROVENANCE: effective, configured (when different), default, source ───────── */}
      <dl className="cfg-row-meta">
        <div>
          <dt>Effective now</dt>
          <dd className="cfg-row-effective">{formatValue(setting, setting.effective_value)}</dd>
        </div>

        {setting.clamped_by_deployment && (
          <div className="cfg-row-clamped">
            <dt>You configured</dt>
            <dd>
              {formatValue(setting, setting.configured_value)}{" "}
              <span className="cfg-row-clamp-note">
                — capped by this deployment at {formatValue(setting, setting.deployment_bound)}, so it
                is not in force
              </span>
            </dd>
          </div>
        )}

        {/* The ARMED session's own frozen limit. Shown only when one exists, so a newly configured
            ceiling is never presented as though the running session were using it. */}
        {setting.session_snapshot_value !== null && (
          <div className="cfg-row-armed">
            <dt>Armed session is using</dt>
            <dd>
              {formatValue(setting, setting.session_snapshot_value)}{" "}
              <span className="cfg-row-clamp-note">
                — frozen when the session was armed; your change applies at the next arm
              </span>
            </dd>
          </div>
        )}

        <div>
          <dt>Default</dt>
          <dd>{formatValue(setting, setting.default_value)}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{sourceLabel(setting.source)}</dd>
        </div>
        <div>
          <dt>Takes effect</dt>
          <dd>{takesEffectLabel(setting.takes_effect)}</dd>
        </div>
      </dl>

      {setting.caveat !== null && <p className="cfg-row-caveat">{setting.caveat}</p>}

      {/* ── WHY IT IS LOCKED — the backend's own sentences, never reworded here ───────── */}
      {setting.blockers.length > 0 && (
        <ul className="cfg-row-blockers">
          {setting.blockers.map((b) => (
            <li key={b.code}>{b.message}</li>
          ))}
        </ul>
      )}

      <details className="cfg-row-advanced">
        <summary>Details</summary>
        <dl className="cfg-row-advanced-body">
          <div>
            <dt>Change policy</dt>
            <dd>{policyLabel(setting.mutation_policy)}</dd>
          </div>
          {(setting.min !== null || setting.max !== null) && (
            <div>
              <dt>Permitted range</dt>
              <dd>
                {setting.min ?? "—"} to {setting.max ?? "—"}
              </dd>
            </div>
          )}
          {setting.zero_means !== null && setting.zero_means !== "value" && (
            <div>
              <dt>Zero means</dt>
              <dd>{setting.zero_means}</dd>
            </div>
          )}
          <div>
            <dt>Deployment variable</dt>
            <dd>
              <code>{setting.env_var}</code>
            </dd>
          </div>
          {setting.updated_by !== null && (
            <div>
              <dt>Last changed by</dt>
              <dd>{setting.updated_by}</dd>
            </div>
          )}
        </dl>
      </details>
    </div>
  );
}
