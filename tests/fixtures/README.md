# API contract fixtures — SAMPLE PAYLOADS, **NOT** the authority

> **These fixtures are NO LONGER the authoritative API contract.** The authority is now the
> backend-owned, versioned JSON-Schema in **`contract/schemas/**`**, vendored and pinned by
> `contract/BACKEND_CONTRACT.json`, digest-verified by `npm run contract:verify`, and validated
> against the backend's REAL serialized responses in the backend's own contract suite. The files
> here are retained **only as realistic sample payloads** — captured from a running backend — to
> exercise the vendored validator over real bytes (`tests/contractSchemas.test.mjs`) and to power
> the negative-control tests. Treat a fixture as an example, never as the source of truth: if a
> fixture and a schema disagree, the **schema wins**, and the fixture should be re-captured.

## Fixture ↔ schema divergences

There are **no** outstanding fixture ↔ schema divergences. `tests/contractSchemas.test.mjs`
validates every retained fixture CLEANLY against its authoritative schema with **no whitelist**.

Former divergences RESOLVED by backend contract **v1.1.0** and **v1.2.0**, which pin fields that
were always on the wire but previously undeclared or only optionally declared:

| Fixture | Field(s) — now pinned by the schema | Contract |
| --- | --- | --- |
| `export-status.json` | `enabled`, `connected` | v1.1.0 |
| `broker-status.json` | `brokers[].session.state` | v1.1.0 |
| `broker-status.json` | `brokers[].session.account_label`, `established_at`, `expires_at` — now **required** (nullable `["string","null"]`) instead of optional; the fixture already carries all three (as `null`), matching the real `projectBrokerSession`. | v1.2.0 |

Contract **v1.2.0** also added `contract/protocol.json` (the single source of truth for the CSRF
header name, the default session cookie name and the CSRF cookie suffix). It is not a response
fixture, so it does not appear above; it is covered by the digest and exercised by
`tests/csrfHeaderContract.test.mjs`.

---

## What these files are (historical context)

These JSON files were **captured from a running GTS Algo Research backend**, not hand-written.
`tests/apiContract.test.mjs` additionally asserts the specific fields the UI reads against them
as a complementary, human-readable check — but the schema, not the fixture, is the contract.

## Why they exist

The frontend and backend were built separately and their types for the new GTS Algo Research
endpoints drifted badly without anything catching it:

| Endpoint | Frontend expected | Backend actually sends | Overlap |
| --- | --- | --- | --- |
| `GET /api/runtime/status` | `token_waiting`, `instruments_loading`, `websocket_connecting`, `depth_ready`, `postgres_available`, `live_entry_blocked`, `recovery_active`, `residual_exposure`, `detail` | `brokers[]`, `active_broker`, `pg_ready`, `migration_state`, `recovery_ready`, `live_entry{blocked,reasons}`, `recovery_pending`, `residual_exposure` | 1 of 9 |
| `GET /api/export/status` | `enabled`, `delayed`, `lag_seconds`, `last_export_at`, `detail` | `enabled`, `connected`, `backlog_count`, `oldest_pending_age_ms`, `last_success_at`, `last_error`, `dead_letter_count` | 1 of 5 |
| `GET /api/broker/status` | a single broker plus `dhan_configured`, `dhan_instruments`, `feed`, `last_margin_source` | `{active_broker, generation, brokers[]}` | structurally different |

Every drifted field was either optional or read off a cast `fetch` result, so TypeScript
could not see any of it. The app typechecked, built and passed its tests while every
readiness banner stayed dark and the broker panel rendered `undefined`. `last_margin_source`
did not exist anywhere in the backend — it was invented.

A green build proved nothing about the contract. That is what these fixtures fix.

## The existing Box endpoints are pinned too

`box-status.json`, `box-execution-control.json` and `box-config.json` cover the endpoints
ported near-verbatim from the predecessor codebase. A mechanical diff confirmed those already matched — 81
required frontend fields across the three, none missing — so unlike the table above these
record a check that PASSED.

They are pinned anyway, for two reasons. "It was copied from a working system" is exactly
the reasoning that let the new endpoints drift undetected. And the persistence rewrite did
touch these code paths: the trades-history `source` tier really did change from
`memory|redis|mongo|none` to `memory|postgres|none`, which is asserted directly.

`box-execution-control.json` additionally pins the shipped safety default: the captured
response has `live_runtime_armed: false` and a non-`live` execution mode, so a fixture
re-captured from an armed process would fail the suite.

## Provenance

Captured on 2026-09-08 from `GTSAlgoResearch_B` at commit `3e14d54` against a local PostgreSQL,
with no broker token present (so the token states are `configuration_error` — which is
useful, because it exercises the fatal-blocker path the old shape could not express).

`csrf_token` values are **scrubbed** to `FIXTURE-PLACEHOLDER-NOT-A-REAL-TOKEN`. Nothing
here is or ever was a production secret, and the contract test additionally asserts that no
response carries a token, passcode or encryption metadata field.

## Re-capturing

Fixtures are a recording, so they go stale if the backend changes and nobody re-runs this.
That is the known limitation of the approach. To refresh, from a built `GTSAlgoResearch_B`:

```bash
# 1. a throwaway database
docker exec <pg> psql -U strikedge -d postgres -c "CREATE DATABASE ct;"

# 2. boot with a fake passcode and unreachable token providers
env NODE_ENV=development APP_TIMEZONE=Asia/Kolkata FRONTEND_URL=http://127.0.0.1:5173 \
    PORT=3212 SITE_ACCESS_SECRET=ct MONGO_EXPORT_ENABLED=false \
    DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/ct \
    BROKER_TOKEN_ENCRYPTION_KEY=<64 hex chars> \
    KITE_TOKEN_BROKER_URL=http://127.0.0.1:1/n DHAN_TOKEN_URL=http://127.0.0.1:1/n \
    KITE_TOKEN_BROKER_PASSCODE=x DHAN_TOKEN_BROKER_PASSCODE=x \
    node dist/index.js &

# 3. authenticate, then capture each endpoint
curl -s -c /tmp/ck -X POST -H 'Content-Type: application/json' \
     -H 'Origin: http://127.0.0.1:5173' -d '{"passcode":"ct"}' \
     http://127.0.0.1:3212/api/access/verify > access-verify.json
curl -s -b /tmp/ck http://127.0.0.1:3212/api/runtime/status  > runtime-status.json
curl -s -b /tmp/ck http://127.0.0.1:3212/api/export/status   > export-status.json
curl -s -b /tmp/ck http://127.0.0.1:3212/api/broker/status   > broker-status.json
curl -s -b /tmp/ck 'http://127.0.0.1:3212/api/broker/switch-blockers?broker=dhan' \
     > broker-switch-blockers.json
curl -s -b /tmp/ck http://127.0.0.1:3212/api/access/status   > access-status.json
```

Then re-scrub `csrf_token` in `access-verify.json` and `access-status.json` before
committing.
