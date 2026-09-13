/**
 * API CONTRACT TEST — the frontend's types must match what the backend actually sends.
 *
 * WHY THIS EXISTS
 * The frontend and backend were built separately, and the types for the new GTS Algo Research
 * endpoints drifted badly without anything noticing:
 *
 *   GET /api/runtime/status  — the frontend declared `token_waiting`, `instruments_loading`,
 *     `websocket_connecting`, `depth_ready`, `postgres_available`, `live_entry_blocked`,
 *     `recovery_active`, `detail`. The backend sends `brokers[]`, `active_broker`,
 *     `pg_ready`, `migration_state`, `recovery_ready`, `live_entry{blocked,reasons}`,
 *     `recovery_pending`, `residual_exposure`. Exactly ONE name overlapped.
 *
 *   GET /api/export/status  — frontend declared `delayed`, `lag_seconds`, `last_export_at`,
 *     `detail`; backend sends `connected`, `backlog_count`, `oldest_pending_age_ms`,
 *     `last_success_at`, `last_error`, `dead_letter_count`. One name overlapped.
 *
 *   GET /api/broker/status  — frontend declared a SINGLE broker with `dhan_configured`,
 *     `dhan_instruments`, `feed`, `last_margin_source`; the backend returns
 *     `{active_broker, generation, brokers[]}` and has no margin-source field at all.
 *
 * Every drifted field was optional or was read off a cast `fetch` result, so TypeScript
 * could not see it: the app typechecked, built, and passed its tests while every readiness
 * banner stayed dark and the broker panel rendered `undefined`. A green build proved
 * nothing about the contract.
 *
 * HOW THIS TEST WORKS
 * The AUTHORITY for response shapes is now the backend-owned, vendored JSON-Schema contract in
 * `contract/schemas/**` (pinned by `contract/BACKEND_CONTRACT.json`, digest-verified by
 * `npm run contract:verify`, and validated against these fixtures in
 * `tests/contractSchemas.test.mjs`). The JSON in `tests/fixtures/` is NO LONGER the contract —
 * it is a set of realistic sample payloads CAPTURED FROM A RUNNING GTS ALGO RESEARCH BACKEND (see
 * tests/fixtures/README.md).
 *
 * The assertions BELOW are retained as a COMPLEMENTARY, human-readable check of the specific
 * fields the UI reads (the banners, the broker panel, the safety defaults) — they document
 * intent at the call site in a way a schema does not. They do not replace the schema authority;
 * they sit alongside it. The static type↔contract gate lives in `src/api/contract.assert.ts`
 * (checked by `tsc -b`), and the digest/pin gate in `contract/verify.mjs`.
 *
 * WHAT IT CANNOT DO: a fixture is a recording, so it goes stale if the backend changes and
 * nobody re-captures. That is precisely why the SCHEMAS (not these fixtures) are the authority
 * now — a schema is validated against the backend's REAL serialized responses in the backend's
 * own contract suite, so it cannot quietly lie about the API.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Every captured fixture. The secret scan walks all of them. */
const ALL_FIXTURES = [
  "runtime-status",
  "export-status",
  "broker-status",
  "broker-switch-blockers",
  "access-verify",
  "access-status",
  "box-status",
  "box-execution-control",
  "box-config",
];

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

/** Assert every key the UI reads is present, and report ALL missing at once. */
function requireKeys(obj, keys, label) {
  const missing = keys.filter((k) => !(k in obj));
  assert.deepEqual(missing, [], `${label}: backend response is missing ${missing.join(", ")}`);
}

test("GET /api/runtime/status carries every field the banners read", () => {
  const d = fixture("runtime-status");
  requireKeys(
    d,
    [
      "brokers",
      "active_broker",
      "pg_ready",
      "migration_state",
      "recovery_ready",
      "live_entry",
      "recovery_pending",
      "residual_exposure",
    ],
    "runtime status",
  );

  assert.ok(Array.isArray(d.brokers), "brokers must be an array so both can be rendered");
  assert.equal(d.brokers.length, 2, "both Zerodha and Dhan must always be reported");

  requireKeys(d.migration_state, ["applied", "pending"], "migration_state");
  requireKeys(d.live_entry, ["blocked", "reasons"], "live_entry");
  assert.ok(
    Array.isArray(d.live_entry.reasons),
    "live_entry.reasons must be an array — 'blocked' without a cause is not actionable",
  );

  for (const b of d.brokers) {
    requireKeys(
      b,
      [
        "broker",
        "token_state",
        "ist_day",
        "last_attempt_at",
        "last_success_at",
        "last_error",
        "feed_connected",
        "wanted_token_count",
        "subscribed_token_count",
        "last_depth_age_ms",
        "reconnect_count",
      ],
      `runtime status broker ${b.broker}`,
    );
    assert.ok(
      ["waiting", "polling", "ready", "invalid", "configuration_error"].includes(b.token_state),
      `unexpected token_state "${b.token_state}" — the banners switch on this exact set`,
    );
  }
});

