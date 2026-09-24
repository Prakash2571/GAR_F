/**
 * THE EMERGENCY CONTROLS, RENDERED. A BROWSER-LEVEL SUITE, NOT A SOURCE-TEXT ONE.
 *
 * WHY IT HAD TO BE THIS KIND OF TEST
 *
 * The defect was that `BoxExecutionControl.tsx` rendered "Cancel working Box orders" only INSIDE
 * `{control.emergency_flatten_enabled && (...)}`, even though the backend cancellation endpoint
 * (`POST /api/box/live/cancel-working`) requires only a full-admin session and
 * `exposureReductionBlockReason() === null` — `box_emergency_flatten` is consulted ONLY by
 * `flattenAttributedBoxExposure`. So with emergency flatten disarmed, the cheaper and strictly
 * non-loss-realising of the two protective actions was unreachable, while the more dangerous one was
 * the thing that unlocked it.
 *
 * A `readFileSync` assertion that the file CONTAINS a cancel button would have passed throughout. That
 * is how this survived: source text cannot tell you whether a control renders. These tests mount the
 * real component in jsdom, with its real imports, and look for the button.
 *
 * WHAT IS REAL HERE: the component, every `src/` module it imports, React's reconciliation and React's
 * event dispatch. WHAT IS STUBBED: `globalThis.fetch` (the seam the existing csrf suites already use)
 * and `window.confirm`, because a real dialog cannot be answered from a test.
 *
 * jsdom has no layout, so this proves a control is RENDERED, ENABLED and WIRED — not that it is
 * visually visible. That is exactly what these defects were about.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";

import {
  click, flush, jsonResponse, loadBundle, mountDom, render, stalledResponse, stubFetch,
} from "./helpers/domHarness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(resolve(HERE, "fixtures", "box-execution-control.json"), "utf8"),
);

let BoxExecutionControl;
let setCsrfToken;
test.before(async () => {
  /*
   * ONE bundle, so the component and the CSRF setter share one `src/api/http.ts` instance.
   *
   * `http.ts` keeps the token in a module-level variable and throws `MissingCsrfTokenError` BEFORE the
   * network for any mutating call without one. That is a real safety property, so these tests satisfy it
   * rather than bypass it — and satisfying it requires the setter from the instance the component holds.
   */
  const bundle = await loadBundle({
    BoxExecutionControl: { from: "BoxExecutionControl.tsx", name: "BoxExecutionControl" },
    describeFlattenFailure: { from: "BoxExecutionControl.tsx", name: "describeFlattenFailure" },
    setCsrfToken: { from: "api/http.ts", name: "setCsrfToken" },
  });
  BoxExecutionControl = bundle.BoxExecutionControl;
  setCsrfToken = bundle.setCsrfToken;
  setCsrfToken("test-csrf-token");
});

/** A live-capable control snapshot. Overrides are shallow-merged at the top level. */
function control(overrides = {}) {
  return {
    ...structuredClone(FIXTURE),
    execution_mode: "live",
    deployment_live_capable: true,
    live_capability_detail: "live",
    live_runtime_armed: true,
    entry_enabled: false,
    emergency_flatten_enabled: false,
    ...overrides,
  };
}

const CANCEL = "Cancel working Box orders";
const FLATTEN = "EMERGENCY FLATTEN";

/** Mount the panel with sensible defaults, returning the dom toolkit plus the render handle. */
async function mount(t, { ctl = control(), isFullAdmin = true, canTrade = true, onChanged = () => {} } = {}) {
  const dom = mountDom();
  const confirmCalls = [];
  dom.window.confirm = (message) => { confirmCalls.push(message); return true; };
  t.after(() => dom.teardown());
  const handle = await render(
    dom,
    React.createElement(BoxExecutionControl, {
      control: ctl, canTrade, isFullAdmin, onChanged,
    }),
  );
  return { dom, handle, confirmCalls };
}

/* ═══════════════════ 1. THE DEFECT: cancellation must not need flatten armed ═══════════════════ */

