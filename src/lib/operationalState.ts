/**
 * OPERATIONAL-STATE DERIVATION — the pure half of the operational dashboard (item 10).
 *
 * WHY A SEPARATE PURE MODULE
 * The frontend test harness is `node:test` importing modules directly (no DOM, no JSX render).
 * So every non-trivial decision the operational panel makes — which health BAND a transport is
 * in, whether the two independent health signals may be shown together, why entry is paused,
 * whether existing positions remain manageable — lives here as a pure function and is unit-tested,
 * including the degraded/reconnecting cases. The component (`BoxOperationalState.tsx`) only maps
 * these results onto markup.
 *
 * THE TWO HONESTY RULES THIS MODULE ENCODES
 *   1. Market-data health and order-update health are INDEPENDENT facts. `deriveMarketData` and
 *      `deriveOrderStream` never read each other; a connected quote socket can be READY while the
 *      order stream is REST-polling, and vice-versa. Neither is allowed to imply the other.
 *   2. During reconnection, a PAUSED-ENTRY state with manageable exposure (`band: "paused"`) is a
 *      distinct band from a BROKEN state (`band: "broken"`). `entryPausedReasons` states exactly
 *      WHY entry is paused; `positionsManageable` states whether existing positions can still be
 *      managed (exit/cancel), so "paused but safe" never renders like "broken".
 *
 * GROSS NOTIONAL vs MARGIN: `economicFigureLabel` carries each of the five economic quantities
 * under its OWN label; this module never sums or relabels one as another.
 *
 * PURE: no browser globals, no fetch, no clock except an injected `now` where an age is computed.
 */

import type {
  BoxStatus,
  EconomicAdmission,
  EconomicFigure,
  ExecutionFunnelSnapshot,
  MarketDataHealth,
  MarketDataState,
  OperationalReadiness,
  OrderStreamBrokerStatus,
  OrderStreamStatus,
  UniverseReadiness,
  UniverseStage,
} from "../api/types.ts";

/**
 * A health BAND, ordered by severity. Rendered with DISTINCT wording, icon AND colour.
 *
 * `unknown` (SECTION 7) is NOT a cosmetic addition. It is the band for "the backend published no
 * decision, or the refresh that would have confirmed this one failed". Before it existed the only
 * options were a green light or a fault, so missing evidence was rendered as one or the other —
 * and a UI that cannot say "I do not know" will eventually say something false.
 */
export type HealthBand = "ready" | "paused" | "broken" | "absent" | "unknown";

/** A market-data readiness view for the ACTIVE broker's feed. */
export interface MarketDataView {
  state: MarketDataState;
  band: HealthBand;
  /** Short label, e.g. "Ready", "Reconnecting", "Disconnected". */
  label: string;
  /** Plain-language sentence stating what this state does and does not permit. */
  detail: string;
  /** True only in READY — usable depth per traded instrument in the current generation. */
  dataUsableForEntry: boolean;
  /** Per-instrument readiness gauge: ready of desired. */
  readyInstruments: number;
  desiredInstruments: number;
}

/**
 * The eight MarketDataState values collapsed into the three operator-facing bands, plus DISABLED
 * as `absent`. This is the mechanical basis for honesty rule #2: everything in `paused` keeps
 * exposure manageable; only `broken` (or an expired session) is unsafe.
 */
export function marketDataBand(state: MarketDataState): HealthBand {
  switch (state) {
    case "READY":
      return "ready";
    case "CONNECTING":
    case "AUTHENTICATING":
    case "SYNCHRONIZING":
    case "DEGRADED":
      return "paused";
    case "DISCONNECTED":
    case "AUTH_EXPIRED":
      return "broken";
    case "DISABLED":
      return "absent";
  }
}

const MARKET_DATA_LABEL: Record<MarketDataState, string> = {
  DISABLED: "Not configured",
  CONNECTING: "Connecting",
  AUTHENTICATING: "Authenticating",
  SYNCHRONIZING: "Synchronizing",
  READY: "Ready",
  DEGRADED: "Degraded",
  DISCONNECTED: "Disconnected",
  AUTH_EXPIRED: "Session expired",
};

