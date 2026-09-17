/**
 * PRE-RUN UNIVERSE SELECTION TESTS.
 *
 * These run against the SAME pure functions the picker calls (no DOM needed), and they exist for one
 * asymmetry: of the two ways the staging arithmetic can be wrong, only one is visible.
 *
 * Failing to exclude a name leaves it tradable, which the operator sees on the next screen. An
 * accidental RE-INCLUSION re-opens entry on a name they deliberately declined, and nothing on screen
 * changes when that happens — the row simply goes back to looking ordinary. The bulk write is
 * diff-based specifically so a stale view cannot cause that, which only holds if the diff itself never
 * emits a spurious `include`. That is what most of these assert.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  capBlocked,
  filterUniverse,
  isStagedExcluded,
  stagedDiff,
  stageMany,
  toggleStaged,
} from "../src/lib/universeSelection.ts";

/** One universe row, defaulted to the ordinary case: tradable and not excluded. */
function row(symbol, over = {}) {
  return {
    symbol,
    name: over.name ?? symbol,
    is_index: over.is_index ?? false,
    lot_size: over.lot_size ?? 100,
    expiry: over.expiry ?? "2026-09-24",
    paired_strikes: over.paired_strikes ?? 8,
    excluded: over.excluded ?? false,
    excluded_reason: over.excluded_reason ?? null,
    admissible: over.admissible ?? true,
    inadmissible_reason: over.inadmissible_reason ?? null,
    inadmissible_detail: over.inadmissible_detail ?? null,
    // Default to OBSERVED, so the staging cases stay about staging. The watch semantics get their own
    // cases below, where it is set explicitly.
    watched: over.watched ?? true,
    not_watched_reason: over.not_watched_reason ?? null,
  };
}

const NIFTY = row("NIFTY", { is_index: true, lot_size: 75 });
const RELIANCE = row("RELIANCE", { lot_size: 250 });
const ITC = row("ITC", { excluded: true, excluded_reason: "corporate action" });
const TATASTEEL = row("TATASTEEL", {
  lot_size: 5500,
  admissible: false,
  inadmissible_reason: "lot_exceeds_per_leg_cap",
  inadmissible_detail: "One lot is 5500 unit(s), above BOX_LIVE_MAX_OPEN_LEG_QUANTITY=2000.",
});
const ROWS = [NIFTY, ITC, RELIANCE, TATASTEEL];

/* ───────────────────────────── the diff ───────────────────────────── */

test("an empty staging map produces no changes at all", () => {
  assert.deepEqual(stagedDiff(ROWS, new Map()), { toExclude: [], toInclude: [] });
});

test("only symbols whose desired state DIFFERS from the server are emitted", () => {
  const staged = new Map([
    ["RELIANCE", true], // not excluded on the server ⇒ a real exclusion
    ["ITC", true], // already excluded on the server ⇒ nothing to do
    ["NIFTY", false], // already tradable on the server ⇒ nothing to do
  ]);
  assert.deepEqual(stagedDiff(ROWS, staged), { toExclude: ["RELIANCE"], toInclude: [] });
});

test("a re-inclusion is emitted only for a name the server reports as excluded", () => {
  assert.deepEqual(stagedDiff(ROWS, new Map([["ITC", false]])), {
    toExclude: [],
    toInclude: ["ITC"],
  });
});

test("TOGGLING TWICE EMITS NOTHING — a restored row must not look like a deliberate re-admission", () => {
  // The invariant the whole diff-based design rests on. If a double toggle left `{include:[ITC]}`
  // behind, an operator who ticked and unticked out of curiosity would silently re-open entry on a
  // name they had declined — and the request would be indistinguishable from meaning to.
  let staged = toggleStaged(new Map(), ITC);
  assert.equal(staged.get("ITC"), false, "first toggle wants ITC tradable again");
  staged = toggleStaged(staged, ITC);
  assert.equal(staged.has("ITC"), false, "the second toggle must CLEAR the entry, not record false");
  assert.deepEqual(stagedDiff(ROWS, staged), { toExclude: [], toInclude: [] });

  // Same in the other direction, starting from a name that is NOT excluded.
  let s2 = toggleStaged(new Map(), RELIANCE);
  assert.equal(s2.get("RELIANCE"), true);
  s2 = toggleStaged(s2, RELIANCE);
  assert.equal(s2.has("RELIANCE"), false);
  assert.deepEqual(stagedDiff(ROWS, s2), { toExclude: [], toInclude: [] });
});

