/**
 * Synthetic page display logic: filters, fill-evidence checks, merges and settings drafts.
 * The backend decides; these only label, filter and pre-check what it published.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAgainstBook,
  fillVerdict,
  filterRows,
  mergeClosed,
  parseDraft,
  groupByDay,
  heldText,
} from "../src/lib/synthView.ts";
import { synthStreamUrl } from "../src/api/synth.ts";

const row = (u, dir, gross, key) => ({ underlying: u, direction: dir, gross_edge: gross, key });

test("filterRows keeps the first (best) row per underlying and honours direction/search", () => {
  const rows = [row("NIFTY", "CONVERSION", 10, "a"), row("NIFTY", "REVERSAL", 5, "b"), row("SBIN", "REVERSAL", -1, "c")];
  const base = { direction: "all", bestOnly: false, positiveOnly: false, search: "" };
  assert.deepEqual(filterRows(rows, { ...base, bestOnly: true }).map((r) => r.key), ["a", "c"]);
  assert.deepEqual(filterRows(rows, { ...base, direction: "REVERSAL" }).map((r) => r.key), ["b", "c"]);
  assert.deepEqual(filterRows(rows, { ...base, positiveOnly: true }).map((r) => r.key), ["a", "b"]);
  assert.deepEqual(filterRows(rows, { ...base, search: "sb" }).map((r) => r.key), ["c"]);
});

test("a fill is 'at best' only at the best level, with the quantity there, on an uncrossed book", () => {
  const depth = { bids: [{ price: 99, qty: 75 }], asks: [{ price: 100, qty: 75 }] };
  assert.equal(checkAgainstBook(100, "BUY", depth, 75), true);
  assert.equal(checkAgainstBook(99, "SELL", depth, 75), true);
  assert.equal(checkAgainstBook(100.5, "BUY", depth, 75), false, "not the best ask");
  assert.equal(checkAgainstBook(100, "BUY", depth, 150), false, "less than the quantity rested");
  assert.equal(checkAgainstBook(100, "BUY", { bids: [{ price: 100, qty: 75 }], asks: [{ price: 100, qty: 75 }] }, 75), false, "crossed");
  assert.equal(checkAgainstBook(100, "BUY", null, 75), null, "no book recorded is unknown, never a pass");
});

test("the exit side is the opposite of the entry side", () => {
  const leg = {
    role: "fut", side: "BUY", instrument_type: "FUT", strike: 0, entry_price: 100, entry_bid: 99, entry_ask: 100,
    entry_depth: { bids: [{ price: 99, qty: 75 }], asks: [{ price: 100, qty: 75 }] },
    exit_price: 101, exit_bid: 101, exit_ask: 101.5,
    exit_depth: { bids: [{ price: 101, qty: 75 }], asks: [{ price: 101.5, qty: 75 }] },
  };
  assert.equal(fillVerdict([leg], "entry", 75), true);
  assert.equal(fillVerdict([leg], "exit", 75), true, "a long leg is closed by SELLING into the bid");
});

test("mergeClosed never brings a deleted trade back and sorts newest first", () => {
  const a = { id: "a", closed_at: "2026-09-29T05:00:00Z" };
  const b = { id: "b", closed_at: "2026-09-29T06:00:00Z" };
  const out = mergeClosed([a], [b, { id: "x", closed_at: "2026-09-29T07:00:00Z" }], new Set(["x"]));
  assert.deepEqual(out.map((t) => t.id), ["b", "a"]);
});

test("groupByDay groups by the IST day of the close", () => {
  // 20:00 UTC is 01:30 IST the next day.
  const g = groupByDay([{ id: "a", closed_at: "2026-09-28T20:00:00Z", net_pnl: 5, gross_pnl: 6, total_charges: 1 }]);
  assert.equal(g[0].day, "2026-09-29");
  assert.equal(g[0].net, 5);
});

test("parseDraft pre-checks typed values against the published bounds", () => {
  const n = { kind: "number", min: 0, max: 100 };
  assert.deepEqual(parseDraft(n, "50"), { ok: true, value: 50 });
  assert.equal(parseDraft(n, "abc").ok, false);
  assert.equal(parseDraft(n, "101").ok, false);
  assert.equal(parseDraft({ kind: "int", min: 1, max: 5 }, "2.5").ok, false);
  assert.deepEqual(parseDraft({ kind: "list", list_item: "symbol" }, "nifty, sbin nifty"), { ok: true, value: ["NIFTY", "SBIN"] });
  assert.equal(parseDraft({ kind: "list", list_item: "date" }, "31/12/2026").ok, false);
  assert.equal(parseDraft({ kind: "enum", options: ["zerodha", "dhan"] }, "upstox").ok, false);
});

test("an unlinked position explains itself instead of looking asleep", () => {
  assert.match(heldText({ linked: false }, String), /not resolved/);
  assert.match(heldText({ linked: true, held_reason: "auto_exit_off" }, String), /OFF/);
});

test("the synthetic stream URL is relative and carries no token", () => {
  assert.equal(synthStreamUrl(), "/api/synth/stream");
});
