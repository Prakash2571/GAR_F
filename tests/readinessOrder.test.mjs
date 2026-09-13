/**
 * RESTART-AWARE READINESS ORDERING (contract v1.7.0) — the frontend half.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `acceptDecision` accepted a readiness decision only when its `decision_generation` was strictly
 * greater than the one already rendered. Correct for ordering the concurrent responses of ONE backend
 * process — which is what it was written for — and wrong across a restart, because the backend mints
 * that counter with `++this.readinessDecisionGeneration` on a field declared `= 0`:
 *
 *     browser has rendered generation 5000
 *     backend restarts; the counter resets; it publishes generation 1
 *     5000 > 1  ⇒  the browser rejects 1, and 2, and 3, … indefinitely
 *
 * The dashboard went on rendering a permission verdict from a process that no longer existed — and
 * kept showing "entry permitted" long after the new process had decided otherwise. Only a manual
 * reload cleared it, and an operator had no reason to suspect they needed one.
 *
 * THE FIX IS NOT "ACCEPT SMALLER GENERATIONS": that would let a delayed in-flight response from the
 * OLD process overwrite the new one. Decisions are ordered by (instance.boot_ordinal,
 * decision_generation), where boot_ordinal is a restart-durable integer minted atomically by the
 * backend's PostgreSQL.
 *
 * This suite drives `src/lib/readinessOrder.ts` — the module the component calls — and the vendored
 * schema, so the contract and the behaviour are pinned together.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  orderReadinessDecision,
  readinessOrderOf,
  verdictApplies,
  verdictDisablesEntry,
  ReadinessOrderTracker,
} from "../src/lib/readinessOrder.ts";

const A = "instance-aaaa";
const B = "instance-bbbb";

const at = (instanceId, bootOrdinal, decisionGeneration) => ({ instanceId, bootOrdinal, decisionGeneration });
const NOTHING = at(null, null, null);

/** A status payload shaped like the real one. */
const statusWith = (instanceId, bootOrdinal, gen) => ({
  operational_readiness: {
    decision_generation: gen,
    instance: { instance_id: instanceId, boot_ordinal: bootOrdinal, started_at: 1_699_000_000_000 },
  },
});

/* ═══════════════ 1. the headline case ═══════════════ */

test("sequence 5000 then a legitimate new boot at sequence 1: the new instance is ADOPTED", () => {
  const v = orderReadinessDecision(at(A, 7, 5000), at(B, 8, 1));
  assert.equal(v.kind, "adopt_new_instance");
  assert.equal(verdictApplies(v.kind), true, "and it is APPLIED to the screen");
  assert.match(v.reason, /backend has restarted/);
});

test("REPRODUCTION: the OLD strictly-increasing rule rejects that decision forever", () => {
  const oldRule = (current, incoming) => incoming > current;
  assert.equal(oldRule(5000, 1), false);
  assert.equal(oldRule(5000, 2), false);
  assert.equal(oldRule(5000, 3), false, "and every decision thereafter, indefinitely");
  assert.equal(orderReadinessDecision(at(A, 7, 5000), at(B, 8, 1)).kind, "adopt_new_instance");
});

test("no manual refresh is needed: the tracker rebases onto the new instance and keeps accepting", () => {
  const tracker = new ReadinessOrderTracker();
  tracker.offer(at(A, 7, 4999));
  tracker.offer(at(A, 7, 5000));
  assert.equal(tracker.rendered().decisionGeneration, 5000);

  // The restart.
  assert.equal(tracker.offer(at(B, 8, 1)).kind, "adopt_new_instance");
  assert.equal(tracker.rendered().instanceId, B, "the baseline is REBASED wholesale");
  assert.equal(tracker.rendered().bootOrdinal, 8);
  assert.equal(tracker.rendered().decisionGeneration, 1);

  // And the new instance's subsequent decisions keep flowing — the point of the fix.
  assert.equal(tracker.offer(at(B, 8, 2)).kind, "accept");
  assert.equal(tracker.offer(at(B, 8, 3)).kind, "accept");
  assert.equal(tracker.rendered().decisionGeneration, 3);
});

