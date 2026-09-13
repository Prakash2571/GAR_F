/**
 * ORDERING READINESS DECISIONS ACROSS A BACKEND RESTART (contract v1.7.0).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `acceptDecision` in `statusIntegrity.ts` accepted a readiness decision only when its
 * `decision_generation` was strictly greater than the one already rendered. That is correct for
 * ordering the concurrent responses of ONE backend process — which is what it was written for — and
 * wrong across a restart, because the backend mints that counter with
 * `++this.readinessDecisionGeneration` on a field declared `= 0`. It is process-local:
 *
 *     browser has rendered generation 5000
 *     backend restarts; the counter resets; it publishes generation 1
 *     5000 > 1  ⇒  the browser rejects 1, and 2, and 3, … indefinitely
 *
 * The dashboard then renders a permission verdict from a process that no longer exists, and keeps
 * showing "entry permitted" long after the new process has decided otherwise. Only a manual reload
 * clears it — and an operator has no reason to suspect they need one.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE FIX IS NOT "ACCEPT SMALLER GENERATIONS"
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * That would let a delayed in-flight response from the OLD process overwrite the new one — the same
 * bug pointing the other way, and harder to notice because it only shows up under a restart plus a
 * slow response. Nor can a random per-boot identifier fix it: a random value tells us the instance
 * CHANGED but not which one is NEWER, so we would have to trust any unfamiliar id (adopting the dead
 * process's late response) or trust none (where we started). Ordering requires an order.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PROTOCOL, AND WHY IT WORKS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Contract v1.7.0 adds `operational_readiness.instance.boot_ordinal`: a restart-durable, strictly
 * increasing integer the backend claims from PostgreSQL at boot, atomically
 * (`UPDATE … SET last_ordinal = last_ordinal + 1 RETURNING last_ordinal`). Decisions are ordered by
 * the pair (`boot_ordinal`, `decision_generation`), compared lexicographically, with `instance_id`
 * used only to detect that the process changed:
 *
 *   same instance          order by `decision_generation`, strictly. Unchanged behaviour — this is
 *                          the out-of-order case the original guard existed for, and it still holds.
 *   higher boot_ordinal    a genuinely NEWER process. ADOPT it and rebase the sequence baseline, so a
 *                          restart is picked up automatically. No manual refresh.
 *   lower boot_ordinal     a delayed response from a process already superseded. REJECT, however high
 *                          its generation.
 *   equal ordinal, different instance
 *                          two processes claiming one epoch. The atomic claim makes that impossible
 *                          for two healthy processes against one database, so it means two databases,
 *                          a restored snapshot, or a multi-process topology this system does not
 *                          support (`ecosystem.config.cjs` runs ONE fork-mode process). INCOMPATIBLE.
 *   ordinal missing        UNORDERABLE. Never allowed to replace an ordered decision.
 *
 * NO CLOCKS. `decided_at` and `started_at` are audit fields and are deliberately not consulted: the
 * comparison would be a server timestamp against a client clock, and a client a few seconds off would
 * either accept every stale response or reject every fresh one. This function takes no time argument
 * at all, which is the strongest available statement of that property.
 *
 * ONE RULE, NOT TWO. This is a VENDORED COPY of `orderReadinessDecision` from the backend's
 * `src/box/backendInstance.ts`, kept deliberately identical in behaviour. Two independent
 * implementations of an ordering protocol is how the two sides come to disagree about which verdict is
 * current — which is the class of bug this whole module exists to remove. When the backend's rule
 * changes, this file is re-vendored alongside the contract, and `tests/readinessOrder.test.mjs` pins
 * the shared cases.
 *
 * PURE: no React, no fetch, no globals, no clock. Same discipline as `statusIntegrity.ts`, and the
 * same reason — this project's harness runs `node --experimental-strip-types` and cannot render TSX,
 * so the logic the components run has to be directly callable.
 */

import type { OperationalReadiness } from "../api/types.ts";