const MARKET_DATA_DETAIL: Record<MarketDataState, string> = {
  DISABLED: "Market data is not armed. No pricing basis for any decision.",
  CONNECTING: "A connection attempt is in flight. New entry is paused; open positions stay manageable.",
  AUTHENTICATING: "Socket open, session handshake not yet accepted. A route is not readiness. New entry is paused.",
  SYNCHRONIZING:
    "Authenticated; subscriptions restoring and fresh depth per instrument still owed. New entry is paused; exit and cancel continue.",
  READY: "Authenticated, subscribed, and fresh usable depth is being observed for the traded instruments.",
  DEGRADED:
    "Connected but the data cannot be trusted for entry (heartbeat gap, stale book, partial subscription or a processing backlog). New entry is paused; a reduction can still be priced off a current single-leg book.",
  DISCONNECTED: "The socket is closed or half-open. New entry is stopped; exposure management and protective cancel continue.",
  AUTH_EXPIRED: "The session/token was rejected or expired. Reconnecting with it is pointless — the broker will refuse everything but a cancel.",
};

/** Derive the market-data readiness view. This never reads order-stream health (honesty rule #1). */
export function deriveMarketData(status: Pick<BoxStatus, "market_data_state" | "market_data_health">): MarketDataView {
  const state = status.market_data_state;
  const health: MarketDataHealth | undefined = status.market_data_health;
  return {
    state,
    band: marketDataBand(state),
    label: MARKET_DATA_LABEL[state],
    detail: MARKET_DATA_DETAIL[state],
    dataUsableForEntry: state === "READY",
    readyInstruments: health?.readyInstruments ?? 0,
    desiredInstruments: health?.desired ?? 0,
  };
}

/** The order-update view for one broker: the mechanism ACTUALLY observing a fill. */
export interface OrderStreamBrokerView {
  broker: OrderStreamBrokerStatus["broker"];
  band: HealthBand;
  wiringLabel: string;
  /** The mechanism currently responsible for observing a fill — the field a human should read. */
  mechanismLabel: string;
  streamObserved: boolean;
  reconcilePending: boolean;
  detail: string;
  /**
   * SECTION 7 — the AUTHORITATIVE lifecycle from the backend, or null when nothing consumes the
   * stream. Surfaced so the panel can name the actual state instead of only the mechanism label:
   * "REST polling only" is true of a disabled stream AND of a degraded one, and an operator needs
   * to know which.
   */
  lifecycle: OrderStreamBrokerStatus["lifecycle"];
}

const WIRING_LABEL: Record<OrderStreamBrokerStatus["wiring"], string> = {
  not_built: "not implemented",
  not_wired: "not wired",
  gated_off: "not armed",
  armed: "armed",
  // Deliberately neutral wording. A paper backend builds no order-stream consumer BY DESIGN, so
  // this is the expected configuration and must not be phrased as a shortcoming.
  not_applicable_paper: "not applicable (paper)",
};

/**
 * The band for one broker's order stream.
 *
 * SECTION 7: scored from the AUTHORITATIVE `lifecycle` when the backend publishes it, and only from
 * the mechanism label otherwise. That matters because `rest_polling_only` covers both "no stream is
 * configured, REST is the documented baseline" (absent — not a fault) and "the stream is armed but
 * DEGRADED / DISCONNECTED / session-expired" (a real fault). Reading the two alike is how a broken
 * fast path rendered as a design choice.
 */
export function orderStreamBrokerBand(b: OrderStreamBrokerStatus): HealthBand {
  if (b.fills_observed_by === "stream_primary_rest_reconcile") return "ready";
  /*
   * PAPER: `absent`, not `paused`.
   *
   * `paused` reads as "the fast path is temporarily unavailable", which is a fault-flavoured
   * statement about something that is not supposed to exist here. A paper backend sends no order to
   * the broker, so the broker has nothing to stream and there is nothing to be paused. Checked
   * BEFORE the AUTH_EXPIRED branch is not needed (a paper deployment has no consumer and therefore
   * no lifecycle), but it is checked before the generic fallthrough so paper never lands on
   * `paused`.
   */
  if (b.wiring === "not_applicable_paper") return "absent";
  // An expired session behind the order stream is BROKEN, not merely paused: reconnecting with a
  // rejected credential cannot succeed, so it will not clear on its own.
  if (b.lifecycle === "AUTH_EXPIRED") return "broken";
  // A wired-but-idle stream, or one that is armed yet reconnecting, is "paused" — fills are still
  // observed by REST polling, so exposure remains manageable, but it is NOT the fast path.
  if (b.wiring === "not_built" || b.wiring === "gated_off") return "absent";
  return "paused";
}

