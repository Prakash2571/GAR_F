/**
 * OPERATIONAL STATE PANEL (item 10) — the real, honest operational picture for the ACTIVE broker.
 *
 * WHAT IT SHOWS, and WHY EACH IS ITS OWN SIGNAL
 *   • MARKET-DATA connection AND generation, per-instrument data readiness, last valid data times,
 *     queue/overload — the DRIVEN `market_data_state` machine, NOT the crude `feed_healthy` boolean.
 *   • ORDER-UPDATE connection and the fill-observation mechanism actually in use (stream vs REST).
 *   • Reconciliation state, entry-blocking reasons, working orders / unresolved exposure, recovery.
 *   • Effective economic admission — the five DISTINCT quantities (gross notional ≠ margin).
 *
 * THE TWO HONESTY RULES (implemented in ../lib/operationalState.ts and rendered here):
 *   1. Market-data health and order-update health are shown as SEPARATE regions. A connected quote
 *      socket (`market_data_state: READY`) is never presented as evidence that fills are observed;
 *      the anti-conflation sentence from the payload is rendered verbatim.
 *   2. A PAUSED-ENTRY state with manageable exposure is a visually DISTINCT band ("Entry paused —
 *      positions still manageable", warn tone) from a BROKEN state (error tone). The reasons entry
 *      is paused are listed explicitly so an operator can act rather than merely wait.
 *
 * Signalling is never colour-ALONE: each band carries a text glyph and a word, and status regions
 * are labelled for assistive tech (role="status"/"group", aria-label, semantic headings).
 *
 * The backend remains the sole authority; this only renders the status it publishes. An older
 * backend that omits a field shows nothing there rather than a fabricated green light.
 */

import type { BoxStatus, BrokerId } from "./api";
import {
  bandClass,
  bandGlyph,
  deriveActiveOrderStream,
  deriveEconomicFigures,
  deriveEntryGate,
  deriveFunnel,
  deriveMarketData,
} from "./lib/operationalState.ts";
import { deriveExposure } from "./lib/honestLabels.ts";