/** Every outcome, named. A boolean here would collapse "stale" and "incompatible", which differ. */
export type ReadinessOrderKind =
  /** First orderable decision, or a strictly newer generation from the SAME instance. Apply it. */
  | "accept"
  /** A genuinely newer process. Apply it AND rebase the sequence baseline onto this instance. */
  | "adopt_new_instance"
  /** Older, or from a superseded instance. Discard; change nothing. */
  | "reject_stale"
  /**
   * Cannot be placed in the order at all. Discard, AND treat readiness as unusable so new entry is
   * shown as disabled: "possibly older" must not overwrite "known current", and a permission verdict
   * that cannot be ordered is not a permission.
   */
  | "reject_incompatible";

export interface ReadinessOrderVerdict {
  readonly kind: ReadinessOrderKind;
  /** Operator-readable reason. Safe to display; contains no account id or token. */
  readonly reason: string;
}

/** What the client currently has rendered. A null instance means nothing has been rendered yet. */
export interface RenderedReadinessOrder {
  readonly instanceId: string | null;
  readonly bootOrdinal: number | null;
  readonly decisionGeneration: number | null;
}

/** The ordering fields of an incoming decision. */
export interface IncomingReadinessOrder {
  readonly instanceId: string | null;
  readonly bootOrdinal: number | null;
  readonly decisionGeneration: number | null;
}

/** True when a verdict means "put this on screen". */
export function verdictApplies(kind: ReadinessOrderKind): boolean {
  return kind === "accept" || kind === "adopt_new_instance";
}

/**
 * True when a verdict means readiness is UNUSABLE and new entry must be shown as disabled.
 *
 * Deliberately NOT true for `reject_stale`: discarding an out-of-order response is normal and what is
 * already on screen remains the newest thing we have seen. `reject_incompatible` is different — we
 * cannot place the backend's verdict in the order at all, so we do not know whether what is on screen
 * is current.
 */
export function verdictDisablesEntry(kind: ReadinessOrderKind): boolean {
  return kind === "reject_incompatible";
}

/**
 * Read the ordering fields out of whatever actually arrived.
 *
 * Tolerant on purpose: this runs against a real response body, which may come from an older backend
 * or be truncated. Anything missing or non-finite becomes null, and null means "cannot be ordered"
 * rather than a defaulted number — a fabricated 0 would sort as the oldest possible instance and make
 * an unorderable decision look definitively stale.
 */
export function readinessOrderOf(
  status:
    | {
        operational_readiness?: Pick<OperationalReadiness, "decision_generation" | "instance">;
      }
    | null
    | undefined,
): IncomingReadinessOrder {
  const readiness = status?.operational_readiness;
  const gen = readiness?.decision_generation;
  const instance = readiness?.instance;
  const ordinal = instance?.boot_ordinal;
  const id = instance?.instance_id;
  return {
    instanceId: typeof id === "string" && id !== "" ? id : null,
    bootOrdinal: typeof ordinal === "number" && Number.isFinite(ordinal) ? ordinal : null,
    decisionGeneration: typeof gen === "number" && Number.isFinite(gen) ? gen : null,
  };
}

/**
 * Decide whether an incoming readiness decision may replace what is rendered.
 *
 * Behaviourally identical to the backend's `orderReadinessDecision`.
 */
