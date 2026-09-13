# GTS Box — frontend

**GTS Box is a box-arbitrage research desk for NSE F&O.** It prices four-leg boxes across
stock and index option chains continuously, shows the full expected-net arithmetic behind
every entry decision, streams open and closed positions live, and gives an operator the
controls to run the scanner, tune the entry gate, arm a trading session and switch the active
broker — all behind a single site passcode.

The word *research* is load-bearing. This is an instrument for deciding whether an edge is
real, not a dashboard that reports one: every candidate carries its own denominators, every
refusal carries a named reason, every price carries its freshness and provenance, and the
execution funnel is shown with the counts it was computed from. A number this UI cannot
substantiate is rendered as **unknown** rather than as a plausible figure — see
[`src/lib/honestLabels.ts`](src/lib/honestLabels.ts), where the labels that must change with
the system's execution mode are pure functions that *require* the mode as an argument, so a
paper claim cannot survive into a live deployment.

This repository is **only the frontend**: a React 18 + TypeScript + Vite single-page app. It
does no trading itself and holds no market logic. Every number it shows is a report from the
**GTS Box backend**, which remains the sole trading authority.

## What it needs to run

GTS Box is not usable on its own. It requires:

1. **The GTS Box backend** running and reachable. All data — box opportunities, open and
   closed trades, execution control, broker status, the live SSE stream — comes from the
   backend's `/api/*` endpoints. PostgreSQL is the backend's authoritative operational store;
   MongoDB Atlas is an async reporting replica.
2. **A site passcode.** The whole app is gated: an unauthenticated visitor sees only a
   minimal passcode screen. Verifying the passcode establishes an **HttpOnly session cookie**
   server-side — the frontend never sees, stores or forwards a token — and the dashboard then
   mounts. Any `401` from the backend closes the live stream, clears authenticated state and
   returns to the passcode screen.

One broker is active at a time. Both **Zerodha** and **Dhan** are supported; the broker panel
shows both stored sessions, guards broker switches, and lists every reason a switch is
refused.

## Configuration

The frontend is **same-origin by default**: production serves the SPA and the API on **one
origin** behind nginx, so the app makes **relative `/api/…` requests** and needs no origin
configured. In development, the Vite dev server proxies `/api` to the local backend at
`http://127.0.0.1:3001` (see `vite.config.ts`), preserving that exact same-origin model — so
the browser only ever talks to the Vite origin and the HttpOnly session cookie + CSRF Origin
check behave the same as in production.

| Env var             | Purpose                                                                                                   | Default                         |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `VITE_API_BASE_URL` | **Optional.** Backend **origin** (no trailing `/api`), e.g. `https://api.example.com`, for the rare case the API is on a *different* origin. Must be an absolute `http(s)` URL — a malformed or non-`http(s)` value **fails the build at module load** rather than silently falling back. | *unset* → same-origin `/api/…` |

Leave `VITE_API_BASE_URL` **unset** for the standard same-origin deployment. It never falls
back to `localhost`: an absent value means relative `/api/…`, so no dev/host URL can ship in
the public bundle (CI enforces this — see the bundle-origin scan in
`.github/workflows/ci.yml`).

There are **no secrets** in this repo or its build. Do not add any: the passcode, tokens and
encryption metadata all live on the backend.

## Develop

```bash
npm ci            # install exact locked dependencies
npm run dev       # Vite dev server on http://localhost:5173
```

The dev server proxies `/api` → `http://127.0.0.1:3001`, so just start the GTS Box backend
on port 3001 locally — **no `VITE_API_BASE_URL` is needed**. Only set it (to a full
`https://…` origin) if you are pointing the dev UI at a backend on a genuinely different
origin; if you do, any local `.env` is git-ignored and must never be committed.

## Build & test

```bash
npm run build     # tsc -b && vite build  (strict typecheck + production bundle)
npm test          # node --test against the pure TS modules (Node 22 strips types natively)
npm run preview   # serve the production build locally
```

CI (`.github/workflows/ci.yml`) runs `npm ci` (which also enforces the lockfile is in sync),
`npm run build` and `npm test` on Node 22.

## API contract gate

The frontend and backend response shapes are kept in lockstep by a **vendored, pinned,
backend-owned JSON-Schema contract** under [`contract/`](contract/README.md). This closes the
gap where a backend field could be renamed while the frontend kept passing against a stale
hand-captured fixture.

- **Vendored + pinned, never a live download.** `contract/schemas/**`, `validate.mjs`,
  `digest.mjs` and `version.json` are copied verbatim from the backend and pinned by commit SHA
  + digest in `contract/BACKEND_CONTRACT.json`. A normal build reads this vendored, digest-
  verified copy — it never depends on an unpinned fetch of the backend's `main`.
- **`npm run contract:verify`** — recomputes the sha256 over the vendored schemas and asserts it
  matches `schemas_sha256` in **both** `version.json` and `BACKEND_CONTRACT.json`, and that all
  pinned files exist. A stale, tampered or incomplete vendored contract fails loudly.
