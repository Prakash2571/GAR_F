/**
 * OPERATOR CONFIGURATION — every decision the configuration UI makes, as pure functions.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT LOGIC INSIDE `.tsx`
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The same reason `honestLabels.ts` and `operationalState.ts` exist. This project's harness is
 * `node:test` with `--experimental-strip-types`, which strips types but does not transform JSX, so a
 * component cannot be imported and rendered in a test. The response is not to leave the behaviour
 * untested: every decision the configuration screen makes lives here and is driven directly, and the
 * `.tsx` files are thin enough that source assertions can pin their wiring.
 *
 * It also matters for a second reason specific to this surface. The decisions below — "is this edit
 * risk-increasing?", "is my view of the configuration stale?" — are the ones that, if wrong, either
 * hide a confirmation an operator needed or silently overwrite another operator's change. Those
 * deserve direct tests, not a rendered-DOM approximation.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE BACKEND IS AUTHORITATIVE. THIS FILE IS PRESENTATION.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Nothing here enforces anything. A confirmation dialog is not a security control: the backend
 * refuses a widening while armed whether or not this file asked the operator to confirm it. What this
 * file must get right is never being SILENT about a change that matters, and never displaying a
 * number as though it were in force when the backend said it is not.
 *
 * Notably, `isRiskIncreasing` does NOT reimplement the backend's rule. It reads `safe_direction` and
 * `zero_means` off the payload, because "a bigger number" is not "riskier" — raising the minimum
 * expected profit is safer, raising the inventory ceiling is not — and a second implementation of
 * that judgement in the browser would be free to disagree with the one that enforces it.
 */

import type {
  OperatorConfigContract,
  OperatorConfigSettingContract,
} from "../api/contract.generated.ts";

export type OperatorConfig = OperatorConfigContract;
export type OperatorSetting = OperatorConfigSettingContract;
export type SettingValue = boolean | number | string;

/* ═══════════════════════════ 1. VALUE FORMATTING ═══════════════════════════ */