test("a staged symbol that is no longer in the universe cannot leak into the request", () => {
  // After a refresh the board may not carry a name any more (an expiry rolled, say). The diff is
  // driven by ROWS, so a stale staged entry is dropped rather than sent for a symbol nothing is
  // being shown about.
  const staged = new Map([["DELISTED", true]]);
  assert.deepEqual(stagedDiff(ROWS, staged), { toExclude: [], toInclude: [] });
});

test("the desired state of a row falls back to the server when nothing is staged", () => {
  assert.equal(isStagedExcluded(ITC, new Map()), true, "ITC is excluded server-side");
  assert.equal(isStagedExcluded(RELIANCE, new Map()), false);
  assert.equal(isStagedExcluded(RELIANCE, new Map([["RELIANCE", true]])), true);
});

/* ──────────────────────────── bulk staging ──────────────────────────── */

test("staging many records only the rows that would actually change", () => {
  const staged = stageMany(new Map(), ROWS, true);
  assert.equal(staged.has("ITC"), false, "ITC is already excluded, so it is not staged");
  assert.deepEqual(stagedDiff(ROWS, staged).toExclude.sort(), ["NIFTY", "RELIANCE", "TATASTEEL"]);
  assert.deepEqual(stagedDiff(ROWS, staged).toInclude, [], "excluding must never emit an inclusion");
});

test("staging many to ALLOW emits inclusions only for names actually excluded", () => {
  const staged = stageMany(new Map(), ROWS, false);
  assert.deepEqual(stagedDiff(ROWS, staged), { toExclude: [], toInclude: ["ITC"] });
});

test("bulk staging over a subset leaves rows outside the subset untouched", () => {
  const staged = stageMany(new Map(), [RELIANCE], true);
  assert.deepEqual(stagedDiff(ROWS, staged), { toExclude: ["RELIANCE"], toInclude: [] });
});

test("staging is idempotent — applying the same bulk twice changes nothing", () => {
  const once = stageMany(new Map(), ROWS, true);
  const twice = stageMany(once, ROWS, true);
  assert.deepEqual([...twice.entries()].sort(), [...once.entries()].sort());
});

test("a bulk ALLOW reverses a bulk EXCLUDE back to no changes", () => {
  const excluded = stageMany(new Map(), ROWS, true);
  const restored = stageMany(excluded, ROWS, false);
  // Everything is back to the server's state except ITC, which the server already had excluded and
  // this now genuinely re-admits — so exactly one inclusion, not four.
  assert.deepEqual(stagedDiff(ROWS, restored), { toExclude: [], toInclude: ["ITC"] });
});

/* ────────────────────────── filtering + counts ────────────────────────── */

test("the filters partition the universe the way the counts claim", () => {
  assert.deepEqual(filterUniverse(ROWS, "", "all").map((r) => r.symbol), [
    "NIFTY",
    "ITC",
    "RELIANCE",
    "TATASTEEL",
  ]);
  assert.deepEqual(filterUniverse(ROWS, "", "watchable").map((r) => r.symbol), ["NIFTY", "RELIANCE"]);
  assert.deepEqual(filterUniverse(ROWS, "", "excluded").map((r) => r.symbol), ["ITC"]);
  assert.deepEqual(filterUniverse(ROWS, "", "blocked").map((r) => r.symbol), ["TATASTEEL"]);
});

test("an EXCLUDED and cap-blocked name is not counted as cap-blocked", () => {
  // The operator already declined it, so it is not a configuration problem they need told about —
  // and surfacing it in that count would bury the names that look enabled and are not.
  const both = row("BOTH", { excluded: true, admissible: false, inadmissible_reason: "no_paired_strikes" });
  assert.deepEqual(capBlocked([...ROWS, both]).map((r) => r.symbol), ["TATASTEEL"]);
  assert.deepEqual(filterUniverse([both], "", "blocked"), []);
});

