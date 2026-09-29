/**
 * Every runtime setting of the synthetic service, rendered from the registry the backend
 * publishes (type, bounds, default, risk flag). Nothing here is hard-coded: a setting the
 * backend adds appears automatically.
 *
 * A change is pre-checked here and validated again by the server, which saves it atomically
 * under an optimistic version. Risk settings are confirmed first (by the caller).
 */

import { useEffect, useState, type ReactNode } from "react";
import Button from "../ui/Button.tsx";
import type { SynthSetting, SynthSettingValue, SynthSettings } from "../../api/synth.ts";
import {
  BROKER_LABEL,
  GROUP_LABEL,
  draftOf,
  formatSettingValue,
  groupSettings,
  parseDraft,
  sameValue,
} from "../../lib/synthView.ts";

function SettingRow({
  s,
  disabled,
  onRequestChange,
}: {
  s: SynthSetting;
  disabled: boolean;
  onRequestChange: (s: SynthSetting, v: SynthSettingValue) => void;
}) {
  const [draft, setDraft] = useState(draftOf(s));
  const [err, setErr] = useState<string | null>(null);
  // Re-seed when the authoritative value changes (saved here, or elsewhere).
  const authoritative = JSON.stringify(s.value);
  useEffect(() => {
    setDraft(draftOf(s));
    setErr(null);
  }, [authoritative]);

  const apply = () => {
    const r = parseDraft(s, draft);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setErr(null);
    if (!sameValue(r.value, s.value)) onRequestChange(s, r.value);
  };

  let control: ReactNode;
  if (s.kind === "bool") {
    const on = s.value === true;
    control = (
      <button
        id={`synth-${s.key}`}
        type="button"
        role="switch"
        aria-checked={on}
        className={`synth-toggle${on ? " is-on" : ""}`}
        disabled={disabled}
        onClick={() => onRequestChange(s, !on)}
      />
    );
  } else if (s.kind === "enum") {
    control = (
      <select
        id={`synth-${s.key}`}
        className="synth-select"
        value={String(s.value)}
        disabled={disabled}
        onChange={(e) => onRequestChange(s, e.target.value)}
      >
        {(s.options ?? []).map((o) => (
          <option key={o} value={o}>
            {BROKER_LABEL[o] ?? o}
          </option>
        ))}
      </select>
    );
  } else {
    const dirty = draft !== draftOf(s);
    control = (
      <>
        {s.kind === "list" ? (
          <textarea
            id={`synth-${s.key}`}
            className="synth-input synth-list-input"
            rows={2}
            value={draft}
            disabled={disabled}
            placeholder={s.list_item === "date" ? "2026-12-31, …" : "NIFTY, RELIANCE, …"}
            onChange={(e) => setDraft(e.target.value)}
          />
        ) : (
          <>
            {s.unit === "₹" && <span className="synth-affix">₹</span>}
            <input
              id={`synth-${s.key}`}
              className="synth-input"
              type="number"
              inputMode="decimal"
              min={s.min}
              max={s.max}
              step={s.step || "any"}
              value={draft}
              disabled={disabled}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") apply();
                if (e.key === "Escape") setDraft(draftOf(s));
              }}
            />
            {s.unit && s.unit !== "₹" && <span className="synth-affix">{s.unit}</span>}
          </>
        )}
        <Button size="sm" variant={s.risk ? "danger" : "secondary"} disabled={disabled || !dirty} onClick={apply}>
          Apply
        </Button>
      </>
    );
  }

  return (
    <div className={`synth-setting${s.risk ? " synth-setting--risk" : ""}`}>
      <div className="synth-setting-head">
        <label className="synth-setting-label" htmlFor={`synth-${s.key}`}>
          {s.label}
        </label>
        {s.risk && (
          <span className="synth-setting-flag" title="Changing this can increase exposure or activity: it is confirmed first">
            RISK
          </span>
        )}
      </div>
      {s.help && <p className="synth-setting-help">{s.help}</p>}
      <div className="synth-setting-control">{control}</div>
      {err && <p className="synth-check synth-check--bad">{err}</p>}
      <dl className="synth-setting-meta">
        <div>
          <dt>Current</dt>
          <dd className="synth-setting-current">{formatSettingValue(s, s.value)}</dd>
        </div>
        <div>
          <dt>Default</dt>
          <dd>{formatSettingValue(s, s.default)}</dd>
        </div>
        {s.min !== undefined && s.max !== undefined && (
          <div>
            <dt>Range</dt>
            <dd>
              {s.min} – {s.max}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export default function SynthSettingsPanel({
  settings,
  busy,
  onRequestChange,
  onReload,
}: {
  settings: SynthSettings | null;
  busy: boolean;
  onRequestChange: (s: SynthSetting, v: SynthSettingValue) => void;
  onReload: () => void;
}) {
  const [group, setGroup] = useState<string>("broker");
  if (!settings) {
    return (
      <section className="synth-section">
        <p className="synth-empty">
          <span className="spinner" /> Loading settings…
        </p>
      </section>
    );
  }
  const grouped = groupSettings(settings.settings, settings.groups);
  const current = grouped.find((g) => g.group === group) ?? grouped[0];
  return (
    <section className="synth-section">
      <header className="synth-settings-head">
        <h2 className="synth-settings-title">Synthetic settings</h2>
        <span className="synth-dim">
          Version {settings.version} · saved in PostgreSQL · validated by the server
        </span>
        <Button size="sm" variant="quiet" onClick={onReload}>
          Reload
        </Button>
      </header>
      <div className="synth-tabs synth-tabs--sub" role="tablist" aria-label="Setting groups">
        {grouped.map((g) => (
          <button
            key={g.group}
            type="button"
            role="tab"
            aria-selected={current?.group === g.group}
            className="synth-tab"
            onClick={() => setGroup(g.group)}
          >
            <span className="synth-tab-label">{GROUP_LABEL[g.group] ?? g.group}</span>
            <span className="synth-tab-count">{g.settings.length}</span>
          </button>
        ))}
      </div>
      <div className="synth-settings-body" role="tabpanel">
        {current?.settings.map((s) => (
          <SettingRow key={s.key} s={s} disabled={busy} onRequestChange={onRequestChange} />
        ))}
      </div>
    </section>
  );
}