test("the fix does NOT accept every smaller generation", () => {
  const v = orderReadinessDecision(at(A, 7, 5000), at(A, 7, 4999));
  assert.equal(v.kind, "reject_stale");
  assert.equal(verdictApplies(v.kind), false);
});

/* ═══════════════ 2. delayed old-boot response after adoption ═══════════════ */

test("a delayed response from the SUPERSEDED instance is rejected after the new one is adopted", () => {
  const tracker = new ReadinessOrderTracker();
  tracker.offer(at(A, 7, 5000));
  tracker.offer(at(B, 8, 1));

  // A slow in-flight response from A lands, with a far HIGHER generation.
  const v = tracker.offer(at(A, 7, 5001));
  assert.equal(v.kind, "reject_stale", "the higher generation must not win: it is from a dead process");
  assert.match(v.reason, /superseded backend instance/);
  assert.equal(tracker.rendered().instanceId, B, "the adopted instance is untouched");
  assert.equal(tracker.rendered().decisionGeneration, 1);
  assert.equal(
    verdictDisablesEntry(v.kind),
    false,
    "a merely stale response must NOT disable entry: what is on screen is still the newest seen",
  );
});

/* ═══════════════ 3. a different random id is not automatically newer ═══════════════ */

test("an unfamiliar instance with NO ordinal is INCOMPATIBLE and DISABLES entry", () => {
  const v = orderReadinessDecision(at(A, 7, 100), at(B, null, 1));
  assert.equal(v.kind, "reject_incompatible");
  assert.equal(verdictDisablesEntry(v.kind), true, "unorderable readiness must disable new entry");
  assert.match(v.reason, /could not establish a durable boot ordinal/);
});

test("a backend with no instance identity at all is INCOMPATIBLE (pre-1.7.0 backend)", () => {
  const v = orderReadinessDecision(at(A, 7, 100), at(null, null, 101));
  assert.equal(v.kind, "reject_incompatible");
  assert.match(v.reason, /predates the instance-aware readiness contract/);
});

/* ═══════════════ 4. same-boot out-of-order and duplicates ═══════════════ */

test("same-boot: strictly increasing, duplicates and older responses refused", () => {
  assert.equal(orderReadinessDecision(at(A, 7, 10), at(A, 7, 11)).kind, "accept");
  assert.equal(orderReadinessDecision(at(A, 7, 10), at(A, 7, 10)).kind, "reject_stale");
  assert.equal(orderReadinessDecision(at(A, 7, 10), at(A, 7, 9)).kind, "reject_stale");
});

/* ═══════════════ 5. concurrent HTTP requests crossing a restart ═══════════════ */

test("concurrent responses crossing a restart resolve to the newest instance, whatever the order", () => {
  // box_status arrives from five places on this page; they are independent requests over one
  // connection pool and resolve out of order. Here a restart happens mid-flight.
  const tracker = new ReadinessOrderTracker();
  tracker.offer(at(A, 7, 4997));

  const arrivals = [
    at(A, 7, 4998),
    at(B, 8, 1),
    at(A, 7, 5000), // old instance, higher generation, arrives AFTER the new instance
    at(B, 8, 2),
    at(A, 7, 4999),
  ];
  const applied = [];
  for (const a of arrivals) {
    const v = tracker.offer(a);
    if (verdictApplies(v.kind)) applied.push(`${a.instanceId}:${a.decisionGeneration}`);
  }
  assert.deepEqual(applied, [`${A}:4998`, `${B}:1`, `${B}:2`]);
  assert.equal(tracker.rendered().instanceId, B);
  assert.equal(tracker.rendered().decisionGeneration, 2);
});

/* ═══════════════ 6. reconnection and component remount ═══════════════ */