test("GET /api/export/status carries every field the reporting banners read", () => {
  const d = fixture("export-status");
  requireKeys(
    d,
    [
      "enabled",
      "connected",
      "backlog_count",
      "oldest_pending_age_ms",
      "last_success_at",
      "last_error",
      "dead_letter_count",
    ],
    "export status",
  );
  assert.equal(typeof d.backlog_count, "number");
  assert.equal(typeof d.dead_letter_count, "number", "dead-lettered rows must be reportable");
});

test("GET /api/broker/status returns BOTH brokers, which is what makes standby renderable", () => {
  const d = fixture("broker-status");
  requireKeys(d, ["active_broker", "generation", "brokers"], "broker status");
  assert.ok(Array.isArray(d.brokers));
  assert.equal(d.brokers.length, 2, "both brokers must be present so standby can be shown");
  assert.equal(typeof d.generation, "number", "the durable broker generation must be surfaced");

  for (const entry of d.brokers) {
    requireKeys(entry, ["broker", "session", "health"], `broker entry ${entry.broker}`);
    requireKeys(
      entry.session,
      ["broker", "connected", "state", "account_label", "established_at", "expires_at"],
      `session ${entry.broker}`,
    );
    requireKeys(
      entry.health,
      ["broker", "authenticated", "data_ready", "trading_ready", "problems"],
      `health ${entry.broker}`,
    );
    assert.ok(
      ["waiting", "ready", "standby", "expired"].includes(entry.session.state),
      `unexpected session.state "${entry.session.state}" — the panel switches on this set`,
    );
    assert.ok(Array.isArray(entry.health.problems));
  }
});

test("GET /api/broker/switch-blockers returns machine-readable string reasons", () => {
  const d = fixture("broker-switch-blockers");
  requireKeys(d, ["broker", "blockers"], "switch blockers");
  assert.ok(Array.isArray(d.blockers));
  for (const b of d.blockers) {
    assert.equal(typeof b, "string", "blockers are strings, not {reason, detail} objects");
  }
});

test("the access endpoints return what the gate needs and nothing sensitive", () => {
  for (const name of ["access-verify", "access-status"]) {
    const d = fixture(name);
    requireKeys(d, ["authenticated", "role", "csrf_token", "expires_at"], name);
    assert.equal(d.role, "full", "the site passcode grants the full operator role");
  }
});

test("NO endpoint response carries a broker token, passcode or encryption metadata", () => {
  // The load-bearing security assertion: these payloads are rendered in a browser.
  //
  // Deliberately matches KEY names (`"access_token"`) rather than bare substrings. A
  // response legitimately CONTAINS the string "DHAN_API_SECRET" inside the operator-facing
  // problem text "Dhan is not configured: DHAN_CLIENT_ID, DHAN_API_KEY, DHAN_API_SECRET
  // missing." — that is a variable NAME telling the operator what to set, carries no value,
  // and is exactly the diagnostic they need. Banning the substring would delete a useful
  // message; banning the key is what actually prevents a leak.
  const forbidden = [
    "access_token",
    "encrypted_access_token",
    "encryption_iv",
    "encryption_auth_tag",
    "passcode",
    "api_secret",
    "site_access_secret",
    "database_url",
    "mongodb_uri",
  ];
  for (const name of ALL_FIXTURES) {
    const raw = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
    for (const key of forbidden) {
      assert.ok(
        !new RegExp(`"${key}"\\s*:`, "i").test(raw),
        `${name}.json must not contain a "${key}" field`,
      );
    }
  }
});

/* ========================================================================== */
/*  The EXISTING Box surface, ported from the predecessor codebase                           */
/* ========================================================================== */