export function mechanismLabel(m: OrderStreamBrokerStatus["fills_observed_by"]): string {
  switch (m) {
    case "stream_primary_rest_reconcile":
      return "stream first, REST reconciles";
    // A broker cannot confirm an order it never received. "REST polling only" would claim a broker
    // round trip that does not happen in paper.
    case "simulated_paper_fills":
      return "Simulated fills";
    case "rest_polling_only":
      return "REST polling only";
  }
}

export function deriveOrderStreamBroker(b: OrderStreamBrokerStatus): OrderStreamBrokerView {
  return {
    broker: b.broker,
    band: orderStreamBrokerBand(b),
    wiringLabel: WIRING_LABEL[b.wiring],
    mechanismLabel: mechanismLabel(b.fills_observed_by),
    streamObserved: b.fills_observed_by === "stream_primary_rest_reconcile",
    reconcilePending: b.health?.reconcilePending ?? false,
    detail: b.detail,
    lifecycle: b.lifecycle ?? null,
  };
}

/** The ACTIVE broker's order-stream view, plus the anti-conflation flag surfaced from the payload. */
export function deriveActiveOrderStream(
  orderStream: OrderStreamStatus,
  activeBroker: OrderStreamBrokerStatus["broker"] | undefined,
): { active: OrderStreamBrokerView | null; anyStreamLive: boolean; antiConflation: true } {
  const activeRaw =
    (activeBroker && orderStream.brokers.find((b) => b.broker === activeBroker)) || null;
  return {
    active: activeRaw ? deriveOrderStreamBroker(activeRaw) : null,
    anyStreamLive: orderStream.any_stream_live,
    // The payload asserts this; the UI carries it so an operator is told, not left to infer.
    antiConflation: orderStream.market_data_health_is_not_order_stream_health,
  };
}

/**
 * WHY ENTRY IS PAUSED — RENDERED FROM THE BACKEND DECISION, not derived here.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT (b): THIS FUNCTION USED TO BE A SECOND PERMISSION MATRIX
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It decided `entryPermitted` from exactly two things: whether market data was READY, and whether
 * the order stream owed a reconciliation. That missed nearly every real blocker — a stopped scanner,
 * a disarmed entry control, an unready token, unavailable PostgreSQL, pending migrations, an active
 * recovery pass, unreconciled orders, a spent session budget — and it missed a DEGRADED order-stream
 * lifecycle entirely. Pre-fix, with the backend refusing entry and the order stream DEGRADED, this
 * returned `entryPermitted: true`, `overallBand: "ready"`, `entryPausedReasons: []`, and the panel
 * rendered a green "New entry is permitted".
 *
 * Two independent permission matrices cannot be kept in agreement; the only fix is to have one. The
 * backend now publishes a single authoritative decision (`box_status.operational_readiness`, built by
 * the SAME permission table its live-entry checkpoint enforces), and this function RENDERS it.
 *
 * WHAT REMAINS LOCAL, AND WHY THAT IS NOT A SECOND MATRIX
 * The two transport BANDS (`md.band`, `os.band`) are still computed here, because they are
 * PRESENTATION — which colour and glyph a transport region gets. They no longer decide any
 * permission. The verdict, the reasons and the manageability answer all come from `decision`.
 *
 * A MISSING DECISION IS "UNKNOWN", NEVER GREEN
 * If `decision` is absent (an older backend, or a status that has not loaded), the gate reports the
 * `unknown` band with entry NOT permitted. Degrading to a green light on missing evidence is the
 * exact failure this whole section exists to remove.
 */
