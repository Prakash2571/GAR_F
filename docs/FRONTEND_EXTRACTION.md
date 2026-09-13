# GTS Box frontend — extraction record

> **A HISTORICAL RECORD, NOT A DESCRIPTION OF THE PRODUCT.**
> The product is now **GTS Box**, a box-arbitrage research desk. This document deliberately
> keeps the name it was written under — **StrikeEdge** — everywhere it refers to a decision that
> was actually made at that time, because rewriting the name into the history would make the
> record claim things that did not happen under it. Read every "StrikeEdge" below as "this
> repository, at extraction time". The rename to GTS Box, the new brand mark and the current
> design-token palette all came later and are not part of what is recorded here.
>
> Nothing in this file is a statement about how GTS Box should look or be described today. For
> that, see the root `README.md` and the design-system header in `src/styles.css`.

This documents exactly how this frontend was originally extracted from CalSpread.

- **Source (READ ONLY):** `/home/ubuntu/Cal/Cal_Spread`
  (React 18 + TypeScript + Vite, SHA `3ac5abe07a9e580a0ecc0c8c173aff7dff346184`).
- **Target:** this repository, a clean standalone StrikeEdge frontend.

The goal was to carry over **only the Box UI and its direct dependencies**, replace the
2,623-line `api.ts` monolith with focused modules, put the whole app behind a **site passcode**
gate backed by an **HttpOnly cookie**, and make the broker surface **dual-broker** (Zerodha +
Dhan, exactly one active).

---

## 1. Files copied from CalSpread (ported verbatim or near-verbatim)

These were copied with no behaviour change (imports resolve through the new `src/api.ts`
barrel; the sound-preference storage key is preserved so the ported tests still pass):

| File                          | Notes                                                            |
| ----------------------------- | ---------------------------------------------------------------- |
| `src/BoxDirection.tsx`        | verbatim                                                         |
| `src/BoxExecutionAttempts.tsx`| verbatim                                                         |
| `src/BoxDayPnl.tsx`           | verbatim                                                         |
| `src/BoxExecutionHealth.tsx`  | verbatim                                                         |
| `src/BoxGates.tsx`            | verbatim                                                         |
| `src/BoxRiskControl.tsx`      | verbatim                                                         |
| `src/BoxSessionControl.tsx`   | verbatim                                                         |
| `src/BoxExecutionControl.tsx` | verbatim                                                         |
| `src/BoxDeleteModal.tsx`      | verbatim                                                         |
| `src/BoxBroker.tsx`           | verbatim (badge, history filter, per-trade broker vocabulary)    |
| `src/BoxHelp.tsx`             | verbatim                                                         |
| `src/BoxSoundToggle.tsx`      | verbatim                                                         |
| `src/useBoxSounds.ts`         | verbatim                                                         |
| `src/lib/boxSounds.ts`        | verbatim (storage key `calspread:box:sound-enabled` kept — test-locked) |
| `src/lib/boxSoundTracker.ts`  | verbatim                                                         |
| `src/ExecutionBreakdown.tsx`  | verbatim (used by Box for the expected-net arithmetic)           |
| `src/BrandMark.tsx`           | verbatim (used by the header and the gate)                       |
| `src/ScrollToTop.tsx`         | verbatim (used by `main.tsx`)                                    |
| `src/format.ts`               | verbatim                                                         |
| `src/apiErrors.ts`            | verbatim (transport error classes)                               |
| `src/ThemeToggle.tsx`         | copied; theme storage key rebranded `cal_spread_theme` → `strikedge_theme` |

### Ported tests

| File                            | Notes                                             |
| ------------------------------- | ------------------------------------------------- |
| `tests/boxSoundPref.test.mjs`   | verbatim — the Box sound-preference parse tests   |
| `tests/boxSoundTracker.test.mjs`| verbatim — the Box sound hydration/dedupe tests   |

### Scaffolding mirrored from the source conventions

`package.json`, `tsconfig.json` (same strict flags incl. `noUnusedLocals` /
`noUnusedParameters`), `vite.config.ts`, `index.html`, `public/favicon.svg`, `.gitignore`,
`src/vite-env.d.ts`, `src/main.tsx`, `.github/workflows/ci.yml`. Dependency versions are
identical. Branding/title changed to **StrikeEdge**.

---

