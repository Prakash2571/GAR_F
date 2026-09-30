/**
 * The Synthetic page's fast live-update pipeline:
 *   • only the newest snapshot is parsed, once per frame;
 *   • unchanged parts keep their identity (so memoised rows/cards skip rendering), matched by
 *     row identity even when the ranking reorders them;
 *   • the cached formatters print exactly what the shared ones print.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { LatestFrame, expiryLabel, liveAgeText, money, num2, shareEqual } from "../src/lib/synthLive.ts";
import { fmt, fmtMoney, formatExpiry } from "../src/format.ts";

const row = (key, net, age = 100) => ({
  key,
  expected_net_profit: net,
  worst_age_ms: age,
  updated_at: 1,
  legs: [
    { role: "fut", price: 24400, age_ms: age },
    { role: "ce", price: 300, age_ms: age },
  ],
});

test("an identical frame returns the previous object: nothing re-renders", () => {
  const prev = { status: { running: true, server_time: 1, day_pnl: { total_net_pnl: 5 } }, opportunities: [row("a", 1), row("b", 2)] };
  prev.status.evaluated_at = 1;
  const next = JSON.parse(JSON.stringify(prev));
  next.status.server_time = 2; // change every frame, never shown
  next.status.evaluated_at = 2;
  next.opportunities[0].updated_at = 99;
  assert.equal(shareEqual(prev, next), prev);
});

test("rows are matched by identity: a reordered, unchanged row is reused", () => {
  const prev = [row("a", 1), row("b", 2), row("c", 3)];
  const next = [row("c", 3), row("a", 1), row("b", 20)];
  const out = shareEqual(prev, next);
  assert.notEqual(out, prev, "the list changed");
  assert.equal(out[0], prev[2], "c moved to the top unchanged: same object");
  assert.equal(out[1], prev[0]);
  assert.notEqual(out[2], prev[1], "b's net changed");
  assert.equal(out[2].expected_net_profit, 20);
  assert.equal(out[2].legs, prev[1].legs, "b's unchanged legs are still shared");
});

test("a live age is equal while it DISPLAYS the same", () => {
  const prev = [row("a", 1, 120)];
  assert.equal(shareEqual(prev, [row("a", 1, 480)]), prev, "both show <1s");
  const out = shareEqual(prev, [row("a", 1, 1500)]);
  assert.notEqual(out, prev, "<1s → 1s is a visible change");
  assert.equal(liveAgeText(999), "<1s");
  assert.equal(liveAgeText(1000), "1s");
  assert.equal(liveAgeText(59_999), "59s");
  assert.equal(liveAgeText(120_000), "2m");
  assert.equal(liveAgeText(null), "-");
});

test("added, removed and nested changes are never hidden", () => {
  const prev = { list: [row("a", 1)], s: { n: 1, deep: { x: [1, 2] } } };
  assert.equal(shareEqual(prev, { list: [row("a", 1), row("b", 2)], s: prev.s }).list.length, 2);
  assert.equal(shareEqual(prev, { list: [], s: prev.s }).list.length, 0);
  const deep = shareEqual(prev, { list: prev.list, s: { n: 1, deep: { x: [1, 3] } } });
  assert.deepEqual(deep.s.deep.x, [1, 3]);
  assert.equal(deep.list, prev.list);
  assert.equal(shareEqual(prev, { list: prev.list, s: { n: 1, deep: { x: [1, 2] }, extra: true } }).s.extra, true);
  assert.equal(shareEqual(null, row("a", 1)).key, "a");
});

test("only the newest frame is parsed, once per scheduled frame", () => {
  const scheduled = [];
  const applied = [];
  let parses = 0;
  const f = new LatestFrame(
    (v) => applied.push(v),
    { schedule: (fn) => scheduled.push(fn), cancel: () => {} },
    (raw) => {
      parses++;
      return JSON.parse(raw);
    },
  );
  f.push('{"n":1}');
  f.push('{"n":2}');
  f.push('{"n":3}');
  assert.equal(scheduled.length, 1, "one frame is scheduled for any number of pushes");
  scheduled.shift()();
  assert.deepEqual(applied, [{ n: 3 }]);
  assert.equal(parses, 1, "the two superseded frames were never parsed");
  assert.deepEqual([f.received, f.applied], [3, 1]);
  f.push("{not json");
  scheduled.shift()();
  assert.equal(applied.length, 1, "a malformed frame is dropped");
  f.push('{"n":4}');
  f.stop();
  assert.equal(applied.length, 1, "a stopped pipeline applies nothing");
});

test("the cached formatters print exactly what the shared ones print", () => {
  for (let i = -3000; i <= 3000; i++) {
    const v = i * 173.37 + (i % 7) * 0.005;
    assert.equal(money(v), fmtMoney(v), `money(${v})`);
    assert.equal(num2(v), fmt(v));
  }
  for (const v of [null, undefined, NaN, 0, 1e7, -0.004]) {
    assert.equal(money(v), fmtMoney(v));
    assert.equal(num2(v), fmt(v));
  }
  for (const d of ["2026-10-27", "2026-01-01", "2026-12-31", "not-a-date"]) {
    assert.equal(expiryLabel(d), formatExpiry(d));
    assert.equal(expiryLabel(d), formatExpiry(d), "memoised result is the same");
  }
});