/**
 * These endpoints were ported near-verbatim from the predecessor codebase, and the frontend types were
 * lifted from the same source, so they were EXPECTED to match — and a mechanical diff
 * confirmed they do: 81 required fields across the three, none missing.
 *
 * They are pinned anyway. "It was copied from a working system" is exactly the reasoning
 * that let the NEW endpoints drift undetected, and the persistence rewrite touched the
 * code paths that build these payloads (the trades-history `source` tier label did in fact
 * change from memory|redis|mongo|none to memory|postgres|none). An assumption that held is
 * still an assumption until something checks it.
 */

test("GET /api/box/status carries every field the dashboard requires", () => {
  const d = fixture("box-status");
  requireKeys(
    d,
    [
      // Scanner / lifecycle
      "running",
      "state",
      "market_open",
      "started_at",
      "stopped_at",
      "strike_level",
      // Health — each of these gates something the operator acts on
      "authenticated",
      "database_healthy",
      "feed_healthy",
      "market_data_healthy",
      "broker_auth_healthy",
      "degraded",
      "circuit_state",
      // Exposure and recovery
      "open_positions",
      "partially_exited_positions",
      "reconciliation_complete",
      "recovery_active",
      "residual_exposure_count",
      "unknown_orders",
      "brokers_with_open_positions",
      // Execution identity
      "broker",
      "execution_mode",
      // Universe / feed
      "underlyings",
      "candidates",
      "executable_books",
      "feed_age_ms",
      "quotes",
    ],
    "box status",
  );
  assert.equal(typeof d.running, "boolean");
  assert.ok(Array.isArray(d.brokers_with_open_positions));
});

test("GET /api/box/execution-control carries the gate and arming state", () => {
  const d = fixture("box-execution-control");
  requireKeys(
    d,
    [
      "mode",
      "execution_mode",
      "paper_execution_profile",
      "entry_enabled",
      // The two independent live gates plus the runtime arm — the safety surface.
      "deployment_live_capable",
      "live_runtime_armed",
      "emergency_flatten_enabled",
      "block_reason",
      "block_detail",
      "broker",
      "risk",
      "session",
    ],
    "execution control",
  );

  // THE SAFETY DEFAULT. A captured response must never show a live-armed process: these
  // fixtures come from a paper, disarmed backend and that is the shipped default.
  assert.equal(d.live_runtime_armed, false, "runtime live arming must default to false");
  assert.notEqual(d.execution_mode, "live", "the default execution mode must not be live");
});

test("GET /api/box/config carries the entry-gate economics the UI displays", () => {
  const d = fixture("box-config");
  requireKeys(
    d,
    [
      "min_gross_edge",
      "min_net_edge",
      "safety_buffer",
      "quote_max_age_ms",
      "feed_max_age_ms",
      "underlying_max_age_ms",
      "convergence_floor",
      "convergence_pct",
      "min_exit_net_pnl",
      "profit_capture_pct",
      "expiry_safety_minutes",
      "strike_level",
      "strikes_each_side",
      "max_strikes",
      "execution_mode",
      "require_priced_charges",
      "directions",
      "tunable",
    ],
    "box config",
  );
});

test("the trades-history source tier no longer advertises Redis or Mongo", () => {
  /**
   * A REAL contract change from the extraction, recorded in
   * docs/EXTRACTION_MANIFEST.md §7: the tier label went from
   * "memory" | "redis" | "mongo" | "none" to "memory" | "postgres" | "none",
   * because Upstash Redis was removed and MongoDB is no longer authoritative.
   *
   * The frontend union must not still claim the dead tiers, or a reader of the type
   * would believe this backend can answer from Redis.
   */
  const types = readFileSync(new URL("../src/api/types.ts", import.meta.url), "utf8");
  const m = /export type BoxHistorySource\s*=\s*([^;]+);/.exec(types);
  assert.ok(m, "BoxHistorySource must still be declared");
  const union = m[1];
  assert.match(union, /"postgres"/, "postgres is the durable tier now");
  assert.doesNotMatch(union, /"redis"/, "Upstash Redis was removed from the backend entirely");
  assert.doesNotMatch(
    union,
    /"mongo"/,
    "MongoDB is an async reporting replica and never answers an operational history read",
  );
});