## 2. Files adapted (ported, then changed)

| File          | What changed                                                                   |
| ------------- | ------------------------------------------------------------------------------ |
| `src/Box.tsx` | Ported. See “Behaviour changes” below: props reduced to `{ onLock }`, SSE rewired to the reconnecting stream, Board/back navigation removed, StrikeEdge branding + Lock button, broker panel and runtime-readiness banners added, persistence banner reworded from “MONGODB_URI” to PostgreSQL, a few Zerodha/Kite-specific strings made broker-neutral. |

---

## 3. Files newly written for StrikeEdge

| File                            | Purpose                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `src/api/http.ts`               | The one fetch wrapper: `credentials: "include"`, JSON errors, an **in-memory CSRF token** (`setCsrfToken`/`getCsrfToken`/`clearCsrfToken`) echoed as `x-csrf-token` on every mutating request, and a single 401 handler that notifies subscribers and clears the token. The CSRF token is delivered in the body of `/api/access/verify` and an authenticated `/api/access/status`, never read from a cookie and never persisted. Replaces the token-in-localStorage transport of the source. |
| `src/api/access.ts`             | `verifyPasscode()`, `accessStatus()`, `logout()`.                             |
| `src/api/box.ts`                | Every `/api/box/*` call the Box UI makes, plus `GET /api/runtime/status`, `GET /api/export/status`, `GET /api/broker/status`, `GET /api/broker/switch-blockers`, `POST /api/broker/select`. |
| `src/api/types.ts`              | The Box + broker response types, lifted from the source `api.ts`. IDs documented as OPAQUE STRINGS. Adds `RuntimeStatus` / `ExportStatus`. |
| `src/api.ts`                    | A thin barrel re-exporting the focused modules, so ported components keep their `./api` imports. |
| `src/auth/AccessGate.tsx`       | The passcode gate component (checking / locked / unlocked).                   |
| `src/lib/boxStream.ts`          | The reconnecting EventSource: capped backoff, `withCredentials: true`, no reconnect after 401. |
| `src/BrokerStatusPanel.tsx`     | The focused dual-broker status panel (replaces the excluded `BrokerPanel.tsx`). |
| `src/RuntimeStatusBanners.tsx`  | Plain-language whole-system readiness banners (token/instruments/feed/depth/PostgreSQL/Mongo/entry/recovery). |
| `src/App.tsx`                   | Root: `AccessGate` wrapping `Box`. One route only.                            |
| `tests/boxStream.test.mjs`      | SSE reconnect tests (reconnect after transient drop, NOT after 401, capped backoff). |
| `tests/apiUnauthorized.test.mjs`| API 401 / session-expiry tests (401 notifies once, rejects, credentials/CSRF, non-JSON errors). |
| `tests/accessGate.test.mjs`     | Access-gate tests (unset/invalid/valid passcode paths, and that no session token or passcode is ever written to localStorage). |
| `src/styles.css`                | A curated subset of the source stylesheet (tokens, base, top bar, status pill, buttons, banners, modal, spinner, the whole Box section) plus new gate + broker-panel rules. |
| `README.md`, `docs/FRONTEND_EXTRACTION.md` | This documentation.                                              |

---

## 4. Files deliberately EXCLUDED

Not copied, by design:

| Source file                | Why excluded                                                        |
| -------------------------- | ------------------------------------------------------------------- |
| `src/api.ts` (2,623 lines) | Replaced by the focused `src/api/*` modules. Not copied.            |
| `src/App.tsx` (routing)    | Calendar-board routing; StrikeEdge has one route. Rewritten.        |
| `src/Admin.tsx`            | Admin page — not part of the Box UI.                                |
| `src/Analytics.tsx`        | Analytics page.                                                     |
| `src/StockCard.tsx`        | Calendar board card.                                                |
| `src/StockDetail.tsx`      | Stock detail page.                                                  |
| `src/TradesPanel.tsx`      | Calendar trades panel.                                              |
| `src/TradeConfirmModal.tsx`| Calendar trade confirmation.                                        |
| `src/BrokerPanel.tsx`      | Replaced by the focused `BrokerStatusPanel.tsx`.                    |
| `src/AccessTokenModal.tsx` | Exposed/handled raw access tokens — deliberately gone.              |
| `src/LineChart.tsx`        | Charting — not used by Box.                                         |
| `src/OiHistogram.tsx`      | Charting — not used by Box.                                         |
| `src/ChartReadout.tsx`     | Charting — not used by Box.                                         |
| `src/chartPath.ts`         | Charting — not used by Box.                                         |
| `src/marketData.ts`        | Calendar market-data layer — not used by Box.                       |
| `src/tickStream.ts`        | Calendar tick stream — not used by Box.                             |
| `src/SkeletonCard.tsx`     | Board skeleton — Box does not use it.                               |
| `src/brokerAction.ts`      | Board broker action helper — Box does not use it.                   |
| `tests/marketData.test.mjs`| Tests for excluded `marketData.ts`.                                 |
| `tests/tickStream.test.mjs`| Tests for excluded `tickStream.ts`.                                 |
| `tests/brokerAction.test.mjs`| Tests for excluded `brokerAction.ts`.                             |