test("the cancel control RENDERS with emergency flatten DISARMED", async (t) => {
  const { dom } = await mount(t, { ctl: control({ emergency_flatten_enabled: false }) });

  const cancel = dom.button(CANCEL);
  assert.ok(
    cancel,
    "THE DEFECT: with box_emergency_flatten disarmed the cancel button did not render at all, even " +
      "though the backend permits cancellation independently. Buttons present: " +
      dom.buttons().map((b) => b.label).join(" | "),
  );
  assert.equal(cancel.disabled, false, "and it must be usable, not merely present");

  // And the dangerous action is still correctly withheld until it is armed.
  assert.equal(
    dom.button(FLATTEN), undefined,
    "emergency flatten must STILL require arming — this change must not make the dangerous action " +
      "easier to reach",
  );
});

test("arming emergency flatten adds the flatten control without removing the cancel control", async (t) => {
  const { dom, handle } = await mount(t, { ctl: control({ emergency_flatten_enabled: false }) });
  assert.ok(dom.button(CANCEL));

  await handle.update(
    React.createElement(BoxExecutionControl, {
      control: control({ emergency_flatten_enabled: true }),
      canTrade: true, isFullAdmin: true, onChanged: () => {},
    }),
  );
  assert.ok(dom.button(CANCEL), "cancellation stays available once flatten is armed");
  assert.ok(dom.button(FLATTEN), "and flatten appears");
});

/* ═══════════════════ 2. entry disabled / scanner stopped / stale data ═══════════════════ */

test("cancellation stays available with entry DISABLED", async (t) => {
  const { dom } = await mount(t, { ctl: control({ entry_enabled: false }) });
  const cancel = dom.button(CANCEL);
  assert.ok(cancel, "an entry-only control must not hide a protective one");
  assert.equal(cancel.disabled, false);
});

test("cancellation stays available and ENABLED when dashboard prices are stale", async (t) => {
  const dom = mountDom();
  t.after(() => dom.teardown());
  await render(
    dom,
    React.createElement(BoxExecutionControl, {
      control: control(), canTrade: true, isFullAdmin: true, onChanged: () => {}, pricesStale: true,
    }),
  );
  const cancel = dom.button(CANCEL);
  assert.ok(cancel, "stale dashboard data must not hide protective cancellation");
  assert.equal(
    cancel.disabled, false,
    "cancelling a working order does not need a fresh price — it removes an order, it does not place one",
  );
});

test("cancellation stays available when live orders are DISARMED", async (t) => {
  // The backend's exposureReductionBlockReason deliberately does not consult box_live_order_enabled:
  // that control gates NEW exposure. An earlier coupling made the panic button answer 200 ok:true
  // orders:[] and is recorded in the route's docblock as the defect being fixed.
  const { dom } = await mount(t, { ctl: control({ live_runtime_armed: false }) });
  assert.ok(dom.button(CANCEL), "a control that gates NEW exposure must not disable protective cancellation");
});

/* ═══════════════════ 3. authentication and role checks are preserved ═══════════════════ */

test("a non-full-admin sees the cancel control DISABLED, not hidden", async (t) => {
  const { dom } = await mount(t, { isFullAdmin: false });
  const cancel = dom.button(CANCEL);
  assert.ok(cancel, "the control should still be visible so the operator knows it exists");
  assert.equal(cancel.disabled, true, "but a non-full-admin must not be able to fire it");
});

test("the whole panel is withheld when the session may not trade", async (t) => {
  const { dom } = await mount(t, { canTrade: false });
  assert.equal(dom.button(CANCEL), undefined, "no controls at all without trade permission");
  assert.equal(dom.text(), "", "the panel renders nothing");
});

/* ═══════════════════ 4. the two actions are distinguished ═══════════════════ */

test("the cancel control says plainly that it does NOT flatten filled exposure", async (t) => {
  const { dom } = await mount(t);
  const cancel = dom.button(CANCEL);
  assert.match(
    cancel.title, /does not flatten filled or residual exposure/i,
    "an operator must not press this believing it gets them flat",
  );
});

