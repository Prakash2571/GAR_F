/**
 * The Synthetic page's execution-mode display logic and live-control calls.
 *
 *   • the header badge is derived only from the server's status (mode, armed, breaker);
 *   • per-leg quantities come from the trade's fills, with legacy paper_touch rows handled;
 *   • incomplete and quarantined positions explain themselves;
 *   • arming is only offered when the standing gates hold (the server re-checks anyway);
 *   • live-control calls carry the typed confirmation and the SYNTH CSRF token.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ENTRY_BLOCK_LABEL,
  armGates,
  formatSettingValue,
  istTime,
  legQty,
  legTimeline,
  modeBadge,
  outstandingQty,
  positionState,
  residualText,
  runSummary,
} from "../src/lib/synthView.ts";
import { armSynthLive, closeSynthTrade, disarmSynthLive, reconcileSynthLive, synthVerify } from "../src/api/synth.ts";

const status = (over) => ({ execution_mode: "paper_touch", live_orders: false, live_armed: false, live_breaker: null, ...over });

test("the mode badge is derived only from the server's status", () => {
  assert.equal(modeBadge(null).text, "PAPER");
  assert.deepEqual(
    [modeBadge(status({ execution_mode: "paper_legging" })).text, modeBadge(status({ execution_mode: "paper_legging" })).tone],
    ["PAPER · LEGGING", "info"],
  );
  assert.equal(modeBadge(status({ execution_mode: "paper_legging_live_parity" })).text, "PAPER · LIVE PARITY");
  const disarmed = modeBadge(status({ execution_mode: "live" }));
  assert.deepEqual([disarmed.text, disarmed.tone], ["LIVE · DISARMED", "warning"]);
  const armed = modeBadge(status({ execution_mode: "live", live_orders: true, live_armed: true }));
  assert.deepEqual([armed.text, armed.tone], ["LIVE · ARMED", "negative"]);
  const tripped = modeBadge(status({ execution_mode: "live", live_orders: true, live_armed: true, live_breaker: "2 unresolved" }));
  assert.equal(tripped.text, "LIVE · BREAKER OPEN", "an open breaker outranks being armed");
});

test("leg quantities come from the fills; legacy paper_touch rows use the trade quantity", () => {
  const legacy = { execution_mode: "paper_touch", quantity: 75, status: "open" };
  assert.equal(legQty(legacy, { qty: 0 }), 75);
  assert.equal(outstandingQty(legacy, { qty: 0, exit_qty: 0 }), 75);
  const residual = { execution_mode: "paper_legging", quantity: 75, status: "open" };
  assert.equal(legQty(residual, { qty: 0 }), 0, "a leg that never filled holds nothing");
  assert.equal(outstandingQty(residual, { qty: 75, exit_qty: 25 }), 50);
  assert.equal(outstandingQty({ ...residual, status: "closed" }, { qty: 75, exit_qty: 0 }), 0);
});

test("position state precedence: quarantine, then pending, residual, closing", () => {
  const p = { quarantined: false, entry_pending: false, residual: false, closing: false };
  assert.equal(positionState(p), "open");
  assert.equal(positionState({ ...p, closing: true }), "closing");
  assert.equal(positionState({ ...p, closing: true, residual: true }), "residual");
  assert.equal(positionState({ ...p, residual: true, quarantined: true }), "quarantined");
});

test("incomplete and quarantined positions explain themselves", () => {
  const base = { quarantined: false, quarantine_reason: null, residual: false, residual_reason: null, flatten_halted: false,
    flatten_attempts: 0, flatten_rejects: 0, entry_pending: false, execution_mode: "live" };
  assert.equal(residualText(base), null, "a complete position needs no note");
  assert.match(residualText({ ...base, quarantined: true, quarantine_reason: "fut outcome unknown" }), /QUARANTINED: fut outcome unknown.*reconciled/);
  assert.match(residualText({ ...base, residual: true, residual_reason: "partial exit", flatten_attempts: 2 }), /INCOMPLETE.*partial exit.*2 attempt/);
  assert.match(residualText({ ...base, residual: true, flatten_halted: true, flatten_rejects: 5 }), /stopped after 5 broker rejection/);
});

test("run summaries and timelines are relative to detection", () => {
  const run = {
    detected_at: 1000,
    refused: "",
    aborted: "feed unhealthy",
    uncertain: false,
    legs: [
      { status: "FILLED", submit_at: 1040, ack_at: 1290, first_fill_at: 1290, resolved_at: 1290 },
      { status: "NOT_SENT", submit_at: null, ack_at: null, first_fill_at: null, resolved_at: null },
    ],
  };
  assert.equal(runSummary(run), "1/2 legs filled · stopped: feed unhealthy");
  assert.equal(runSummary({ ...run, aborted: "", uncertain: true }), "1/2 legs filled · an outcome is UNPROVEN");
  assert.equal(runSummary(null), "-");
  assert.equal(legTimeline(run.legs[0], run), "sent +40ms → ack +290ms → fill +290ms → done +290ms");
  assert.equal(legTimeline(run.legs[1], run), "sent - → ack - → done -");
});

test("arming is offered only when the standing gates hold; entry limits do not block arming", () => {
  const gates = [
    { key: "consent", label: "Server permits live orders on zerodha", ok: true },
    { key: "mode", label: "Execution mode is live", ok: true },
    { key: "session", label: "zerodha session connected", ok: true },
    { key: "breaker", label: "Circuit breaker closed", ok: true },
    { key: "intents", label: "No unresolved live orders", ok: true },
    { key: "quarantine", label: "No quarantined live position", ok: true },
    { key: "armed", label: "Armed", ok: false },
    { key: "open", label: "Open live positions below 1", ok: false },
  ];
  assert.deepEqual(armGates({ gates }), { ok: true, missing: [] });
  const blocked = armGates({ gates: gates.map((g) => (g.key === "breaker" ? { ...g, ok: false } : g)) });
  assert.deepEqual(blocked, { ok: false, missing: ["Circuit breaker closed"] });
});

test("every live entry-block code the server emits has a label", () => {
  for (const code of ["live_not_permitted", "live_mode", "live_disarmed", "live_breaker", "live_unresolved", "live_session",
    "live_busy", "live_quarantine", "live_max_open", "live_lots", "live_daily_loss"]) {
    assert.ok(ENTRY_BLOCK_LABEL[code], code);
  }
  const setting = { kind: "enum", unit: "" };
  assert.equal(formatSettingValue(setting, "paper_legging_live_parity"), "Paper · live parity");
  assert.equal(formatSettingValue(setting, "hedge_sequential"), "Hedge-first, one leg at a time");
  assert.equal(istTime(Date.UTC(2026, 8, 29, 5, 45, 7)), "11:15:07");
});

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

test("live controls carry the typed confirmation and the synth CSRF token", async () => {
  const calls = stubFetch((url) =>
    String(url).endsWith("/access/verify")
      ? json(200, { authenticated: true, csrf_token: "SYNTH-TOKEN" })
      : String(url).endsWith("/trades/abc/close")
        ? json(202, { ok: true, async: true, trade: { id: "abc", underlying: "NIFTY" }, open: [], status: {} })
        : json(200, { ok: true, execution: { mode: "live" }, status: { live_armed: true }, reconcile: { examined: 0, unresolved_intents: [] }, open: [] }),
  );
  await synthVerify("passcode");
  await armSynthLive("ARM LIVE");
  const arm = calls.at(-1);
  assert.equal(arm.url, "/api/synth/live/arm");
  assert.equal(arm.init.method, "POST");
  assert.deepEqual(JSON.parse(arm.init.body), { confirm: "ARM LIVE" });
  assert.equal(arm.init.headers["x-csrf-token"], "SYNTH-TOKEN");
  await disarmSynthLive();
  assert.equal(calls.at(-1).url, "/api/synth/live/disarm");
  await reconcileSynthLive();
  assert.equal(calls.at(-1).url, "/api/synth/live/reconcile");
  const closed = await closeSynthTrade("abc");
  assert.equal(closed.async, true, "an execution-mode close is started, not finished");
});