/**
 * Format a millisecond figure the way a person reads it, without ever losing the exact value.
 *
 * The wire unit IS milliseconds and every request sends milliseconds back unchanged; this is purely
 * how the number is SHOWN. 15000 reads as "15 s" because an operator reasoning about quote freshness
 * thinks in seconds, while 500 stays "500 ms" because sub-second is exactly the regime where
 * rewriting it as "0.5 s" makes a coherence bound harder to compare, not easier.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms === 0) return "0 ms";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes} m` : `${minutes} m ${seconds} s`;
}

/** Indian digit grouping, because every figure on this screen is rupees for an Indian venue. */
export function formatRupees(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return `₹${rounded.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/**
 * Format a value for display, given its setting.
 *
 * The `zero_means` cases are the ones that matter. Showing a bare "0" for a cap whose zero means
 * UNLIMITED is the single most misleading thing this screen could print: it reads as the tightest
 * possible limit and means the opposite.
 */
export function formatValue(setting: OperatorSetting, value: SettingValue | null): string {
  if (value === null || value === undefined) return "—";

  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value.replace(/_/g, " ");

  if (value === 0 && setting.zero_means === "unlimited") return "Unlimited";
  if (value === 0 && setting.zero_means === "disabled") return "Disabled";

  switch (setting.unit) {
    case "rupees":
      return formatRupees(value);
    case "milliseconds":
      return formatDuration(value);
    case "seconds":
      return formatDuration(value * 1000);
    case "minutes":
      return value === 1 ? "1 minute" : `${value} minutes`;
    case "ratio":
      return `${Math.round(value * 1000) / 10}%`;
    case "percent":
      return `${value}%`;
    case "count":
      return value.toLocaleString("en-IN");
    default:
      return String(value);
  }
}

/* ═══════════════════════════ 2. PROVENANCE AND TIMING LABELS ═══════════════════════════ */

/**
 * Where the effective value came from, in words an operator can act on.
 *
 * `runtime_clamped_by_env` gets the longest sentence deliberately: it is the only case where the
 * operator's own setting is NOT what the engine is using, and the screen must say so rather than
 * quietly showing the smaller number.
 */
export function sourceLabel(source: OperatorSetting["source"]): string {
  switch (source) {
    case "default":
      return "Code default";
    case "env":
      return "Set by this deployment";
    case "runtime":
      return "Set by an operator";
    case "runtime_clamped_by_env":
      return "Operator value capped by this deployment";
    default:
      return "Unknown";
  }
}

export function takesEffectLabel(takesEffect: OperatorSetting["takes_effect"]): string {
  switch (takesEffect) {
    case "immediately":
      return "Takes effect immediately";
    case "next_candidate":
      return "Takes effect on the next candidate evaluated";
    case "next_arm":
      return "Takes effect when the session is next armed — the armed session keeps its own limit";
    case "next_restart":
      return "Requires a backend restart";
    default:
      return "Unknown";
  }
}

/** A plain-language summary of the mutation policy, for the details panel. */
export function policyLabel(policy: OperatorSetting["mutation_policy"]): string {
  switch (policy) {
    case "HOT_SAFE":
      return "Can be changed at any time";
    case "TIGHTEN_ONLY_WHILE_ARMED":
      return "While armed, may only be made more restrictive";
    case "FLAT_AND_DISARMED":
      return "Requires no open exposure and a disarmed session";
    case "NEXT_SESSION":
      return "Stored now, applied at the next arm";
    case "RESTART_REQUIRED":
      return "Deployment configuration — read-only here";
    default:
      return "Unknown";
  }
}

/* ═══════════════════════════ 3. CONTROL SELECTION ═══════════════════════════ */

export type ControlKind = "toggle" | "select" | "rupees" | "duration" | "number";

/**
 * Which input a setting gets.
 *
 * THERE IS NO SLIDER, ANYWHERE, AND THAT IS A DELIBERATE OMISSION rather than an unimplemented case.
 * Every numeric setting on this screen is a risk limit, a monetary cap or a freshness bound, and a
 * slider expresses "approximately" — which is the wrong claim for a value that decides how much money
 * one Box may commit. An operator raising a capital cap must type the number they mean.
 */
export function controlKind(setting: OperatorSetting): ControlKind {
  if (setting.type === "boolean") return "toggle";
  if (setting.type === "enum") return "select";
  if (setting.unit === "rupees") return "rupees";
  if (setting.unit === "milliseconds" || setting.unit === "seconds") return "duration";
  return "number";
}

/* ═══════════════════════════ 4. RISK DIRECTION ═══════════════════════════ */

/**
 * Is moving from `current` to `next` risk-INCREASING?
 *
 * Reads `safe_direction` and `zero_means` from the payload rather than deciding for itself. The
 * `zero_means: "unlimited"` handling is the subtle part and mirrors the backend exactly: for such a
 * ceiling, `0` is the LEAST restrictive value available, so 3 → 0 is a widening even though the number
 * shrank, and 0 → 3 is a tightening even though it grew.
 *
 * Returns false for equal values, so a no-op never triggers a confirmation.
 */
export function isRiskIncreasing(
  setting: OperatorSetting,
  current: SettingValue,
  next: SettingValue,
): boolean {
  if (current === next) return false;

  const direction = setting.safe_direction;
  if (direction === "neutral") return false;

  if (typeof current === "boolean" && typeof next === "boolean") {
    if (direction === "enabled_is_safer") return current && !next;
    if (direction === "disabled_is_safer") return !current && next;
    return false;
  }

  if (typeof current === "number" && typeof next === "number") {
    // AN AMBIGUOUS SENTINEL IS TREATED AS RISK-INCREASING, so the operator is asked to confirm.
    //
    // `disabled` means the gate is off — but for the cross-leg coherence bounds the backend documents
    // that a stored 0 is maximally SAFE in live-strict mode (it refuses every entry) and maximally
    // PERMISSIVE in paper, and which applies depends on another setting. The backend therefore refuses
    // to call such a change a tightening; here, where the only consequence is whether a confirmation
    // appears, the conservative answer is to show one. The two modules agree on "not provably safe"
    // and differ only in what they do with it, which is the correct division: the backend enforces,
    // this decides what to explain.
    const sentinel = setting.zero_means === "unlimited" || setting.zero_means === "disabled";
    if (setting.zero_means === "disabled" && (current === 0 || next === 0)) return true;

    const a = sentinel && current === 0 ? Number.POSITIVE_INFINITY : current;
    const b = sentinel && next === 0 ? Number.POSITIVE_INFINITY : next;
    if (direction === "lower_is_safer") return b > a;
    if (direction === "higher_is_safer") return b < a;
    return false;
  }

  // An enum has no ordering, so no change to one can be called a widening.
  return false;
}

/**
 * Does this edit require an explicit confirmation before it is sent?
 *
 * Two independent triggers, and the second exists because "dangerous" is a property of the SETTING
 * while "risk-increasing" is a property of the CHANGE. A setting flagged dangerous warrants a
 * confirmation in either direction — an operator lowering a capital cap should still see what they are
 * doing — and any risk-increasing edit warrants one even on a setting not otherwise flagged.
 */
export function needsConfirmation(
  setting: OperatorSetting,
  current: SettingValue,
  next: SettingValue,
): boolean {
  if (current === next) return false;
  return setting.dangerous || isRiskIncreasing(setting, current, next);
}

/* ═══════════════════════════ 5. THE CONFIRMATION SUMMARY ═══════════════════════════ */

export interface ChangeSummary {
  /** The setting's human label. Never an environment variable name. */
  readonly title: string;
  /** "₹120,000 → ₹150,000", already formatted for the unit. */
  readonly transition: string;
  readonly oldLabel: string;
  readonly newLabel: string;
  /** What the change DOES, in a sentence specific to this setting and direction. */
  readonly effect: string;
  /** When it will apply. */
  readonly when: string;
  readonly riskIncreasing: boolean;
  readonly requiresFlat: boolean;
  readonly requiresFullAdmin: boolean;
  /** The backend's caveat, when it published one. */
  readonly caveat: string | null;
}

/**
 * Build the confirmation dialog's content.
 *
 * DELIBERATELY NOT "Are you sure?". A generic prompt trains an operator to dismiss it, which makes
 * the one that mattered invisible. This states the old value, the new value, what widens as a result,
 * and when it applies — so the dialog carries information the operator did not already have.
 */
export function describeChange(
  setting: OperatorSetting,
  current: SettingValue,
  next: SettingValue,
): ChangeSummary {
  const oldLabel = formatValue(setting, current);
  const newLabel = formatValue(setting, next);
  const riskIncreasing = isRiskIncreasing(setting, current, next);

  // `requires_flat` alone UNDERSTATES the requirement, and the gap is not cosmetic.
  //
  // The backend flags `requires_flat` only for FLAT_AND_DISARMED settings, where the requirement holds
  // in every direction. But a TIGHTEN_ONLY_WHILE_ARMED setting ALSO requires flat-and-disarmed for a
  // WIDENING — that is the whole content of the policy. Reporting `false` there would let the dialog
  // omit the one precondition the operator is about to fail, and the refusal would arrive afterwards
  // as a surprise.
  const wideningNeedsFlat =
    riskIncreasing && setting.mutation_policy === "TIGHTEN_ONLY_WHILE_ARMED";

  return {
    title: setting.label,
    transition: `${oldLabel} → ${newLabel}`,
    oldLabel,
    newLabel,
    effect: effectSentence(setting, riskIncreasing),
    when: takesEffectLabel(setting.takes_effect),
    riskIncreasing,
    requiresFlat: setting.requires_flat || wideningNeedsFlat,
    requiresFullAdmin: setting.requires_full_admin,
    caveat: setting.caveat ?? null,
  };
}

/** The "what does this actually do" sentence, chosen by category and direction. */
function effectSentence(setting: OperatorSetting, riskIncreasing: boolean): string {
  if (!riskIncreasing) {
    return `This makes ${setting.label.toLowerCase()} more restrictive. The engine will admit fewer entries, not more.`;
  }
  switch (setting.category) {
    case "risk":
      return `This widens what the live entry engine may admit and therefore how much this deployment can have at risk.`;
    case "strategy":
      return `This loosens the entry test, so Boxes that would previously have been refused can now be entered.`;
    case "market_data":
      return `This accepts less fresh or less coherent market data when deciding whether to enter, which increases the chance of acting on a stale book.`;
    case "universe":
      return `This widens what the scanner watches, which increases broker rate-limit pressure on the feed the whole strategy depends on.`;
    case "charges":
      return `This reduces how much cost evidence an entry must have, so a Box can be entered on an estimated rather than a priced cost.`;
    case "paper":
      return `This changes how faithfully paper execution models the live path, so results before and after are not directly comparable.`;
    default:
      return `This widens what the engine may do.`;
  }
}

/* ═══════════════════════════ 6. GROUPING ═══════════════════════════ */

export const CATEGORY_ORDER = [
  "strategy",
  "risk",
  "market_data",
  "paper",
  "universe",
  "charges",
] as const;

export type Category = (typeof CATEGORY_ORDER)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  strategy: "Strategy",
  risk: "Risk",
  market_data: "Market data",
  paper: "Paper & calibration",
  universe: "Universe",
  charges: "Charges",
};

/** Settings grouped into display order. Categories with no settings are omitted, not rendered empty. */
export function groupByCategory(settings: readonly OperatorSetting[]): {
  category: Category;
  label: string;
  settings: OperatorSetting[];
}[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    settings: settings.filter((s) => s.category === category),
  })).filter((group) => group.settings.length > 0);
}

/** How many settings in a group currently cannot be changed. Drives the tab's attention marker. */
export function lockedCount(settings: readonly OperatorSetting[]): number {
  return settings.filter((s) => !s.mutable).length;
}

/* ═══════════════════════════ 7. VERSION-AWARE STATE ═══════════════════════════ */

export type ConfigViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly config: OperatorConfig; readonly stale: false }
  | { readonly kind: "ready"; readonly config: OperatorConfig; readonly stale: true; readonly error: string }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Accept an incoming configuration ONLY if it is not older than what we already hold.
 *
 * THE DEFECT THIS PREVENTS. Two refreshes in flight, or a PATCH response racing a GET, can land out of
 * order. Without a version check the older payload wins simply by arriving last, and the screen then
 * shows — and the next PATCH echoes — a version that is behind the backend. The operator sees their
 * change apparently revert, and the following write is refused as stale for reasons invisible to them.
 *
 * EQUAL versions ARE accepted: a re-read at the same version is the same configuration, and refusing
 * it would leave a legitimately-refreshed view marked stale forever. Only a STRICTLY older version is
 * discarded.
 */
export function acceptConfig(
  current: OperatorConfig | null,
  incoming: OperatorConfig,
): { accepted: boolean; config: OperatorConfig } {
  // A VERSION THAT IS NOT AN INTEGER IS NOT A VERSION.
  //
  // Everything downstream treats it as an ordering key and echoes it on the next write. A malformed
  // payload — a proxy rewriting the body, a truncated reply — would otherwise compare false against
  // anything (`NaN < 5` is false), be accepted as newer, and then be echoed into a PATCH that the
  // backend refuses for reasons the operator cannot see. Refusing it here keeps the staleness logic
  // total rather than mostly-total.
  if (!Number.isInteger(incoming.version)) {
    return current === null
      ? { accepted: false, config: incoming }
      : { accepted: false, config: current };
  }
  if (current === null) return { accepted: true, config: incoming };
  if (!Number.isInteger(current.version)) return { accepted: true, config: incoming };
  if (incoming.version < current.version) return { accepted: false, config: current };
  return { accepted: true, config: incoming };
}

/**
 * Fold a successful response into the view state.
 *
 * A stale response does not merely get ignored — it leaves the previous config in place AND clears the
 * stale flag, because a successful round trip proves the backend is reachable even when its payload is
 * the one we discard.
 */
export function onConfigLoaded(state: ConfigViewState, incoming: OperatorConfig): ConfigViewState {
  const current = state.kind === "ready" ? state.config : null;
  const { config } = acceptConfig(current, incoming);
  return { kind: "ready", config, stale: false };
}

/**
 * Fold a FAILED refresh into the view state.
 *
 * A failure never silently keeps showing the old numbers as though they were current. If we have a
 * previous configuration it is retained — throwing it away would blank a risk screen over one dropped
 * request — but it is marked `stale` with the reason, so the UI can label it as possibly out of date.
 * Without a previous configuration the state is `failed`: unknown, and shown as unknown.
 */
export function onConfigFailed(state: ConfigViewState, error: string): ConfigViewState {
  if (state.kind === "ready") {
    return { kind: "ready", config: state.config, stale: true, error };
  }
  return { kind: "failed", error };
}

/** The version a PATCH must echo, or null when we hold nothing to edit. */
export function editingVersion(state: ConfigViewState): number | null {
  return state.kind === "ready" ? state.config.version : null;
}

/**
 * Is it safe to submit a mutation from this state?
 *
 * Refused while stale. A stale view's version is by definition possibly behind the backend, so a PATCH
 * from it would either be rejected as stale or — worse, if the version happens to still match —
 * be based on values the operator has not actually seen.
 */
export function canSubmit(state: ConfigViewState): boolean {
  return state.kind === "ready" && state.stale === false;
}

/* ═══════════════════════════ 8. LOOKUP HELPERS ═══════════════════════════ */

export function findSetting(
  config: OperatorConfig | null,
  key: string,
): OperatorSetting | undefined {
  return config?.settings.find((s) => s.key === key);
}

/**
 * The value an edit should start from.
 *
 * The EFFECTIVE value, not the configured one. If a deployment ceiling is clamping the operator's
 * figure, editing should begin from what is actually in force — starting from an unenforced configured
 * value would invite an operator to "change" a number that was never doing anything.
 */
export function startingValue(setting: OperatorSetting): SettingValue {
  return setting.effective_value;
}

/** Whether the three values diverge enough that the UI must show more than one of them. */
export function hasDivergence(setting: OperatorSetting): boolean {
  return setting.clamped_by_deployment || setting.configured_value !== setting.effective_value;
}