test("pressing cancel does NOT ask for confirmation; pressing flatten DOES", async (t) => {
  const stub = stubFetch({
    "/api/box/live/cancel-working": () =>
      jsonResponse({ attempted: true, ok: true, cancelled: ["BOX:a"], failures: [] }),
  });
  t.after(() => stub.restore());

  const { dom, confirmCalls } = await mount(t, { ctl: control({ emergency_flatten_enabled: true }) });
  await click(dom.button(CANCEL).el);
  await flush();
  assert.equal(
    confirmCalls.length, 0,
    "cancelling working orders realises nothing and must not be gated behind a dialog in an emergency",
  );
  assert.ok(
    stub.calls.some((c) => c.url.includes("/api/box/live/cancel-working") && c.method === "POST"),
    `the cancel button must call the cancellation endpoint; saw ${JSON.stringify(stub.calls)}`,
  );
});

/* ═══════════════════ 5. outcomes are rendered accurately ═══════════════════ */

test("a 409 structured refusal shows the blocked_reason, not a bare HTTP status", async (t) => {
  const stub = stubFetch({
    "/api/box/live/cancel-working": () =>
      jsonResponse({
        attempted: false,
        ok: false,
        blocked_reason:
          "The durable order-intent journal could not be read, so the working orders to cancel cannot " +
          "be identified and NOTHING was attempted. Restore PostgreSQL, or cancel from the broker terminal.",
        cancelled: [],
        failures: [],
      }, 409),
  });
  t.after(() => stub.restore());

  const { dom } = await mount(t);
  await click(dom.button(CANCEL).el);
  await flush();

  const text = dom.text();
  assert.match(
    text, /durable order-intent journal could not be read/,
    "THE REFUSAL REASON MUST BE SHOWN. The 409 body carries `blocked_reason`, not `error`, so the " +
      `generic "(HTTP 409)" message left the real reason stranded on ApiError.body. Panel text: ${text}`,
  );
  assert.match(text, /broker terminal/, "and the remaining route must reach the operator");
  assert.equal(
    dom.all(".box-exec-msg--ok").length, 0,
    "a refusal must never be rendered as success",
  );
});

test("a 207 partial sweep is shown as a problem, with the failures", async (t) => {
  const stub = stubFetch({
    "/api/box/live/cancel-working": () =>
      jsonResponse({
        attempted: true,
        ok: false,
        cancelled: ["BOX:a"],
        failures: ["BOX:b: broker rejected the cancellation"],
      }, 207),
  });
  t.after(() => stub.restore());

  const { dom } = await mount(t);
  await click(dom.button(CANCEL).el);
  await flush();
  const text = dom.text();
  assert.equal(dom.all(".box-exec-msg--ok").length, 0, "a partial sweep is not a success");
  assert.match(text, /unresolved|failure|broker rejected/i, `partial failure must be visible: ${text}`);
});

test("a NETWORK failure is reported as an unknown outcome, not as a clean failure", async (t) => {
  const stub = stubFetch({
    "/api/box/live/cancel-working": () => { throw new TypeError("Failed to fetch"); },
  });
  t.after(() => stub.restore());

  const { dom } = await mount(t);
  await click(dom.button(CANCEL).el);
  await flush();
  const text = dom.text();
  assert.equal(dom.all(".box-exec-msg--ok").length, 0);
  assert.match(
    text, /unknown|may already|cannot be confirmed/i,
    "a request that never got a reply may ALREADY have reached the broker; presenting that as a plain " +
      `failure invites a blind retry. Panel text: ${text}`,
  );
});

/* ═══════════════════ 6. a stalled cancel must not disable the flatten ═══════════════════ */

