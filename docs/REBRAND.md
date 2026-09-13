# The GTS Algo Research rebrand — decisions and audit

This records what the rebrand changed, what it deliberately did **not** change, and why. It
exists because the interesting part of a rename is the identifiers you must leave alone: a
mechanical find-and-replace across a production trading system is how a rebrand becomes an
outage.

It replaces the old `FRONTEND_EXTRACTION.md`, which described an app shell (one route, an
inline passcode screen, no public page) that no longer exists.

---

## What the app became

| Before | After |
| --- | --- |
| One route. The whole app sat behind a passcode screen. | `/` is a **public** page; `/box` is the **protected** workspace. |
| `AccessGate` rendered the passcode screen and the dashboard. | `AccessProvider` owns session state; `PasscodeModal` takes the passcode; `ProtectedRoute` guards `/box`. |
| A dashboard accidentally exposed as a website. | A public research page that can be shown to anyone, and a private workspace behind it. |
| Stylesheet derived from an older product's tokens, with several hundred dead selectors. | A design system written for this product; every selector is reachable from the components. |

The trading engine, the broker integrations and the execution path were **not** touched.

---

## Naming

| Context | Name |
| --- | --- |
| Brand | GTS Algo Research |
| Short logo text | GTS |
| Workspace | GTS Box |
| Frontend package | `gts-algo-research-frontend` |
| Backend package | `gts-algo-research-backend` |
| Theme storage key | `gts_theme` (was `strikedge_theme`) |
| Session cookie default | `gts_session` (was `strikedge_session`) |

### The theme key

Renamed. The only consequence is that an existing visitor's stored preference is not found
once, so they fall back to their OS `prefers-color-scheme` and re-pick if they want something
else. No session, no data and no trading state is carried in it.

The CI bundle scan's `localStorage` allow-list was updated in the same change — it fails the
build on any key outside it, which is what keeps a session token from ever being stored
client-side.

### The session cookie default

Renamed, and **only the default**. Any deployment that sets `SESSION_COOKIE_NAME` explicitly
(the documented production configuration does) is unaffected. A deployment relying on the
default logs its operators out **once**: the browser presents the old cookie name and the
server no longer looks for it. Session rows are untouched and simply expire.

Because the default is part of the versioned wire contract (`session_cookie_default` in
`contract/protocol.json`, covered by the contract digest), this change required, in order:
the backend default, the backend `protocol.json`, a recomputed `schemas_sha256` and a bumped
`contract_version`, then re-vendoring `contract/` here, re-pinning `BACKEND_CONTRACT.json` to
the backend commit, and regenerating `src/api/contract.generated.ts`. A contract test asserts
the backend's `src/config.ts` default and `protocol.json` still agree, so the two cannot drift.

---

## Identifiers deliberately NOT renamed

Each of these was audited individually. All are invisible to users; all would break something
if renamed.

### In this repository

| Identifier | Where | Why it stays |
| --- | --- | --- |
| `calspread:box:sound-enabled` | `src/lib/boxSounds.ts` | A client-side sound on/off preference that predates the rebrand. Renaming it silently resets a user preference for no user-visible benefit — the key never appears in the UI. Pinned by `tests/boxSoundPref.test.mjs` and by the CI bundle allow-list. |
| `contract/**`, `src/api/contract.generated.ts` | vendored | Backend-owned and digest-pinned. The frontend must not edit them; a change there is a coordinated backend change. The generated file is regenerated, never hand-edited. |
| `/api/box/*`, `/api/access/*`, `/api/broker/*` | API paths | A stable contract. There is no benefit to changing a working path for branding. |

`tests/branding.test.mjs` enforces this list: it scans every file under `src/` plus
`index.html` for legacy branding, and separately asserts each exemption **still contains only
what it is exempt for** — so an exemption cannot quietly start excusing a new leak.

### In the backend repository

Documented in full in the backend's `docs/CONFIGURATION.md` ("Identifiers the GTS Algo
Research rebrand deliberately did NOT rename"). The two that would have done the most damage:

- **`migrations/*.sql` — not touched at all, including comments.** Each applied migration's
  **sha256 is recorded** in `schema_migrations`, and editing an applied file is a hard boot
  error ("Migration … was modified after it was applied"). A one-word comment edit would have
  changed the hash and refused to start the process.
- **`CALSPREAD_DEPLOYMENT_ID` / `CALSPREAD_INSTANCE_ID`.** These are namespace components of
  the **durable owner id** written into the PostgreSQL reservation rows, and owner-verified
  release compares that id byte-for-byte. Renaming them would make a restarted process resolve
  a different namespace, stop recognising its own outstanding reservations, and potentially
  release or renew a lease it does not own. That is a multi-process safety mechanism, not a
  label.

Also unchanged: the live PostgreSQL role/database name, the MongoDB reporting-replica database
name, the durable `calspread:box:pnl:day:*` key prefix, a hash domain-separator label, the
synthetic order-id prefix on the charge-pricing path, and the **`calspread.online` token
routes** — which are a real external third-party service this system is a *client* of, so
renaming them would be both factually wrong and functionally broken.

---

## Behaviour changed on purpose (one item)

**Logout now revokes the server-side session.**

`POST /api/access/logout` is deliberately asymmetric on the backend: with a **live** session,
revoking it is a real state change and the route requires an allowed Origin plus a matching
`x-csrf-token` header; with no live session there is nothing to protect, so it clears the
cookies and returns 200 without one.

The frontend was sending logout as `csrfExempt` — no header, unconditionally. On the live path
the backend answered **403 `csrf_failed`**, the frontend caught and logged it, the UI "logged
out" locally, and **the session row stayed valid in the database until it expired.**

It is now `csrfBestEffort`: the header is sent whenever a token is held and omitted when none
is, so both halves of the route work. The old test asserted the header was *always* omitted —
it was pinning the defect — and was replaced by two tests covering both paths.

Nothing else about authentication behaviour changed. The passcode is still backend-controlled
and constant-time compared, still fails closed when `SITE_ACCESS_SECRET` is unset, still
returns an identical body for a wrong passcode and an unset secret, and the session is still an
HttpOnly, Secure, SameSite=Strict cookie whose digest alone is stored server-side.