test("search matches symbol OR display name, case- and whitespace-insensitively", () => {
  const rows = [row("MM", { name: "Mahindra & Mahindra" }), RELIANCE];
  assert.deepEqual(filterUniverse(rows, "mahindra", "all").map((r) => r.symbol), ["MM"]);
  assert.deepEqual(filterUniverse(rows, "  reli ", "all").map((r) => r.symbol), ["RELIANCE"]);
  assert.deepEqual(filterUniverse(rows, "NOSUCHNAME", "all"), []);
});

test("search and filter compose rather than overriding each other", () => {
  // TATASTEEL matches the query but is cap-blocked, so the watchable filter must still exclude it.
  assert.deepEqual(filterUniverse(ROWS, "TATA", "watchable"), []);
  assert.deepEqual(filterUniverse(ROWS, "TATA", "blocked").map((r) => r.symbol), ["TATASTEEL"]);
});


/* ─────────────────── watched is not watchable ─────────────────── */

/*
 * These exist because the first version of this surface offered only an "eligible" slice, and an
 * operator reading it concluded the engine was watching 215 underlyings when it was watching one.
 * Eligibility is what nothing forbids; being watched is what the engine actually holds a window for.
 * The two filters must stay distinct, and the `watched` slice must come from the engine's own record.
 */

test("the WATCHED filter reports what the engine holds a window for, not what is eligible", () => {
  const rows = [
    row("BANKNIFTY", { is_index: true, watched: true }),
    row("NIFTY", { is_index: true, watched: false, not_watched_reason: "underlying_cap" }),
    row("RELIANCE", { watched: false, not_watched_reason: "underlying_cap" }),
  ];
  // All three are eligible — nothing forbids any of them.
  assert.deepEqual(filterUniverse(rows, "", "watchable").map((r) => r.symbol), [
    "BANKNIFTY",
    "NIFTY",
    "RELIANCE",
  ]);
  // Exactly one is being looked at. This is the answer to "so which one IS it monitoring?".
  assert.deepEqual(filterUniverse(rows, "", "watched").map((r) => r.symbol), ["BANKNIFTY"]);
});

test("an EXCLUDED name that still holds a window appears under WATCHED", () => {
  // Excluding a name never strands exposure: its legs keep streaming so the monitor can exit it. The
  // watched slice has to reflect what the feed is really carrying, not what the blocklist prefers.
  const rows = [row("HASPOSITION", { excluded: true, watched: true })];
  assert.deepEqual(filterUniverse(rows, "", "watched").map((r) => r.symbol), ["HASPOSITION"]);
  assert.deepEqual(filterUniverse(rows, "", "watchable"), [], "excluded is never eligible");
});

test("a cap-blocked name that is somehow still watched is reported honestly by both filters", () => {
  // Its legs can stream while its lot makes entry impossible — two independent facts, and neither
  // filter may quietly override the other.
  const rows = [
    row("BIGLOT", { admissible: false, inadmissible_reason: "lot_exceeds_per_leg_cap", watched: true }),
  ];
  assert.deepEqual(filterUniverse(rows, "", "watched").map((r) => r.symbol), ["BIGLOT"]);
  assert.deepEqual(filterUniverse(rows, "", "blocked").map((r) => r.symbol), ["BIGLOT"]);
  assert.deepEqual(filterUniverse(rows, "", "watchable"), []);
});

test("search composes with the WATCHED filter", () => {
  const rows = [
    row("BANKNIFTY", { watched: true }),
    row("NIFTY", { watched: false, not_watched_reason: "token_budget" }),
  ];
  assert.deepEqual(filterUniverse(rows, "nifty", "watched").map((r) => r.symbol), ["BANKNIFTY"]);
  assert.deepEqual(filterUniverse(rows, "banknifty", "watched").map((r) => r.symbol), ["BANKNIFTY"]);
});

test("staging is unaffected by whether a name is being watched", () => {
  // Excluding a name you are not currently watching is legitimate — it stops it being entered if a
  // cap later lets it back in. So `watched` must not leak into the diff.
  const unwatched = row("LATER", { watched: false, not_watched_reason: "underlying_cap" });
  const staged = stageMany(new Map(), [unwatched], true);
  assert.deepEqual(stagedDiff([unwatched], staged), { toExclude: ["LATER"], toInclude: [] });
});