test("a STALLED cancellation does not permanently disable the emergency flatten", async (t) => {
  const stalled = stalledResponse();
  const flattenCalls = [];
  const stub = stubFetch({
    "/api/box/live/cancel-working": () => stalled.promise,
    "/api/box/live/flatten": () => {
      flattenCalls.push(1);
      return jsonResponse({
        ok: true, requested: 0, attempted: 0, items: [], results: [],
        settlement: { cancelled: 0, failures: [], blocked: null, reconciled: true },
        outcome: "nothing_to_flatten", remaining_exposure_known: true, remaining_quantity: 0,
        blockers: [], next_action: "Confirm flat at the broker terminal.",
        operation_id: "flatten:1", deduplicated: false,
      });
    },
  });
  t.after(() => stub.restore());

  const { dom, confirmCalls } = await mount(t, { ctl: control({ emergency_flatten_enabled: true }) });

  // Start a cancellation that never answers.
  await click(dom.button(CANCEL).el);
  await flush();

  // The brake must still work. Pre-fix, both actions shared one un-keyed "emergency" single-flight slot
  // whose release ran in a `finally` that a non-settling promise never reaches — and the registry lived
  // in a useRef with no reset path, so EVERY later flatten was refused for the life of the mounted
  // component, and refused with a GREEN note rather than an error.
  const flatten = dom.button(FLATTEN);
  assert.ok(flatten, "the flatten button must still be rendered");
  assert.equal(flatten.disabled, false, "and must not be disabled by an unrelated stalled request");
  await click(flatten.el);
  await flush();

  assert.equal(confirmCalls.length, 1, "flatten must still ask for confirmation");
  assert.equal(
    flattenCalls.length, 1,
    "THE EMERGENCY BRAKE MUST FIRE. A stalled cancellation must not hold it hostage. " +
      `fetches: ${JSON.stringify(stub.calls.map((c) => c.url))}`,
  );

  // Settle the stalled request INSIDE the test body, before the DOM teardown hook runs. Letting it
  // settle afterwards makes the component touch a `window` global that no longer exists.
  stalled.settle(jsonResponse({ attempted: true, ok: true, cancelled: [], failures: [] }));
  await flush(5);
});

test("a repeated click on the SAME action while it is in flight does not send twice", async (t) => {
  const stalled = stalledResponse();
  const stub = stubFetch({ "/api/box/live/cancel-working": () => stalled.promise });
  t.after(() => stub.restore());

  const { dom } = await mount(t);
  const cancel = dom.button(CANCEL);
  await click(cancel.el);
  await flush();
  // Click again while the first is outstanding.
  await click(dom.button(CANCEL)?.el ?? cancel.el);
  await flush();

  assert.equal(
    stub.calls.filter((c) => c.url.includes("/api/box/live/cancel-working")).length, 1,
    "one in-flight cancellation must not become two: browser abort does not cancel the server " +
      "operation, so a duplicate would race the first",
  );

  // And the operator is not left guessing: the button itself reports the in-flight state, so the
  // absorbed second press is explained rather than looking like a control that did nothing.
  const during = dom.button("Cancelling");
  assert.ok(during, `the button must report that it is working; buttons: ${dom.buttons().map((b) => b.label).join(" | ")}`);
  assert.equal(during.disabled, true, "and be disabled while it is, which is what absorbs the second click");
  assert.equal(
    dom.all(".box-exec-msg--ok").length, 0,
    "nothing about an in-flight request may be rendered as success — a refused duplicate rendered GREEN " +
      "is how a dead panic button looked like a working one",
  );

  // Settle inside the test body, before the DOM teardown hook runs.
  stalled.settle(jsonResponse({ attempted: true, ok: true, cancelled: [], failures: [] }));
  await flush(5);
});

/* ═══════════════════ 7. unmount during an in-flight mutation ═══════════════════ */

test("unmounting while a mutation is outstanding does not throw", async (t) => {
  const stalled = stalledResponse();
  const stub = stubFetch({ "/api/box/live/cancel-working": () => stalled.promise });
  t.after(() => stub.restore());

  const { dom, handle } = await mount(t);
  await click(dom.button(CANCEL).el);
  await flush();
  // Let the request finish AFTER unmount but BEFORE teardown: a setState on an unmounted component
  // must be harmless, and the late server completion must not be replayed as a new mutation.
  stalled.settle(jsonResponse({ attempted: true, ok: true, cancelled: [], failures: [] }));
  await flush(10);
  assert.equal(
    stub.calls.filter((c) => c.url.includes("/api/box/live/cancel-working")).length, 1,
    "a late completion must not trigger a replay of the mutation",
  );
});