test("a component REMOUNT accepts the current backend immediately", () => {
  // A remount starts with a fresh tracker (nothing rendered), so a legitimate first paint works even
  // when the backend's sequence is low after a restart.
  const remounted = new ReadinessOrderTracker();
  const v = remounted.offer(at(B, 8, 1));
  assert.equal(v.kind, "accept");
  assert.match(v.reason, /First orderable/);
});

test("a REMOUNT still refuses an unorderable payload", () => {
  const remounted = new ReadinessOrderTracker();
  assert.equal(remounted.offer(at(A, null, 1)).kind, "reject_incompatible");
  assert.equal(remounted.rendered().instanceId, null, "nothing was adopted");
  assert.notEqual(remounted.incompatibleReason(), null, "and the reason is retained for display");
});

test("an ORDERABLE decision replaces an UNORDERABLE one on screen, but not the reverse", () => {
  assert.equal(orderReadinessDecision(at(A, null, 5), at(B, 9, 1)).kind, "adopt_new_instance");
  assert.equal(orderReadinessDecision(at(B, 9, 5), at(A, null, 1)).kind, "reject_incompatible");
});

/* ═══════════════ 7. missing / incompatible readiness fields ═══════════════ */

test("readinessOrderOf tolerates whatever actually arrived, and never fabricates a 0", () => {
  assert.deepEqual(readinessOrderOf(statusWith(A, 8, 3)), {
    instanceId: A,
    bootOrdinal: 8,
    decisionGeneration: 3,
  });
  // A fabricated 0 would sort as the OLDEST possible instance and make an unorderable decision look
  // definitively stale, so absence must stay null.
  assert.deepEqual(readinessOrderOf({ operational_readiness: { decision_generation: 3 } }), {
    instanceId: null,
    bootOrdinal: null,
    decisionGeneration: 3,
  });
  assert.deepEqual(readinessOrderOf({}), { instanceId: null, bootOrdinal: null, decisionGeneration: null });
  assert.deepEqual(readinessOrderOf(null), { instanceId: null, bootOrdinal: null, decisionGeneration: null });
  assert.deepEqual(readinessOrderOf(undefined), { instanceId: null, bootOrdinal: null, decisionGeneration: null });
  // Non-finite and wrong-typed values are refused rather than coerced.
  assert.equal(readinessOrderOf(statusWith(A, Number.NaN, 3)).bootOrdinal, null);
  assert.equal(readinessOrderOf(statusWith(A, 8, Number.NaN)).decisionGeneration, null);
  assert.equal(readinessOrderOf(statusWith("", 8, 3)).instanceId, null);
});

test("a null payload is refused and reported, never treated as an empty success", () => {
  const tracker = new ReadinessOrderTracker();
  const v = tracker.offerStatus(null);
  assert.equal(v.kind, "reject_incompatible");
  assert.equal(verdictDisablesEntry(v.kind), true);
});

test("the incompatible reason is CLEARED once an orderable decision is applied", () => {
  const tracker = new ReadinessOrderTracker();
  tracker.offerStatus(null);
  assert.notEqual(tracker.incompatibleReason(), null);
  tracker.offer(at(A, 7, 1));
  assert.equal(tracker.incompatibleReason(), null, "a recovered backend must clear the banner");
});

/* ═══════════════ 8. multiple backends at one epoch ═══════════════ */

test("two backends reporting the SAME ordinal is INCOMPATIBLE and disables entry", () => {
  const v = orderReadinessDecision(at(A, 8, 100), at(B, 8, 1));
  assert.equal(v.kind, "reject_incompatible");
  assert.equal(verdictDisablesEntry(v.kind), true);
  assert.match(v.reason, /same boot ordinal 8/);
  assert.match(v.reason, /single backend process/);
});

/* ═══════════════ 9. no dependence on wall clocks ═══════════════ */

test("ordering consults no clock, so a skewed client cannot change any verdict", () => {
  assert.equal(orderReadinessDecision.length, 2, "exactly (rendered, incoming) — no clock argument");
  // A lower ordinal loses even when it claims a much later started_at.
  const late = { operational_readiness: { decision_generation: 99999, instance: { instance_id: A, boot_ordinal: 7, started_at: 9_999_999_999_999 } } };
  const v = orderReadinessDecision(at(B, 8, 1), readinessOrderOf(late));
  assert.equal(v.kind, "reject_stale", "started_at is audit-only and cannot promote a stale instance");
});