The excluded charting/calendar styles were also left out of `styles.css`.

---

## 5. Behaviour changes vs. CalSpread

1. **Authentication is now a site passcode, not an admin token.** The source read/wrote an
   admin bearer token in `localStorage` and appended it to the SSE query string. StrikeEdge
   uses an **HttpOnly session cookie**: nothing is read from or written to `localStorage` for
   the session, and the SSE authenticates via `withCredentials: true` — **no token in the SSE
   URL**. The site passcode is only ever sent in the verify request body and is never
   persisted client-side.

2. **A single, central 401 handler.** Any `401` from any `/api/*` call fires one notification;
   the app closes the SSE, clears authenticated state and returns to the gate. The `login`
   call (`/api/access/verify`) opts out — a wrong passcode is “not accepted”, not an expired
   session.

3. **SSE reconnection is explicit and bounded.** The source used a bare `EventSource` (relies
   on the browser's built-in retry). StrikeEdge uses `ReconnectingBoxStream`: exponential
   backoff **capped** at a ceiling, and it does **not** reconnect after a 401 — it stops and
   returns to the gate.

4. **One route only.** No calendar board, no `onBack`/“Board” navigation, no admin/access
   route hints. The gate replaces all of that. `Box` now takes a single `onLock` prop.

5. **Dual-broker, both sessions visible.** A new broker status panel shows BOTH stored
   sessions with their token states (Zerodha: waiting/ready/invalid/configuration_error;
   Dhan: waiting/ready/expired/unknown expiry/configuration_error), redacted identities,
   feed/margin/charge provenance, guarded selection (`POST /api/broker/select`) and a
   switch-blocker display. A valid Dhan token while Zerodha is active reads **“Ready —
   standby”**. When the morning Zerodha default is blocked by Dhan exposure, the panel shows
   the exact required sentence. No raw/encrypted token, passcode or encryption metadata is
   ever rendered; there is no “copy access token” UI.

6. **Persistence wording reflects the new store.** PostgreSQL is the authoritative operational
   store and MongoDB Atlas an async reporting replica. The “persistence unavailable” banner
   now names PostgreSQL, and a Mongo export lag is reported calmly (expected, non-fatal). New
   readiness banners cover: waiting for today's token; instruments loading; WebSocket
   connecting; executable depth not ready; PostgreSQL unavailable; Mongo export delayed; live
   entry blocked; recovery/residual exposure.

7. **A few broker-specific strings were made neutral** (e.g. exchange-lag tooltip, leg
   verification note) since either broker can be active.

8. **Branding.** Title, header and gate say **StrikeEdge**, not Calspread. The theme
   localStorage key was rebranded `cal_spread_theme` → `strikedge_theme`. The Box sound
   preference key was intentionally **kept** as `calspread:box:sound-enabled` because the
   ported sound-preference test pins it as a documented contract.

---

## 6. Verification

- `npm ci`, `npm run build` (`tsc -b && vite build`) and `npm test` all pass.
- `git ls-files` tracks no `.env`.
- The built `dist/` bundle contains **no secret name or value**: `access_token`,
  `SITE_ACCESS`, `KITE_API` and env-var-style `DHAN_*` do not appear; the only `passcode`
  occurrences are UI copy, the only `DHAN_`-ish matches are lowercase JSON field names
  (`dhan_configured`, `dhan_static_ip`), and the only `VITE_` reference is the public
  `VITE_API_BASE_URL` config key.