function ago(at: number | null | undefined): string {
  if (at === null || at === undefined) return "never";
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

/** An evidence AGE. `null` means NEVER OBSERVED and must never render as a fresh 0. */
function ageMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "never observed";
  if (ms < 1000) return `${Math.round(ms)}ms ago`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

export function BoxOperationalState({ status }: { status: BoxStatus | undefined | null }) {
  // Render only when the backend actually published the operational block. A missing field
  // shows nothing rather than an invented state.
  if (!status || status.market_data_state === undefined || status.market_data_health === undefined) {
    return null;
  }

  const activeBroker: BrokerId | undefined = status.broker;
  const md = deriveMarketData(status);
  const os = deriveActiveOrderStream(status.order_stream, activeBroker);
  // SECTION 7: the ONE authoritative decision. The panel RENDERS it; it does not recompute it.
  const decision = status.operational_readiness;
  const gate = deriveEntryGate(md, os.active, decision);
  const exposure = deriveExposure(decision);
  const funnel = deriveFunnel(status.execution_funnel);
  const health = status.market_data_health;

  return (
    <section className="box-exec-health" aria-label="Operational state">
      <h3 className="box-exec-health-title">
        Operational state
        {activeBroker && <span className="box-exec-mode">{activeBroker}</span>}
      </h3>

      {/* ── HEADLINE ENTRY GATE — the BACKEND's verdict, never a locally derived one ───────── */}
      <EntryGateBanner gate={gate} />

      {/* ── THE BACKEND DECISION ITSELF: identity, generation, evidence freshness ─────────── */}
      {decision && <DecisionBlock decision={decision} exposure={exposure} />}


      {/* ── TWO INDEPENDENT HEALTH SIGNALS, side by side but never conflated ──────────────── */}
      <div className="box-op-columns">
        {/* MARKET DATA */}
        <div
          className="box-op-signal"
          role="group"
          aria-label={`Market data — ${md.label}`}
        >
          <h4 className="box-exec-sub">
            Market data{" "}
            <span className={`box-exec-mode ${bandClass(md.band)}`}>
              <span aria-hidden="true">{bandGlyph(md.band)}</span> {md.label}
            </span>
          </h4>
          <p className="box-exec-note">{md.detail}</p>
          <div className="box-exec-grid">
            <Stat
              label="Data readiness (usable depth)"
              value={md.dataUsableForEntry ? "usable for entry" : "not usable for entry"}
              cls={md.dataUsableForEntry ? "is-good" : "is-warn"}
              title="READY only when fresh usable depth per traded instrument has arrived in the current connection generation. A connected socket is not readiness."
            />
            <Stat
              label="Per-instrument readiness"
              value={`${md.readyInstruments} / ${md.desiredInstruments} instruments`}
              cls={md.desiredInstruments > 0 && md.readyInstruments >= md.desiredInstruments ? "is-good" : "is-warn"}
              title="How many of the desired traded instruments have fresh usable depth this generation. 'The feed is up' says nothing about whether the four legs a box needs each have a book."
            />
            <Stat
              label="Connection generation"
              value={String(health.generation)}
              title="Advances on every (re)authentication. A book observed under a superseded socket is not evidence for the new one — all per-instrument readiness is dropped on reconnect."
            />
            <Stat
              label="Subscriptions confirmed"
              value={String(health.confirmed)}
              title="Subscriptions confirmed on the wire this generation."
            />
            <Stat
              label="Last usable depth"
              value={ago(health.lastDepthAt)}
              title="A usable two-sided book for a specific instrument — the ONLY event that makes an instrument fresh. Distinct from a heartbeat or any inbound frame."
            />
            <Stat
              label="Last frame / heartbeat"
              value={`${ago(health.lastFrameAt)} / ${ago(health.lastHeartbeatAt)}`}
              title="Transport liveness (any inbound frame; 1-byte keep-alive). Proves the socket is alive — proves NOTHING about any book's freshness."
            />
            <Stat
              label="Ingestion backlog"
              value={health.backlog ? "overloaded" : "clear"}
              cls={health.backlog ? "is-bad" : "is-good"}
              title="Application ingestion pipeline overload. While backed up, data is treated as untrusted for entry."
            />
          </div>
        </div>

        {/* ORDER-UPDATE STREAM — the SEPARATE fill-observation signal (honesty rule #1) */}
        <div
          className="box-op-signal"
          role="group"
          aria-label={`Order-update stream — ${os.anyStreamLive ? "live" : "REST polling"}`}
        >
          <h4 className="box-exec-sub">
            Order-update stream{" "}
            <span className={`box-exec-mode ${os.active ? bandClass(os.active.band) : ""}`}>
              <span aria-hidden="true">{os.active ? bandGlyph(os.active.band) : "—"}</span>{" "}
              {os.anyStreamLive ? "live" : "REST polling"}
            </span>
          </h4>
          {/* The anti-conflation sentence, rendered not just documented. */}
          <p className="box-exec-note">
            A healthy market-data feed is <strong>not</strong> evidence that fills are observed
            promptly. This is the order-update path, measured separately.
          </p>
          {os.active ? (
            <div className="box-exec-grid">
              <Stat
                label={`${os.active.broker} — ${os.active.wiringLabel}`}
                value={os.active.mechanismLabel}
                cls={bandClass(os.active.band)}
                title={os.active.detail}
              />
              {/* SECTION 7: "REST polling only" is true of a DISABLED stream and of a DEGRADED one.
                  Naming the authoritative lifecycle is what distinguishes a documented baseline
                  from a broken fast path. */}
              <Stat
                label="Lifecycle (authoritative)"
                value={os.active.lifecycle ?? "no consumer"}
                cls={os.active.lifecycle === "READY" ? "is-good" : "is-warn"}
                title="The state the backend's entry gate actually scored. Published so the mechanism label above and the entry verdict can be seen to come from the same fact."
              />
              {os.active.reconcilePending && (
                <Stat
                  label="Reconciliation"
                  value="REST reconciliation owed"
                  cls="is-warn"
                  title="The stream reconnected; events may have occurred in the gap and the broker does not promise to replay them. The gap must be repaired from REST, never assumed empty."
                />
              )}
            </div>
          ) : (
            <p className="box-exec-note is-warn">
              No order-update stream status for the active broker; fills are observed by REST
              polling only.
            </p>
          )}
        </div>
      </div>

      {/* ── ECONOMIC ADMISSION — five DISTINCT quantities, gross notional ≠ margin ─────────── */}
      <EconomicAdmissionBlock admission={status.economic_admission} />

      {/* ── EXECUTION FUNNEL — denominator-carrying, execution vs economic kept apart ─────── */}
      <FunnelBlock funnel={funnel} />
    </section>
  );
}

/**
 * THE HEADLINE VERDICT — rendered from the backend decision.
 *
 * Four DISTINCT states, never collapsed:
 *   unknown  — no backend decision to render. Explicitly not a green light.
 *   ready    — the BACKEND permits new entry.
 *   paused   — entry refused, but exposure is still fully manageable.
 *   broken   — REDUCING exposure is itself impaired. The only state that is an emergency.
 */
function EntryGateBanner({ gate }: { gate: ReturnType<typeof deriveEntryGate> }) {
  if (gate.decisionMissing) {
    return (
      <div className="box-op-gate box-op-gate--paused" role="status" aria-live="polite">
        <p className="box-op-gate-head">
          <span aria-hidden="true">{bandGlyph("unknown")}</span>{" "}
          <strong>Entry permission is UNKNOWN.</strong>
        </p>
        <ul className="box-op-reasons">
          {gate.entryPausedReasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        <p className="box-exec-note">
          The backend is the only authority on what is permitted. Until it publishes a decision,
          nothing on this panel should be read as permission — including the transport lights below.
        </p>
      </div>
    );
  }

  if (gate.entryPermitted) {
    return (
      <p className="box-op-gate box-op-gate--ok" role="status">
        <span aria-hidden="true">{bandGlyph("ready")}</span> New entry is permitted — this is the
        backend&rsquo;s own decision, not an inference from the signals below. It is not a promise of
        a fill.
      </p>
    );
  }

  const broken = gate.overallBand === "broken";
  return (
    <div
      className={`box-op-gate ${broken ? "box-op-gate--broken" : "box-op-gate--paused"}`}
      role="status"
      aria-live="polite"
    >
      <p className="box-op-gate-head">
        <span aria-hidden="true">{bandGlyph(broken ? "broken" : "paused")}</span>{" "}
        {broken ? (
          <strong>Reducing exposure is impaired — new entry stopped.</strong>
        ) : (
          <strong>Entry paused — positions still manageable.</strong>
        )}
      </p>
      {gate.entryPausedReasons.length > 0 && (
        <ul className="box-op-reasons">
          {gate.entryPausedReasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      <p className="box-exec-note">
        {gate.positionsManageable
          ? "Existing positions can still be exited, reduced and protectively cancelled. None of the " +
            "entry reasons above restricts that."
          : "The backend reports that REDUCING exposure is currently blocked:"}
      </p>
      {!gate.positionsManageable && gate.reductionBlockedReasons.length > 0 && (
        <ul className="box-op-reasons">
          {gate.reductionBlockedReasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {!gate.positionsManageable && (
        <p className="box-exec-note">
          {gate.protectiveCancelPermitted
            ? "A protective cancel is still accepted — cancelling reduces exposure."
            : "Even a protective cancel is refused, because the broker itself will reject it on an " +
              "expired session."}
        </p>
      )}
    </div>
  );
}

/**
 * THE DECISION, SHOWN AS A DECISION.
 *
 * Renders the fields that make the verdict auditable rather than merely asserted: which account and
 * broker it was computed for (MASKED), which feed generation, how old the evidence is, which
 * mechanism is actually observing fills, and the decision's own generation/version/timestamp.
 *
 * Evidence ages come from the backend and `null` means NEVER OBSERVED — rendered as "never
 * observed", never as a fresh 0.
 */
function DecisionBlock({
  decision,
  exposure,
}: {
  decision: NonNullable<BoxStatus["operational_readiness"]>;
  exposure: ReturnType<typeof deriveExposure>;
}) {
  return (
    <div className="box-op-signal" role="group" aria-label="Backend readiness decision">
      <h4 className="box-exec-sub">
        Backend readiness decision{" "}
        <span className="box-exec-mode">
          v{decision.decision_version} · gen {decision.decision_generation}
          {/* THE BACKEND INSTANCE, shown because `gen` alone is ambiguous across a restart: the
              counter is process-local and resets, so "gen 3" from a fresh process and "gen 3" from an
              hour-old one look identical. The boot ordinal is what tells them apart, and it is the
              value the ordering rule actually uses. `boot·?` means the backend could not establish a
              durable ordinal, in which case its decisions cannot be ordered and entry is disabled. */}
          {" · boot·"}
          {decision.instance?.boot_ordinal ?? "?"}
        </span>
      </h4>
      <p className="box-exec-note">
        Every permission on this page is this decision, rendered. The dashboard does not compute a
        second opinion — two permission matrices cannot be kept in agreement.
      </p>
      <div className="box-exec-grid">
        <Stat
          label="Account (masked)"
          value={
            decision.identity.account_present
              ? (decision.identity.account_masked ?? "masked")
              : "no account bound"
          }
          cls={decision.identity.account_present ? "" : "is-warn"}
          title="A masked reference, so an operator can confirm WHICH account is bound without the value being reusable. The raw id is never published."
        />
        <Stat
          label="Broker · execution mode"
          value={`${decision.identity.broker ?? "none"} · ${decision.identity.execution_mode}`}
          cls={decision.identity.deployment_live_capable ? "is-bad" : ""}
          title="The broker and mode the verdict was computed FOR. A broker switch changes this, so a stale broker's readiness can never linger on screen."
        />
        <Stat
          label="Live runtime armed"
          value={decision.identity.live_runtime_armed ? "ARMED" : "disarmed"}
          cls={decision.identity.live_runtime_armed ? "is-bad" : "is-good"}
          title="Whether the live entry / live order controls are armed right now. A live-capable deployment is live-capable even while disarmed."
        />
        <Stat
          label="Market-data lifecycle"
          value={`${decision.market_data.state} (gen ${decision.market_data.generation})`}
          cls={decision.market_data.usable_for_entry ? "is-good" : "is-warn"}
          title="The ACTUAL driven market-data lifecycle and its connection generation — not a feed_healthy boolean."
        />
        <Stat
          label="Order-stream lifecycle"
          value={`${decision.order_stream.lifecycle} → published ${decision.order_stream.published_state}`}
          cls={decision.order_stream.lifecycle === "READY" ? "is-good" : "is-warn"}
          title="The AUTHORITATIVE lifecycle the entry gate scored, and the state published from it. These two used to be able to disagree — a DEGRADED lifecycle behind a LIVE published state."
        />
        <Stat
          label="Fills observed by"
          value={decision.fill_observation.stream_assisted ? "stream first, REST reconciles" : "REST polling only"}
          cls={decision.fill_observation.stream_assisted ? "is-good" : "is-warn"}
          title={decision.fill_observation.detail}
        />
        <Stat
          label="Reconciliation"
          value={decision.reconciliation.pending ? "REST gap repair OWED" : "nothing owed"}
          cls={decision.reconciliation.pending ? "is-warn" : "is-good"}
          title="A gap is never assumed empty; missing events are repaired from REST, never read as zero fills."
        />
        <Stat
          label="Evidence — last usable depth"
          value={ageMs(decision.evidence.market_data_depth_age_ms)}
          cls={decision.evidence.market_data_depth_age_ms === null ? "is-warn" : ""}
          title="A usable two-sided book for a traded instrument. NEVER OBSERVED is shown as such — it is not a fresh zero."
        />
        <Stat
          label="Evidence — last frame / heartbeat"
          value={`${ageMs(decision.evidence.market_data_frame_age_ms)} / ${ageMs(decision.evidence.market_data_heartbeat_age_ms)}`}
          title="Transport liveness. Proves the socket is alive; proves NOTHING about any book's freshness."
        />
        <Stat
          label="Evidence — last order event"
          value={ageMs(decision.evidence.order_stream_event_age_ms)}
          cls={decision.evidence.order_stream_event_age_ms === null ? "is-warn" : ""}
          title="The last order-update the stream actually delivered."
        />
        <Stat
          label="Decided at"
          value={ago(decision.decided_at)}
          title="When this decision was evaluated. With the generation counter, this is how a stale or out-of-order response is detected and ignored rather than rendered."
        />
      </div>

      {/* ── REMAINING EXPOSURE — residual legs named separately from open boxes ──────────── */}
      <h4 className="box-exec-sub">Remaining exposure</h4>
      <p className={`box-exec-note ${exposure.hasExposure ? "is-warn" : ""}`}>{exposure.detail}</p>
      <div className="box-exec-grid">
        <Stat label="Open boxes" value={String(exposure.openPositions)} cls={exposure.openPositions > 0 ? "is-warn" : "is-good"} />
        <Stat
          label="Residual legs"
          value={String(exposure.residualLegs)}
          cls={exposure.residualLegs > 0 ? "is-bad" : "is-good"}
          title="Exposure WITHOUT the offsetting structure that made it acceptable. Counted separately from open boxes on purpose."
        />
        <Stat label="Working orders" value={String(exposure.workingOrders)} cls={exposure.workingOrders > 0 ? "is-warn" : ""} />
      </div>

      {/* ── WHAT REDUCTION CANNOT PROMISE — the backend's own limitations, verbatim ─────── */}
      {exposure.limitations.length > 0 && (
        <>
          <h4 className="box-exec-sub">Exposure-management limitations</h4>
          <ul className="box-op-reasons">
            {exposure.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function EconomicAdmissionBlock({ admission }: { admission: BoxStatus["economic_admission"] }) {
  if (!admission) {
    // Null is honest: no economic control is enabled. Do not fabricate an "all clear".
    return (
      <>
        <h4 className="box-exec-sub">Economic admission</h4>
        <p className="box-exec-note">
          No economic control is enabled, so no admission decision is published. Gross notional and
          margin are not being gate-checked.
        </p>
      </>
    );
  }
  const figures = deriveEconomicFigures(admission);
  return (
    <>
      <h4 className="box-exec-sub">
        Economic admission{" "}
        <span className={`box-exec-mode ${admission.allowed ? "is-good" : "is-bad"}`}>
          <span aria-hidden="true">{admission.allowed ? bandGlyph("ready") : bandGlyph("broken")}</span>{" "}
          {admission.allowed ? "admitted" : "refused"}
        </span>
      </h4>
      {!admission.allowed && admission.reasons.length > 0 && (
        <ul className="box-op-reasons">
          {admission.reasons.map((r) => (
            <li key={r}>{r.replace(/_/g, " ")}</li>
          ))}
        </ul>
      )}
      <div className="box-exec-grid">
        {figures.map((f) => (
          <Stat
            key={f.key}
            label={f.label}
            value={f.value}
            cls={f.usable ? "is-good" : "is-warn"}
            title={`${f.note} (provenance: ${f.provenance}${f.usable ? ", usable" : ", NOT usable as authority"})`}
          />
        ))}
      </div>
      <p className="box-exec-note">
        Gross notional (total option-order value) and planned margin (broker-netted requirement) are
        different quantities and are shown separately — never summed or relabelled.
      </p>
    </>
  );
}

function FunnelBlock({ funnel }: { funnel: ReturnType<typeof deriveFunnel> }) {
  return (
    <>
      <h4 className="box-exec-sub">Execution funnel (with explicit denominators)</h4>
      <div className="box-exec-grid">
        {funnel.chain.map((c) => (
          <Stat key={c.label} label={c.label} value={String(c.count)} />
        ))}
      </div>
      <div className="box-exec-grid">
        {funnel.ratios.map((r) => (
          <Stat
            key={r.label}
            label={`${r.label}${r.kind === "economic" ? " (economic)" : ""}`}
            value={r.value}
            title={r.basis}
          />
        ))}
      </div>
      <div className="box-exec-grid">
        <Stat label="Unresolved exposure (open)" value={String(funnel.exposure.unresolvedOpen)} cls={funnel.exposure.unresolvedOpen > 0 ? "is-bad" : "is-good"} title="Exposure outstanding right now — a live gauge, never hidden to flatter a success rate." />
        <Stat label="Unresolved exposure (ever)" value={String(funnel.exposure.unresolvedTotal)} title="Every attempt that ever ended holding unresolved exposure (cumulative)." />
        <Stat label="Zero-POST refusals" value={String(funnel.exposure.zeroPostRefusals)} title="Admitted attempts refused with zero broker POSTs — free local refusals, kept OUT of the submitted denominator but visible here." />
        <Stat label="Submitted failures" value={String(funnel.exposure.submittedFailures)} cls={funnel.exposure.submittedFailures > 0 ? "is-warn" : ""} />
        <Stat label="Recovery costs included" value={funnel.exposure.recoveryCostsIncluded} title="Recovery/unwind charges included in realised net P&L — shown so they cannot be hidden." />
        <Stat label="Realised net P&L" value={funnel.exposure.realisedNetPnl} title="After ALL costs, including recovery. Economic success is reported separately from execution completion." />
      </div>
      <p className="box-exec-note">
        Execution completion (were four legs built?) and economic success (did we profit after every
        cost, including recovery?) are independent facts and both are shown. A displayed rate is
        never improved by hiding rejected attempts, partial fills, recovery costs or unresolved
        exposure.
      </p>
    </>
  );
}

function Stat({ label, value, cls, title }: { label: string; value: string; cls?: string; title?: string }) {
  return (
    <div className={`box-exec-stat ${cls ?? ""}`} title={title}>
      <span className="box-exec-stat-k">{label}</span>
      <span className="box-exec-stat-v">{value}</span>
    </div>
  );
}