export interface EntryGate {
  /** The BACKEND's verdict on new entry. Never computed locally. */
  entryPermitted: boolean;
  /** The backend's reasons, verbatim. Empty when entry is permitted. */
  entryPausedReasons: string[];
  /**
   * Whether existing positions can still be exited/reduced — the BACKEND's `exit_and_reduce`.
   *
   * Note this is deliberately NOT `entryPermitted`-derived: entry-scoped restrictions must never
   * make a live position look unmanageable.
   */
  positionsManageable: boolean;
  /** Whether a protective cancel is still accepted (it reduces exposure, so it is broadest). */
  protectiveCancelPermitted: boolean;
  /** The headline tone. `unknown` when the backend published no decision to render. */
  overallBand: HealthBand;
  /** True when there is NO backend decision to render — show unknown, never ready. */
  decisionMissing: boolean;
  /** The backend's real limitations on reduction, stated rather than implied. */
  exposureLimitations: readonly string[];
  /** Reasons a REDUCTION is refused (backend, reduction-scoped only). Empty when permitted. */
  reductionBlockedReasons: string[];
}

/**
 * The band the HEADLINE takes, from the backend decision.
 *
 * `broken` is reserved for the case where exposure management itself is impaired — that is the only
 * situation an operator must treat as an emergency. Entry being refused while positions remain fully
 * manageable is `paused`: serious, but not the same thing, and rendering them alike is what teaches
 * an operator to ignore both.
 */
function headlineBand(decision: OperationalReadiness): HealthBand {
  if (!decision.exposure_management.exit_and_reduce) return "broken";
  if (!decision.entry.permitted) return "paused";
  return "ready";
}

export function deriveEntryGate(
  md: MarketDataView,
  os: OrderStreamBrokerView | null,
  decision: OperationalReadiness | null | undefined,
): EntryGate {
  if (!decision) {
    // NO DECISION ⇒ NO CLAIM. The transports may look perfect; without the backend's verdict the
    // honest answer is "unknown", and entry is reported as not permitted because the UI has no
    // authority to say otherwise.
    return {
      entryPermitted: false,
      entryPausedReasons: [
        "The backend has not published a readiness decision, so entry permission is UNKNOWN. " +
          "Nothing here should be read as permission.",
      ],
      positionsManageable: false,
      protectiveCancelPermitted: false,
      overallBand: "unknown",
      decisionMissing: true,
      exposureLimitations: [],
      reductionBlockedReasons: [],
    };
  }

  // The backend's own sentences, verbatim. Re-phrasing them here would reintroduce a second
  // vocabulary for one decision, and a UI sentence that drifts from the enforced rule is a lie
  // with better grammar. `md`/`os` are still consulted for the per-transport LABELS the panel
  // renders beside this banner — never for the verdict.
  void md;
  void os;

  return {
    entryPermitted: decision.entry.permitted,
    entryPausedReasons: decision.entry.reasons.map((r) => r.detail),
    positionsManageable: decision.exposure_management.exit_and_reduce,
    protectiveCancelPermitted: decision.exposure_management.protective_cancel,
    overallBand: headlineBand(decision),
    decisionMissing: false,
    exposureLimitations: decision.exposure_management.limitations,
    reductionBlockedReasons: decision.exposure_management.blocked_reasons.map((r) => r.detail),
  };
}

/* ─────────────────────────── economic figures: gross notional ≠ margin ─────────────────────────── */