- **`npm run contract:types`** — regenerates `src/api/contract.generated.ts` (TypeScript types)
  from the vendored schemas, deterministically. CI regenerates and `git diff --exit-code`s it, so
  a stale committed file fails.
- **Static drift gate (`tsc -b`).** `src/api/contract.assert.ts` asserts, at compile time, that
  the hand-written types in `src/api/types.ts` stay compatible with the generated contract types.
  A backend shape change the frontend has not adopted **fails the build**.
- **Runtime schema validation (`npm test`).** `tests/contractSchemas.test.mjs` validates the
  retained sample fixtures against the vendored schemas with the vendored validator, and includes
  negative controls proving a deleted/renamed required field is reported by name; and
  `tests/contractVerify.test.mjs` proves a tampered/stale/missing vendored contract fails
  `contract:verify` (all in throwaway temp copies — the real `contract/` is never mutated).

**Updating the contract is a coordinated, backend-first procedure** — see
[`contract/README.md`](contract/README.md) for the exact 8-step process, and note the banner at
the top of that file about updating the pinned `backend_sha` before pushing.

### Dependency audit

`npm audit` (the full tree, production **and** dev dependencies) currently reports **no
vulnerabilities** — no low, moderate, high or critical advisory remains. The earlier HIGH on
`vite` (`<=6.4.2`) and MODERATE on the transitive `esbuild` (`<=0.24.2`) are cleared by pinning
the build toolchain to **exact, non-vulnerable** versions:

| Package               | Pinned version | Why                                                                                   |
| --------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `vite`                | `6.4.3`        | Lowest release `> 6.4.2`, so it clears the Vite path-traversal / `fs.deny` / launch-editor advisories; depends on `esbuild@^0.25`, clearing the esbuild dev-server advisory. |
| `@vitejs/plugin-react`| `4.7.0`        | Latest `4.x`; peers `vite ^6`, and supports React 18 (React stays at 18.3.1).         |
| `typescript`          | `5.6.3`        | Unchanged version, now pinned exact for the same reason.                              |

These three are pinned **without a `^` range** so a future floating bump cannot silently pull a
build tool back into an advisory. CI enforces this continuously with
`npm audit --audit-level=high` over the complete dependency tree (see `.github/workflows/ci.yml`),
so a high/critical advisory — in a runtime or a dev/build dependency — fails the pipeline.

## What is inside

- **`/` is the only route** — the Box dashboard. No calendar board, no admin page, no charts.
- **Passcode gate** (`src/auth/AccessGate.tsx`) — UX in front of the backend's real boundary.
- **Focused API layer** (`src/api/`) — a single fetch wrapper with same-origin cookie
  credentials, an **in-memory CSRF token** (delivered in the body of `/api/access/verify` and
  an authenticated `/api/access/status`, never read from a cookie or persisted) echoed as the
  CSRF header on mutating requests, and one central `401` handler; plus access,
  box and broker calls, and the lifted response types. The CSRF header **name** is not
  hardcoded: it is single-sourced from the backend-owned `contract/protocol.json` (`csrf_header`,
  currently `x-csrf-token`), emitted as `CSRF_HEADER` into `src/api/contract.generated.ts` by
  `npm run contract:types` and imported by `src/api/http.ts`, so a backend rename propagates
  mechanically and a one-sided rename fails CI.
- **Reconnecting SSE** (`src/lib/boxStream.ts`) — reconnects after a transient drop with
  capped backoff, and does **not** reconnect after a `401`.
- **Dual-broker panel** (`src/BrokerStatusPanel.tsx`) — both sessions, redacted identities,
  feed/margin/charge provenance, guarded selection and switch-blockers. It never renders a
  raw token, encrypted token, passcode or encryption metadata.
- **The desk itself** — the opportunity table with per-candidate arithmetic, open positions,
  closed history, the ATM±3 chain, execution/session/risk control panels, day P&L, execution
  health, the operational-state panel with the funnel and its denominators, sounds and the
  dark/light theme.
- **One design system** (`src/styles.css`) — every colour, size, space and duration is a
  design token, so the light theme is a token swap and no component rule branches on it. The
  four rules it enforces (data outranks chrome; colour is semantic and `--accent` is
  interaction-only; numbers are monospaced and tabular; flat in dark, shadowed in light) are
  documented in the header of that file.

## Provenance

GTS Box began as an extraction from an earlier calendar-spread application, and
`docs/FRONTEND_EXTRACTION.md` is the honest file-by-file record of that: what was copied, what
was rewritten, what was deliberately left behind, and every behaviour change made on the way.
It is kept as an engineering record, not as a description of the product — GTS Box is a
box-arbitrage research desk with its own contract, its own access model and its own design
system, and the record exists so that a reviewer can audit where each file came from.
