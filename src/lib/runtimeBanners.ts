/**
 * Plain-language readiness banners for the Box dashboard.
 *
 * WHY THIS FILE WAS REWRITTEN
 * It previously read pre-computed booleans — `runtime.token_waiting`,
 * `instruments_loading`, `websocket_connecting`, `depth_ready`, `postgres_available`,
 * `live_entry_blocked`, `recovery_active`, and `exportStatus.delayed`/`lag_seconds` —
 * none of which the backend has ever sent. Every one was optional in the type, so the
 * project typechecked, built and passed its tests while EVERY banner stayed dark in
 * production. The dashboard would have looked healthy while waiting for a token.
 *
 * The backend reports FACTS (per-broker token state, feed connection, depth age,
 * `pg_ready`, `live_entry.reasons`, outbox backlog). The phrasing is this component's
 * job, so the banners are DERIVED here and each derivation is stated explicitly below.
 * Nothing is invented: where the backend cannot distinguish two situations, this says so
 * rather than guessing.
 *
 * Two states the old shape could not express are now shown:
 *   • a token-provider CONFIGURATION ERROR (passcode rejected / identity mismatch) — a
 *     fatal blocker that polling will not fix, previously indistinguishable from "waiting";
 *   • DEAD-LETTERED projections — a reporting row that gave up, previously invisible.
 *
 * And `live_entry.reasons` is now displayed, so "live entry is blocked" finally says why.
 *
 * NO SECRET IS RENDERED. `last_error` is bounded and redacted by the backend; there is no
 * token, passcode or ciphertext field in either payload.
 */

import type {
  BrokerTokenRuntime,
  ExportStatus,
  OperationalReadiness,
  RuntimeStatus,
} from "../api/types.ts";
import type { RefreshState } from "./statusIntegrity.ts";
import { reductionAssurance as deriveReduction } from "./reductionAssurance.ts";

export type Banner = { key: string; kind: "info" | "warn" | "error"; text: string };

/**
 * The readiness blocker GAR_B raises when the durable store cannot be written.
 *
 * THE REASON THIS CONSTANT EXISTS. `runtime.pg_ready` is a STARTUP LATCH — it answers "did
 * PostgreSQL respond when this process booted?" and nothing more. A store that dies MID-SESSION
 * leaves it `true` forever, while the readiness decision correctly turns every exposure-management
 * permission false and raises this code. Keying the outage off `pg_ready` alone therefore misses the
 * entire class of mid-session failures, which is exactly when an operator most needs to be told the
 * truth about whether an exit can reach the broker.
 */
const DURABLE_STORE_BLOCKER = "durable_store_unavailable";

/** Every blocker the decision is currently raising, entry and reduction alike. */
function allBlockers(readiness: OperationalReadiness | null | undefined) {
  if (!readiness) return [];
  return [
    ...readiness.entry.reasons,
    ...readiness.exposure_management.blocked_reasons,
    ...readiness.reconciliation.blockers,
  ];
}

/** Whether the backend is currently reporting the durable store as unwritable. */
function durableStoreDown(readiness: OperationalReadiness | null | undefined): boolean {
  return allBlockers(readiness).some((b) => b.code === DURABLE_STORE_BLOCKER);
}

/*
 * EVERY SENTENCE BELOW THAT MENTIONS EXITING COMES FROM `reductionAssurance`.
 *
 * Three banners here — the generic "live entry is blocked", the rejected-token banner and the
 * recovery banner — used to end with a flat, unconditional promise ("open positions are still
 * monitored and can still exit", "Reduction continues"). None consulted the backend. See
 * `./reductionAssurance.ts` for the full account and for why the derivation is shared rather than
 * repeated at each call site.
 */
export { reductionAssurance } from "./reductionAssurance.ts";