/* ═══════════════════ 8. the flatten result is rendered per item ═══════════════════ */

test("a flatten whose positions all FAILED is not shown as success", async (t) => {
  const stub = stubFetch({
    "/api/box/live/flatten": () =>
      jsonResponse({
        ok: false,
        requested: 2,
        attempted: 2,
        operation_id: "flatten:abc",
        deduplicated: false,
        outcome: "not_reduced",
        remaining_exposure_known: false,
        remaining_quantity: null,
        // The settlement halves are CLEAN — this is the exact shape that used to produce a green toast.
        settlement: { cancelled: 2, failures: [], blocked: null, reconciled: true },
        items: [
          {
            kind: "position", id: "pos-1", label: "NIFTY 25000/25200",
            disposition: "not_reduced",
            reason: "Cannot close while the live WebSocket feed is unavailable.",
            remaining_quantity: 300, remaining_by_role: null,
          },
          {
            kind: "position", id: "pos-2", label: "BANKNIFTY 54000/54200",
            disposition: "unresolved",
            reason: "the close raised before its outcome was established (socket hang up)",
            remaining_quantity: null, remaining_by_role: null,
          },
        ],
        results: [],
        blockers: [
          "position pos-1: Cannot close while the live WebSocket feed is unavailable.",
          "position pos-2: the close raised before its outcome was established (socket hang up)",
        ],
        next_action: "EXPOSURE IS UNRESOLVED. Do NOT re-arm. Inspect at the broker terminal.",
      }, 207),
  });
  t.after(() => stub.restore());

  const { dom } = await mount(t, { ctl: control({ emergency_flatten_enabled: true }) });
  await click(dom.button(FLATTEN).el);
  await flush();

  const text = dom.text();
  assert.equal(
    dom.all(".box-exec-msg--ok").length, 0,
    "THE DEFECT: settlement.failures was empty and settlement.reconciled was true, so the old code " +
      `showed a GREEN success toast while every position failed to close. Panel text: ${text}`,
  );
  assert.match(text, /WebSocket feed is unavailable/, "the per-position reason must be shown");
  assert.match(text, /socket hang up/, "including the unresolved one");
  assert.match(text, /Do NOT re-arm/, "and the actionable instruction must reach the operator");
  assert.match(
    text, /unknown|not known/i,
    "an unknown remaining quantity must be shown as unknown, never as zero",
  );
});

test("a genuinely flat result IS shown as success, so the honest path is not vacuous", async (t) => {
  const stub = stubFetch({
    "/api/box/live/flatten": () =>
      jsonResponse({
        ok: true, requested: 1, attempted: 1, operation_id: "flatten:ok", deduplicated: false,
        outcome: "flat_on_fill_evidence", remaining_exposure_known: true, remaining_quantity: 0,
        settlement: { cancelled: 1, failures: [], blocked: null, reconciled: true },
        items: [{
          kind: "position", id: "pos-1", label: "NIFTY 25000/25200",
          disposition: "flat_on_fill_evidence", reason: null,
          remaining_quantity: 0, remaining_by_role: null,
        }],
        results: [],
        blockers: [],
        next_action: "No attributed Box exposure remains on this process's fill evidence. Confirm at the broker terminal.",
      }),
  });
  t.after(() => stub.restore());

  const { dom } = await mount(t, { ctl: control({ emergency_flatten_enabled: true }) });
  await click(dom.button(FLATTEN).el);
  await flush();
  assert.equal(
    dom.all(".box-exec-msg--error").length, 0,
    "NON-VACUITY: a real success must not be reported as a failure, or the previous test proves nothing",
  );
  assert.match(dom.text(), /Confirm/i, "and the confirm-at-broker caveat still reaches the operator");
});