/** A rupee amount with its provenance, formatted honestly (never a fabricated zero). */
export function formatRupees(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const sign = v < 0 ? "−" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

/** The five economic quantities, each under its OWN label — gross notional and margin are distinct. */
export const ECONOMIC_FIGURE_LABEL = {
  available_funds: "Available funds",
  planned_margin: "Planned margin (netted)",
  gross_notional: "Gross notional",
  peak_legging_exposure: "Peak legging exposure",
  worst_case_entry: "Worst-case entry cost",
} as const;

export type EconomicFigureKey = keyof typeof ECONOMIC_FIGURE_LABEL;

export interface EconomicFigureView {
  key: EconomicFigureKey;
  label: string;
  value: string;
  provenance: EconomicFigure["provenance"];
  usable: boolean;
  note: string;
}

export function deriveEconomicFigures(admission: EconomicAdmission): EconomicFigureView[] {
  const keys: EconomicFigureKey[] = [
    "available_funds",
    "planned_margin",
    "gross_notional",
    "peak_legging_exposure",
    "worst_case_entry",
  ];
  return keys.map((key) => {
    const fig = admission.picture[key];
    return {
      key,
      label: ECONOMIC_FIGURE_LABEL[key],
      value: formatRupees(fig.value_rupees),
      provenance: fig.provenance,
      usable: fig.usable,
      note: fig.note,
    };
  });
}

/* ─────────────────────────── execution funnel: denominator-carrying, honest ─────────────────────────── */

/** Format a funnel ratio as a percentage, or "— (n/d)" when the denominator is 0. */
export function formatRatio(r: { rate: number | null; numerator: number; denominator: number }): string {
  if (r.rate === null) return `— (${r.numerator}/${r.denominator})`;
  return `${Math.round(r.rate * 1000) / 10}% (${r.numerator}/${r.denominator})`;
}

export interface FunnelView {
  /** The nested chain, top to bottom, each with its count. */
  chain: { label: string; count: number }[];
  /** The denominator-carrying ratios, each with its basis. */
  ratios: { label: string; value: string; basis: string; kind: "execution" | "economic" }[];
  /** Exposure and recovery figures that must never be hidden to flatter a success rate. */
  exposure: {
    unresolvedOpen: number;
    unresolvedTotal: number;
    zeroPostRefusals: number;
    submittedFailures: number;
    recoveryCostsIncluded: string;
    realisedNetPnl: string;
  };
}

export function deriveFunnel(f: ExecutionFunnelSnapshot): FunnelView {
  return {
    chain: [
      { label: "Candidates evaluated", count: f.candidates_evaluated },
      { label: "Qualified opportunities", count: f.qualified_opportunities },
      { label: "Attempts admitted", count: f.attempts_admitted },
      { label: "Attempts submitted (≥1 broker POST)", count: f.attempts_submitted },
      { label: "Four-leg completed entries", count: f.four_leg_completed_entries },
    ],
    ratios: [
      { label: "Admission rate", value: formatRatio(f.ratios.admission_rate), basis: f.ratios.admission_rate.basis, kind: "execution" },
      { label: "Submission rate", value: formatRatio(f.ratios.submission_rate), basis: f.ratios.submission_rate.basis, kind: "execution" },
      { label: "Execution completion", value: formatRatio(f.ratios.execution_completion_rate), basis: f.ratios.execution_completion_rate.basis, kind: "execution" },
      { label: "Economic success", value: formatRatio(f.ratios.economic_success_rate), basis: f.ratios.economic_success_rate.basis, kind: "economic" },
      { label: "Unresolved exposure", value: formatRatio(f.ratios.unresolved_exposure_rate), basis: f.ratios.unresolved_exposure_rate.basis, kind: "execution" },
    ],
    exposure: {
      unresolvedOpen: f.unresolved_exposure_open,
      unresolvedTotal: f.unresolved_exposure_total,
      zeroPostRefusals: f.zero_post_refusals,
      submittedFailures: f.submitted_failures,
      recoveryCostsIncluded: formatRupees(f.recovery_costs_included),
      realisedNetPnl: formatRupees(f.realised_net_pnl),
    },
  };
}

/** CSS severity class for a band (text + colour; the component also adds a text/icon label). */
export function bandClass(band: HealthBand): string {
  switch (band) {
    case "ready":
      return "is-good";
    case "paused":
      return "is-warn";
    case "broken":
      return "is-bad";
    case "unknown":
      // Deliberately the WARN tone, not the neutral one: "we do not know" is a caution, and
      // rendering it neutrally is how an unknown state gets mistaken for a benign one.
      return "is-warn";
    case "absent":
      return "";
  }
}

/** A short text glyph per band, so the signal is never colour-ALONE (accessibility). */
export function bandGlyph(band: HealthBand): string {
  switch (band) {
    case "ready":
      return "●";
    case "paused":
      return "◐";
    case "broken":
      return "○";
    case "unknown":
      return "?";
    case "absent":
      return "—";
  }
}


/* ═══════════════════ THE UNIVERSE PIPELINE ═══════════════════ */

/**
 * How to render the universe diagnosis.
 *
 * WHY THIS EXISTS. The panel had `running` and `underlyings` and nothing else, so a scanner whose
 * instrument master came back EMPTY looked exactly like a scanner watching a quiet market: `SCANNING`
 * above a `0`. The backend now names the FIRST stage that stopped; this maps that stage onto the
 * existing health bands so the headline cannot say SCANNING while the engine is incapable of
 * evaluating anything.
 *
 * The band assignment is deliberate:
 *   - `absent`  — nothing is expected to happen (the scanner is stopped).
 *   - `paused`  — a stage is legitimately in progress and will clear on its own. WAIT.
 *   - `broken`  — a real fault that needs investigation; it will NOT clear by itself.
 *   - `ready`   — evaluating against real books.
 */
export function universeBand(u: UniverseReadiness): HealthBand {
  if (u.stage === "evaluating") return "ready";
  if (u.stage === "scanner_stopped") return "absent";
  // `transient` is the backend's own judgement about whether waiting is the right response. Trusting
  // it here keeps one vocabulary rather than re-deriving a second opinion in the UI.
  return u.transient ? "paused" : "broken";
}

/** A short label for the stage, for a badge. The detail sentence carries the explanation. */
export function universeStageLabel(stage: UniverseStage): string {
  switch (stage) {
    case "scanner_stopped": return "stopped";
    case "not_authenticated": return "not signed in";
    case "instruments_never_loaded": return "universe not loaded";
    case "instruments_loading": return "loading instruments";
    case "instruments_failed": return "instrument load FAILED";
    case "instruments_empty": return "instrument master EMPTY";
    case "no_board_rows": return "no board rows";
    case "no_option_chains": return "no option chains";
    case "no_board_chain_overlap": return "board/chain mismatch";
    case "awaiting_spot_prices": return "awaiting spot prices";
    case "no_windows_built": return "no strike windows";
    case "no_candidates": return "no candidates";
    case "no_desired_subscriptions": return "nothing subscribed";
    case "box_socket_disconnected": return "box socket disconnected";
    case "awaiting_first_tick": return "awaiting first tick";
    case "awaiting_usable_depth": return "awaiting usable depth";
    case "evaluating": return "evaluating";
  }
}

export interface UniverseView {
  band: HealthBand;
  stageLabel: string;
  /** The backend's own sentence. Rendered verbatim. */
  detail: string;
  readyToEvaluate: boolean;
  transient: boolean;
  counts: UniverseReadiness["counts"];
  instrumentLoad: UniverseReadiness["instrument_load"];
  instrumentsError: string | null;
  spotSeedError: string | null;
  lastSuccessfulBuildAt: number | null;
  /**
   * True when a subscribe frame was written. Named `Requested`, never `Confirmed`, because the
   * protocol supplies no acknowledgement — usable depth is the only confirmation.
   */
  subscriptionsRequested: boolean;
  boxSocketConnected: boolean;
}

export function deriveUniverse(u: UniverseReadiness): UniverseView {
  return {
    band: universeBand(u),
    stageLabel: universeStageLabel(u.stage),
    detail: u.detail,
    readyToEvaluate: u.readyToEvaluate,
    transient: u.transient,
    counts: u.counts,
    instrumentLoad: u.instrument_load,
    instrumentsError: u.instruments_error,
    spotSeedError: u.spot_seed_error,
    lastSuccessfulBuildAt: u.last_successful_build_at,
    subscriptionsRequested: u.subscriptions_requested,
    boxSocketConnected: u.box_socket_connected,
  };
}

/**
 * The SCANNER HEADLINE, from the operator's intent AND the engine's capability.
 *
 * `running === true` alone used to produce "SCANNING". That is the claim this function refuses to
 * make on its own: a running scanner that cannot evaluate anything is not scanning, it is stuck, and
 * the stage says where.
 */
export function scannerHeadline(
  running: boolean,
  u: UniverseReadiness,
): { text: string; band: HealthBand } {
  if (!running) return { text: "STOPPED", band: "absent" };
  if (u.readyToEvaluate) return { text: "SCANNING", band: "ready" };
  return {
    // Named, not merely "SCANNING". The stage label is the whole point.
    text: `STARTING — ${universeStageLabel(u.stage)}`,
    band: universeBand(u),
  };
}