/** Human wording for a machine-readable live-entry reason. Unknown codes pass through. */
const ENTRY_REASON_TEXT: Record<string, string> = {
  box_live_trading_disabled: "BOX_LIVE_TRADING_ENABLED is false",
  zerodha_live_trading_disabled: "ZERODHA_LIVE_TRADING_ENABLED is false",
  dhan_live_trading_disabled: "DHAN_LIVE_TRADING_ENABLED is false",
  postgres_unavailable: "PostgreSQL is unavailable",
  // The MID-SESSION counterpart of `postgres_unavailable`. Worded to make clear it is not merely a
  // read outage: every reduction needs a durable write before anything reaches the broker.
  durable_store_unavailable:
    "the durable order-intent store cannot be written, so nothing can reach the broker",
  // GAR_B refuses new-box admission while Box legs are held at the broker that no trade or residual
  // row accounts for. Phrased as an operator action because that is the only thing that clears it.
  unowned_attributed_exposure:
    "Box legs are held at the broker that no record accounts for — an operator must verify and " +
    "flatten or reconcile them",
  reconciliation_incomplete: "reconciliation is incomplete",
  active_broker_token_not_ready: "the active broker has no valid token yet",
  // SECTION 7 / contract v1.6.0: `live_entry.reasons` is now a projection of the ONE readiness
  // decision, so the TRANSPORT lifecycles finally reach this list. Before the unification the
  // runtime endpoint computed its verdict from env/DB/token facts alone and could not see either
  // transport at all — it reported entry unblocked while the engine refused every entry.
  market_data_lifecycle: "the market-data feed is not ready for entry",
  market_data_disconnected: "the market-data socket is disconnected",
  market_data_not_configured: "market data is not configured",
  market_data_session_expired: "the market-data session or token has expired",
  order_stream_lifecycle: "the order-update stream is not delivering",
  order_stream_session_expired: "the order-update stream's session has expired",
  order_stream_reconciliation_owed: "a REST reconciliation of the order-update gap is owed",
  scanner_stopped: "the scanner is stopped (entry only — positions stay monitored)",
  market_closed: "the exchange is closed",
  entry_disabled: "the live ENTRY control is disarmed",
  recovery_active: "a crash-recovery pass is still resolving unknown orders",
  migrations_pending: "database migrations are still pending",
  readiness_evidence_unavailable: "the readiness evidence could not be read (treated as blocking)",
};

function describeEntryReason(code: string): string {
  if (ENTRY_REASON_TEXT[code]) return ENTRY_REASON_TEXT[code];
  // The backend emits `execution_mode_<mode>` for anything that is not live.
  const mode = code.startsWith("execution_mode_") ? code.slice("execution_mode_".length) : null;
  return mode ? `execution mode is ${mode} (not live)` : code.replace(/_/g, " ");
}

export interface RuntimeBannerInput {
  runtime: RuntimeStatus | null;
  exportStatus: ExportStatus | null;
  /**
   * THE ONE authoritative readiness decision (`box_status.operational_readiness`).
   *
   * REQUIRED for any banner to say anything about exiting. Optional in the type only so a caller
   * that has not yet loaded a status can still render the token/feed banners — and when it is
   * absent every exit statement degrades to UNKNOWN rather than to reassurance. It is also the ONLY
   * way to detect a MID-SESSION durable-store failure, which `runtime.pg_ready` (a startup latch)
   * reports as healthy forever.
   */
  readiness?: OperationalReadiness | null;
  /**
   * SECTION 7 — how much to trust what follows.
   *
   * Optional so the component still renders for a caller that has no tracker, but when supplied a
   * STALE or UNKNOWN verdict emits its own banner FIRST. That ordering matters: a reader who sees
   * "this reading is 40s old and the last 4 refreshes failed" interprets everything below it
   * differently, and the previous `.catch(() => {})` gave them no way to know.
   */
  refresh?: RefreshState;
}

/**
 * DERIVE THE BANNERS — pure, and exported so the WORDING is testable.
 *
 * Extracted from the component body because the text is the product here: these sentences are what
 * an operator acts on during an incident, and one of them previously asserted that exits were
 * unaffected by a PostgreSQL outage when in fact no reduction could reach the broker at all. A
 * claim that dangerous must be pinned by a test, and a JSX component cannot be asserted against
 * without a renderer. The component below is now a thin map over this function's result.
 */