/* ═══════════════ 10. the contract and the component wiring ═══════════════ */

test("the vendored schema REQUIRES the instance object and documents the ordering", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../contract/schemas/operational-readiness.schema.json", import.meta.url), "utf8"),
  );
  assert.ok(schema.required.includes("instance"), "instance must be required, not optional");
  const inst = schema.properties.instance;
  assert.equal(inst.additionalProperties, false);
  assert.deepEqual(inst.required.sort(), ["boot_ordinal", "instance_id", "started_at"]);
  // Each field nullable, so "cannot be ordered" is expressible rather than defaulted.
  for (const f of ["instance_id", "boot_ordinal", "started_at"]) {
    assert.ok(inst.properties[f].type.includes("null"), `${f} must be nullable`);
  }
  // The corrected description of the counter that caused the defect.
  assert.match(schema.properties.decision_generation.description, /SCOPED TO instance\.instance_id/);
  assert.match(schema.properties.decision_generation.description, /resets to 0 on restart/);
  assert.match(inst.properties.started_at.description, /never used for ordering/);
});

test("the contract version and the backend pin move TOGETHER", () => {
  const version = JSON.parse(readFileSync(new URL("../contract/version.json", import.meta.url), "utf8"));
  const pin = JSON.parse(readFileSync(new URL("../contract/BACKEND_CONTRACT.json", import.meta.url), "utf8"));
  // Pinned to the CURRENT contract version, deliberately as a literal: this assertion exists to fail
  // when the contract moves without the pin and the generated types moving with it, so reading it from
  // the file it is checking would defeat the purpose.
  assert.equal(version.contract_version, "1.8.0");
  assert.equal(
    pin.contract_version,
    version.contract_version,
    "the pin must name the same contract version it vendors",
  );
  assert.equal(
    pin.schemas_sha256,
    version.schemas_sha256,
    "and the same digest — contract:verify checks the digest, only this checks they agree",
  );
  assert.match(pin.backend_sha, /^[0-9a-f]{40}$/, "the pinned backend SHA must be a real commit id");
});

test("Box.tsx uses the ORDERING TRACKER and no longer the bare generation comparison", () => {
  const box = readFileSync(new URL("../src/Box.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(box.includes("new ReadinessOrderTracker()"), "the component must hold the tracker");
  assert.ok(box.includes("readinessOrder.current.offerStatus("), "and route every payload through it");
  assert.ok(
    !box.includes("acceptStatus("),
    "the restart-blind generation guard must no longer decide whether a status is applied",
  );
  assert.ok(
    box.includes("verdictDisablesEntry("),
    "an unorderable payload must visibly disable entry rather than be silently dropped",
  );
  assert.ok(
    box.includes("readinessIncompatible"),
    "and the reason must be rendered for the operator",
  );
});

/* ═══════════════ 11. the server remains the authority ═══════════════ */

test("this module never grants permission — it only orders evidence", () => {
  // A UI ordering rule is not a safety boundary. Every verdict here is about WHICH payload to render;
  // none of them can turn a refusal into a permission, and the backend revalidates every entry request
  // independently (and itself refuses entry when its own epoch is unknown).
  const surface = Object.keys({ orderReadinessDecision, readinessOrderOf, verdictApplies, verdictDisablesEntry });
  for (const name of surface) {
    assert.ok(
      !/permit|allow|arm|authorise|authorize|enable/i.test(name),
      `${name} must not read as a permission-granting API`,
    );
  }
  // And the strictest verdict available is "do not show this", never "allow entry".
  const v = orderReadinessDecision(NOTHING, at(A, 1, 1));
  assert.equal(v.kind, "accept");
  assert.equal(Object.keys(v).sort().join(","), "kind,reason", "a verdict carries no permission field");
});