export function orderReadinessDecision(
  rendered: RenderedReadinessOrder,
  incoming: IncomingReadinessOrder,
): ReadinessOrderVerdict {
  const inGen = incoming.decisionGeneration;
  if (inGen === null) {
    return {
      kind: "reject_incompatible",
      reason: "This readiness response carries no usable decision counter, so it cannot be ordered.",
    };
  }
  if (incoming.instanceId === null) {
    return {
      kind: "reject_incompatible",
      reason:
        "This readiness response carries no backend instance identity, so it cannot be ordered across " +
        "a restart. The backend predates the instance-aware readiness contract (v1.7.0).",
    };
  }
  const inOrdinal = incoming.bootOrdinal;
  if (inOrdinal === null) {
    return {
      kind: "reject_incompatible",
      reason:
        "The backend could not establish a durable boot ordinal, so its readiness decisions cannot be " +
        "ordered against a previous instance. New entry is treated as disabled.",
    };
  }

  if (rendered.instanceId === null || rendered.decisionGeneration === null) {
    return { kind: "accept", reason: "First orderable readiness decision." };
  }

  // SAME PROCESS — the per-instance sequence orders it, strictly. Equal is refused: re-applying the
  // same generation adds no information and would reset the freshness timer built on top of it.
  if (incoming.instanceId === rendered.instanceId) {
    return inGen > rendered.decisionGeneration
      ? {
          kind: "accept",
          reason: `Newer decision from the same backend (${inGen} > ${rendered.decisionGeneration}).`,
        }
      : {
          kind: "reject_stale",
          reason: `Out-of-order response from the same backend (${inGen} ≤ ${rendered.decisionGeneration}).`,
        };
  }

  // DIFFERENT PROCESS — the ordinal decides. Never the generation, never a clock.
  const renderedOrdinal = rendered.bootOrdinal;
  if (renderedOrdinal === null) {
    return {
      kind: "adopt_new_instance",
      reason: "Adopting an orderable readiness decision over an unorderable one already on screen.",
    };
  }
  if (inOrdinal > renderedOrdinal) {
    return {
      kind: "adopt_new_instance",
      reason:
        `The backend has restarted (instance ${inOrdinal} supersedes ${renderedOrdinal}). ` +
        `Adopting its readiness decision.`,
    };
  }
  if (inOrdinal < renderedOrdinal) {
    return {
      kind: "reject_stale",
      reason:
        `Delayed response from a superseded backend instance (${inOrdinal} < ${renderedOrdinal}). ` +
        `Discarded so it cannot rewind the current one.`,
    };
  }
  return {
    kind: "reject_incompatible",
    reason:
      `Two backend instances report the same boot ordinal ${inOrdinal} with different identities. ` +
      `The supported topology is a single backend process, so this is refused and new entry is ` +
      `treated as disabled rather than interleaving two backends' verdicts.`,
  };
}

/**
 * The rendered-order state a component keeps, and how it advances.
 *
 * Held as a tiny explicit object rather than three loose pieces of React state, because the three
 * fields must move TOGETHER: adopting a new instance while keeping the old generation baseline would
 * immediately reject the new instance's next decision.
 */
export class ReadinessOrderTracker {
  private renderedState: RenderedReadinessOrder = {
    instanceId: null,
    bootOrdinal: null,
    decisionGeneration: null,
  };
  private lastIncompatibleReason: string | null = null;

  rendered(): RenderedReadinessOrder {
    return this.renderedState;
  }

  /** Why readiness is currently unusable, or null. Set by an incompatible verdict, cleared on apply. */
  incompatibleReason(): string | null {
    return this.lastIncompatibleReason;
  }

  /**
   * Offer an incoming status. Returns the verdict; when it applies, the tracker has advanced.
   *
   * On `adopt_new_instance` the baseline is REBASED wholesale onto the new instance — that is the
   * step that makes a restart recoverable without a reload.
   */
  offer(incoming: IncomingReadinessOrder): ReadinessOrderVerdict {
    const verdict = orderReadinessDecision(this.renderedState, incoming);
    if (verdictApplies(verdict.kind)) {
      this.renderedState = {
        instanceId: incoming.instanceId,
        bootOrdinal: incoming.bootOrdinal,
        decisionGeneration: incoming.decisionGeneration,
      };
      this.lastIncompatibleReason = null;
    } else if (verdict.kind === "reject_incompatible") {
      this.lastIncompatibleReason = verdict.reason;
    }
    return verdict;
  }

  /** Offer a whole status payload. Convenience for the components. */
  offerStatus(
    status:
      | { operational_readiness?: Pick<OperationalReadiness, "decision_generation" | "instance"> }
      | null
      | undefined,
  ): ReadinessOrderVerdict {
    if (!status) {
      // Recorded, not just returned. This path used to return early WITHOUT setting the reason, so a
      // missing payload disabled entry while the banner explaining why stayed empty — the operator
      // would have seen a refusal with no cause. Every incompatible verdict must leave a reason
      // behind, whichever branch produced it.
      const verdict: ReadinessOrderVerdict = {
        kind: "reject_incompatible",
        reason: "No readiness payload was received, so entry permission cannot be established.",
      };
      this.lastIncompatibleReason = verdict.reason;
      return verdict;
    }
    return this.offer(readinessOrderOf(status));
  }
}