export function buildRuntimeBanners({
  runtime,
  exportStatus,
  refresh,
  readiness,
}: RuntimeBannerInput): Banner[] {
  const banners: Banner[] = [];
  // Derived ONCE, and every sentence about exiting below is this value. See `reductionAssurance`.
  const reduction = deriveReduction(readiness);

  // (0) FRESHNESS FIRST. A failed or expired refresh is itself the most important fact on screen:
  // every banner below is only as true as its last successful fetch.
  if (refresh && refresh.freshness !== "fresh") {
    banners.push({
      key: "readiness-freshness",
      kind: refresh.freshness === "unknown" ? "error" : "warn",
      text:
        refresh.freshness === "unknown"
          ? `Readiness is UNKNOWN. ${refresh.detail} Do not read the absence of a warning as an all-clear.`
          : `Readiness may be STALE. ${refresh.detail} Every statement below is only as current as that.`,
    });
  }

  if (runtime) {
    const active: BrokerTokenRuntime | undefined = runtime.brokers.find(
      (b) => b.broker === runtime.active_broker,
    );

    if (active) {
      if (active.token_state === "configuration_error") {
        // NOT the same as "waiting": the provider rejected the passcode or the expected
        // identity did not match, so retrying on a timer will never succeed. It needs an
        // operator, which is why this is an error rather than an info.
        banners.push({
          key: "token-config",
          kind: "error",
          text:
            `Token-provider configuration error for ${active.broker}` +
            (active.last_error ? `: ${active.last_error}` : "") +
            ". Polling has stopped for this broker — this will not clear on its own.",
        });
      } else if (active.token_state === "invalid") {
        banners.push({
          key: "token-invalid",
          kind: "error",
          // The old text ended "open positions are still monitored and can still exit" — asserted
          // flatly, with nothing consulted. A rejected token is itself a reason an exit may NOT be
          // placeable (the broker rejects the order too), so this was the worst banner to guess on.
          text: `The ${active.broker} token was rejected. New entry is blocked. ${reduction.sentence}`,
        });
      } else if (active.token_state !== "ready") {
        // waiting (before the poll start) or polling (actively retrying).
        banners.push({
          key: "token",
          kind: "info",
          text:
            `Waiting for today's ${active.broker} token${active.ist_day ? ` (${active.ist_day} IST)` : ""} — ` +
            "market data cannot flow until the active broker is connected.",
        });
      } else if (!active.feed_connected) {
        // Token is ready but no socket yet. The backend does not separate "loading the
        // instrument master" from "socket connecting", so this deliberately covers both
        // rather than claiming to know which.
        banners.push({
          key: "feed",
          kind: "info",
          text: "Token acquired — loading instruments and connecting the market-data WebSocket. Opportunities appear once depth arrives.",
        });
      } else if (active.last_depth_age_ms === null) {
        banners.push({
          key: "depth",
          kind: "warn",
          text: "Connected, but no authoritative depth has arrived yet — entries wait for a full four-leg one-lot book.",
        });
      }
    }

    // PostgreSQL is the authoritative operational store: its loss is an ERROR, not a note.
    if (!runtime.pg_ready) {
      banners.push({
        key: "pg",
        kind: "error",
        // WHY THE OLD SENTENCE WAS REMOVED. This used to end "Exits, protective cancellation and
        // reconciliation are unaffected." That was false for all three. In GAR_B every order —
        // exit and emergency flatten included — performs two awaited durable writes BEFORE the
        // broker POST (`persistence.create`, then the CREATED→SUBMITTING compare-and-set), and the
        // guard after the CAS reads "broker POST blocked". The working-order cancel sweep must first
        // READ the intent journal (`loadNonterminal()`) to learn what to cancel, and reconciliation
        // opens with the same read plus `loadOwned()`. So during an outage automated reduction is
        // REFUSED, not queued, and nothing is transmitted. Telling an operator that exits are
        // unaffected is the single most dangerous thing this banner could say, because it is exactly
        // when they need to know that the only remaining route is the broker terminal.
        text: "PostgreSQL is unavailable — the authoritative operational store cannot be read or written. No new box can be recorded and live entry fails closed. Automated reduction is ALSO unavailable: an exit, an emergency flatten, the working-order cancel sweep and reconciliation each need the durable order-intent journal before anything reaches the broker, so they are refused rather than queued and nothing is transmitted. Any open exposure is unchanged and still owned — if it cannot wait for PostgreSQL to return, reduce it from the broker terminal.",
      });
    } else if (durableStoreDown(readiness)) {
      /*
       * THE MID-SESSION OUTAGE — INVISIBLE TO `pg_ready`.
       *
       * `pg_ready` is a STARTUP LATCH: it records whether PostgreSQL answered when this process
       * booted. A store that fails at 11:40 leaves it `true` for the rest of the day. The branch
       * above therefore never fires, and before this existed the dashboard showed no outage banner at
       * all — while the backend was refusing every exit, flatten, cancel sweep and reconciliation.
       *
       * The readiness decision is the only honest source here, and it says so explicitly with
       * `durable_store_unavailable`. Same severity and same operator instruction as a startup outage,
       * because the operational consequence is identical; the wording differs only in naming WHY the
       * green PostgreSQL indicator cannot be trusted, so nobody spends the incident believing the
       * store is fine because one field says so.
       */
      banners.push({
        key: "pg-midsession",
        kind: "error",
        text:
          "PostgreSQL FAILED MID-SESSION — the backend reports the durable store as unwritable. " +
          "Note that the PostgreSQL indicator elsewhere may still read healthy: `pg_ready` only " +
          "records whether the store answered at STARTUP, so it cannot see a store that died after " +
          "boot. Treat this banner as authoritative. No new box can be recorded and live entry fails " +
          "closed. Automated reduction is ALSO unavailable: an exit, an emergency flatten, the " +
          "working-order cancel sweep and reconciliation each need the durable order-intent journal " +
          "before anything reaches the broker, so they are refused rather than queued and nothing is " +
          "transmitted. Any open exposure is unchanged and still owned — if it cannot wait for " +
          "PostgreSQL to return, reduce it from the broker terminal.",
      });
    }

    if (runtime.migration_state.pending > 0) {
      banners.push({
        key: "migrations",
        kind: "error",
        text: `${runtime.migration_state.pending} PostgreSQL migration(s) are pending — the schema is behind the code.`,
      });
    }

    if (runtime.live_entry.blocked) {
      // The reasons list is the point: "blocked" without a cause is not actionable.
      const why = runtime.live_entry.reasons.map(describeEntryReason).join("; ");
      banners.push({
        key: "entry",
        // A blocked entry with reduction ALSO unavailable is not a warning, it is an incident: there
        // is live exposure and no automated way to reduce it. The severity has to follow the facts.
        kind: reduction.state === "available" ? "warn" : "error",
        // THE SENTENCE THIS ITEM WAS RAISED FOR. It used to end, unconditionally, "Open positions
        // are still monitored and can still exit." `live_entry.blocked` is true for a disarmed flag
        // AND for a durable-store outage; in the second case all three exposure-management
        // permissions are false and that promise was simply untrue.
        text: `Live entry is blocked${why ? ` — ${why}` : ""}. ${reduction.sentence}`,
      });
    }

    if (runtime.residual_exposure) {
      banners.push({
        key: "residual",
        kind: "warn",
        text: "Residual exposure exists — a partial fill left legs outstanding and is being reconciled. New entry stays closed until it is flat.",
      });
    } else if (runtime.recovery_pending || !runtime.recovery_ready) {
      banners.push({
        key: "recovery",
        kind: reduction.state === "available" ? "warn" : "error",
        // "Reduction continues" was the third unconditional assurance. Recovery runs precisely when
        // state is uncertain — including after a durable-store failure — so it is the last place that
        // claim can be safely hard-coded.
        text: `Recovery is in progress — unresolved broker state is being reconciled. New entry is closed. ${reduction.sentence}`,
      });
    }
  }

  // The Mongo reporting replica is non-authoritative and fed asynchronously, so a backlog
  // is expected and reported calmly — never as a failure of the operational store.
  if (exportStatus?.enabled) {
    if (exportStatus.dead_letter_count > 0) {
      // A projection that gave up. Operational data is still correct in PostgreSQL, but
      // reporting is now incomplete and will stay that way until someone replays it.
      banners.push({
        key: "mongo-dead",
        kind: "warn",
        text: `${exportStatus.dead_letter_count} reporting projection(s) dead-lettered — history in MongoDB is incomplete until replayed (npm run outbox:replay). PostgreSQL is unaffected.`,
      });
    }
    if (exportStatus.backlog_count > 0) {
      const age = exportStatus.oldest_pending_age_ms;
      const lag = age != null ? ` (oldest about ${Math.round(age / 1000)}s old)` : "";
      banners.push({
        key: "mongo",
        kind: "info",
        text: `Mongo reporting export is behind by ${exportStatus.backlog_count} record(s)${lag}. This is the async reporting replica only — operational data in PostgreSQL is unaffected.`,
      });
    } else if (!exportStatus.connected) {
      banners.push({
        key: "mongo-down",
        kind: "info",
        text: "Mongo reporting replica is not connected. Reporting is delayed; nothing operational is blocked, and the backlog is durable in PostgreSQL.",
      });
    }
  }

  return banners;
}
