/**
 * THE POSTGRESQL OUTAGE BANNER MUST NOT PROMISE THAT EXITS STILL WORK.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The banner read:
 *
 *   "PostgreSQL is unavailable — … no new box can be recorded and live entry fails closed.
 *    Exits, protective cancellation and reconciliation are unaffected."
 *
 * The final sentence was false for all three operations. In GAR_B every order — an exit and an
 * emergency flatten included — performs two awaited durable writes BEFORE the broker POST
 * (`persistence.create`, then the CREATED→SUBMITTING compare-and-set), and the guard after the CAS
 * reads "broker POST blocked". The working-order cancel sweep must first READ the intent journal
 * (`loadNonterminal()`) to know what to cancel, and reconciliation opens with that read plus
 * `loadOwned()`. So during an outage automated reduction is REFUSED, not queued, and nothing is
 * transmitted.
 *
 * Telling an operator that exits are unaffected is the most dangerous sentence this banner could
 * carry, because it is precisely when they need to know the broker terminal is the only route left.
 *
 * These tests assert the WORDING, which is the deliverable: `buildRuntimeBanners` is exported so the
 * text can be asserted without a React renderer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntimeBanners } from "../src/lib/runtimeBanners.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */

const READY_BROKER = {
  broker: "zerodha",
  token_state: "ready",
  feed_connected: true,
  last_depth_age_ms: 120,
  ist_day: "2026-09-20",
  last_error: null,
};

const runtimeWith = (overrides = {}) => ({
  active_broker: "zerodha",
  brokers: [READY_BROKER],
  pg_ready: true,
  migration_state: { pending: 0, applied: 14 },
  recovery_ready: true,
  live_entry: { blocked: false, reasons: [] },
  ...overrides,
});

const bannerFor = (key, runtime, exportStatus = null) =>
  buildRuntimeBanners({ runtime, exportStatus }).find((b) => b.key === key);

/* ═══════════════════ the outage ═══════════════════ */

test("the PostgreSQL outage banner is raised as an ERROR", () => {
  const banner = bannerFor("pg", runtimeWith({ pg_ready: false }));
  assert.ok(banner, "an unavailable authoritative store must produce a banner");
  assert.equal(banner.kind, "error", "loss of the operational store is an error, not a note");
});

test("the outage banner NEVER claims exits, protective cancellation or reconciliation are unaffected", () => {
  // THE REGRESSION GUARD. This exact phrasing is what shipped, and it must not come back.
  const banner = bannerFor("pg", runtimeWith({ pg_ready: false }));
  assert.doesNotMatch(
    banner.text,
    /unaffected/i,
    "nothing about reduction is unaffected by losing the authoritative store",
  );
  assert.doesNotMatch(
    banner.text,
    /Exits, protective cancellation and reconciliation are unaffected/i,
    "the original false sentence must never be reinstated",
  );
});

test("the outage banner states that automated reduction is ALSO unavailable", () => {
  const banner = bannerFor("pg", runtimeWith({ pg_ready: false }));
  // Each of the four operations the operator might otherwise assume still works.
  assert.match(banner.text, /exit/i, "an exit is named");
  assert.match(banner.text, /flatten/i, "an emergency flatten is named");
  assert.match(banner.text, /cancel/i, "the cancel sweep is named");
  assert.match(banner.text, /reconciliation/i, "reconciliation is named");
});

test("the outage banner distinguishes REFUSED from QUEUED", () => {
  // The most consequential distinction: an operator who believes an exit is queued will wait for it.
  const banner = bannerFor("pg", runtimeWith({ pg_ready: false }));
  assert.match(banner.text, /refused rather than queued|refused, not queued/i);
  assert.match(banner.text, /nothing is transmitted/i);
});

test("the outage banner says the exposure is still owned, and names the manual route", () => {
  const banner = bannerFor("pg", runtimeWith({ pg_ready: false }));
  assert.match(banner.text, /unchanged and still owned/i, "the position did not disappear");
  assert.match(banner.text, /broker terminal/i, "and the only remaining route is named");
});

test("the outage banner still says live entry fails closed", () => {
  // The one true half of the original sentence must survive the correction.
  const banner = bannerFor("pg", runtimeWith({ pg_ready: false }));
  assert.match(banner.text, /entry fails closed/i);
  assert.match(banner.text, /no new box can be recorded/i);
});

/* ═══════════════════ recovery ═══════════════════ */

test("when PostgreSQL RECOVERS the banner disappears entirely", () => {
  const down = buildRuntimeBanners({ runtime: runtimeWith({ pg_ready: false }), exportStatus: null });
  assert.ok(down.some((b) => b.key === "pg"), "precondition: the outage banner is present");

  const up = buildRuntimeBanners({ runtime: runtimeWith({ pg_ready: true }), exportStatus: null });
  assert.equal(up.some((b) => b.key === "pg"), false, "a recovered store raises no banner");
});

test("a healthy runtime produces NO banners at all", () => {
  // Non-vacuity: the assertions above are caused by the outage, not by a fixture that always warns.
  const banners = buildRuntimeBanners({ runtime: runtimeWith(), exportStatus: null });
  assert.deepEqual(banners, [], `expected a silent dashboard, got ${JSON.stringify(banners)}`);
});

/* ═══════════════════ the MongoDB contrast must stay calm ═══════════════════ */

test("a MongoDB reporting outage is still reported calmly — it is NOT operational", () => {
  // The distinction the original banner set got right and which must be preserved: PostgreSQL is
  // authoritative and operational; MongoDB is an async reporting replica whose loss blocks nothing.
  const banners = buildRuntimeBanners({
    runtime: runtimeWith(),
    exportStatus: { enabled: true, connected: false, backlog_count: 0, dead_letter_count: 0, oldest_pending_age_ms: null },
  });
  const mongo = banners.find((b) => b.key === "mongo-down");
  assert.ok(mongo, "a disconnected reporting replica is still reported");
  assert.equal(mongo.kind, "info", "but calmly — it is not an operational failure");
  assert.match(mongo.text, /nothing operational is blocked/i);
  assert.match(mongo.text, /durable in PostgreSQL/i);
});

test("a MongoDB backlog does not raise the PostgreSQL outage banner", () => {
  const banners = buildRuntimeBanners({
    runtime: runtimeWith(),
    exportStatus: { enabled: true, connected: true, backlog_count: 42, dead_letter_count: 0, oldest_pending_age_ms: 5_000 },
  });
  assert.equal(banners.some((b) => b.key === "pg"), false, "the two stores are not confused");
  assert.ok(banners.some((b) => b.key === "mongo"));
});

/* ═══════════════════ both stores down ═══════════════════ */

test("with BOTH stores down, the PostgreSQL banner is the error and Mongo stays informational", () => {
  const banners = buildRuntimeBanners({
    runtime: runtimeWith({ pg_ready: false }),
    exportStatus: { enabled: true, connected: false, backlog_count: 0, dead_letter_count: 0, oldest_pending_age_ms: null },
  });
  const pg = banners.find((b) => b.key === "pg");
  const mongo = banners.find((b) => b.key === "mongo-down");
  assert.equal(pg.kind, "error");
  assert.equal(mongo.kind, "info", "reporting lag must not compete with the operational outage");
  // And the Mongo banner's "durable in PostgreSQL" reassurance must not be read as an all-clear
  // while PostgreSQL itself is down — the error banner above it is what governs.
  assert.ok(banners.indexOf(pg) < banners.indexOf(mongo), "the operational error is shown first");
});
