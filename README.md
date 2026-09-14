# GTS Algo Research — frontend

**GTS Algo Research is an algorithmic trading research project from Ghatsila, developed by
the BeOnEdge team.**

This repository is its **frontend**, and it is two surfaces in one app:

| Route | Surface | Access |
| --- | --- | --- |
| `/` | The public GTS Algo Research page. | **Public.** |
| `/box` | **GTS Box** — the algorithmic execution workspace. | **Protected** by the site passcode. |

> ### ⚠️ This is algorithmic trading research and execution software
>
> The workspace operates a backend that can place **real orders with real money** when
> configured to. Trading involves financial risk. Nothing here is investment advice, a
> recommendation, or a claim about returns.

---

## What it is

This is a **view**, not an authority. Every number, status, mode and permission it renders
comes from the backend. It deliberately derives nothing of its own:

- it never decides that trading is ready — it renders the backend's own operational-readiness
  decision, and orders those decisions across a backend restart;
- it never labels a deployment "paper" from a constant — the mode label comes from the
  backend's `execution_mode`, because that is the single most dangerous label a trading UI
  can get wrong;
- it never converts a missing value into a plausible one. An unpriced figure renders as
  "unpriced", never as ₹0; a stale book says how old it is; a paper fill is never called an
  exchange fill.

It is **not usable on its own.** It requires the [GTS Algo Research backend](https://github.com/Prakash2571/GTSAlgoResearch_B)
running and reachable — it is the sole trading authority and the sole source of data.

---

## Architecture

```
main.tsx
  └─ app/App.tsx
       └─ AccessProvider              session state; probes GET /api/access/status once
            └─ app/routes.tsx
                 ├─ /      pages/LandingPage.tsx      PUBLIC
                 │            └─ auth/PasscodeModal.tsx
                 └─ /box   auth/ProtectedRoute.tsx    guard
                              └─ pages/BoxPage.tsx
                                   └─ Box.tsx          the workspace
```

```
src/
  app/        App.tsx, routes.tsx, router.ts          routing shell
  pages/      LandingPage.tsx, BoxPage.tsx
  auth/       AccessGate.tsx (session provider), PasscodeModal.tsx, ProtectedRoute.tsx
  api/        http.ts (one transport), access.ts, box.ts, types.ts, contract.generated.ts
  components/
    brand/    GTSMark.tsx, GTSWordmark.tsx
    layout/   LandingHeader.tsx, LandingFooter.tsx, BoxHeader.tsx
    ui/       Button.tsx, Modal.tsx, StatusBadge.tsx
  lib/        routing.ts, theme.ts, boxStream.ts, operationalState.ts, readinessOrder.ts,
              statusIntegrity.ts, honestLabels.ts, boxSounds.ts
  Box*.tsx    the workspace panels (opportunities, positions, history, execution,
              session, risk, readiness, order stream, broker, help)
  styles.css  the whole design system
```

**Routing has no dependency.** Two routes, no nested layouts, no route params, no loaders —
so `app/router.ts` is ~70 lines over the History API and the path decisions live in
`lib/routing.ts` (pure, and unit-tested). If the route table ever grows real structure,
replace that module with React Router rather than growing it: everything else touches routing
only through `useLocation` and `navigate`.

**The backend contract is vendored.** `contract/` is a verbatim copy of the backend's
contract directory, pinned by commit SHA **and** digest in `contract/BACKEND_CONTRACT.json`.
`src/api/contract.generated.ts` is generated from it and must never be hand-edited. CI
recomputes the digest, regenerates the types and fails on any drift, so a backend shape change
the frontend has not adopted cannot be shipped.

---

## Authentication: Enter Box

```
/  (public)
   └─ "Enter Box"
        ├─ already authenticated?  ──▶  /box
        └─ otherwise: passcode dialog
              └─ POST /api/access/verify
                    ├─ 401  ──▶  "Invalid passcode" (and nothing else)
                    └─ 200  ──▶  backend sets the HttpOnly session cookie  ──▶  /box
```

- A direct visit to `/box` **without** a session redirects to `/?auth=1`, which shows the
  public page with the passcode dialog already open. **No protected content is rendered
  first** — the workspace only mounts in the authenticated state, so there is no frame in
  which trading data is on screen before the backend has confirmed the session.
- The public page issues **exactly one** backend request in its whole lifetime: the session
  probe. No Box SSE, no broker status, no positions, no history, no readiness polling — those
  modules are not even reachable from it, and a test walks the real import graph to prove it.
- **Any 401, anywhere**, clears session state. That unmounts the workspace, whose own effect
  cleanup closes the SSE stream and clears every timer, and the browser returns to `/`.
- **Lock** revokes the session server-side (with its CSRF header), clears the cookies, tears
  down the workspace and returns to `/`.

### What this frontend never does

- No passcode in source, in `localStorage`, in `sessionStorage`, in a cookie, in a URL or in
  a log. It exists as a React input value for one submit and is cleared on success.
- **No `VITE_SITE_PASSWORD`, and no client-side authentication.** The passcode is
  backend-controlled; `SITE_ACCESS_SECRET` is backend-only and CI fails the build if that
  string appears anywhere in the shipped bundle.
- No session token client-side. The session is the HttpOnly cookie; the CSRF token lives only
  in the transport's process memory and is dropped on reload, logout and any 401.
- Only **two** `localStorage` keys are written, both UI preferences — `gts_theme` and the Box
  sound on/off flag. CI resolves every `localStorage` key in the built bundle and fails on
  anything outside that allow-list.

---

## Design

**Dark is the default and the primary identity**; light is a fully designed palette, not an
inversion — its surfaces rise from a grey page to white, the opposite direction from dark's
near-black to lifted greys. The choice persists across reloads, and falls back to the OS
`prefers-color-scheme`.

Both surfaces share one language, with opposite briefs:

- **the public page** is spacious: negative space, a restrained type hierarchy, no
  chart imagery, and exactly ONE photographic element — the Ghatsila hero backdrop described
  below. That is a deliberate, single exception to the otherwise illustration-free brief: the
  project is *from* Ghatsila, and a sense of place is the one thing type alone cannot say. It
  is treated as atmosphere, not as a subject — held behind a two-axis scrim, and it never
  changes a text colour;
- **the workspace** is dense: hairline rules, compact rows, tabular numerals, sticky table
  headers, and horizontal scrolling for wide financial tables — because compressing seventeen
  columns of rupee amounts to avoid a scrollbar produces a table nobody can read.

Every colour is a token declared once per theme in `src/styles.css`; nothing outside the two
token blocks uses a literal colour. **No status is communicated by colour alone** — every
badge carries text and a tone-specific glyph, so state survives colour-blindness and a
greyscale screenshot. Motion is 100–200 ms, opacity and transform only, and respects
`prefers-reduced-motion`.

Primary target is a desktop trading workstation (1366×768 → 2560×1440). The public page also
works on a phone.

### The Ghatsila hero backdrop

The landing page carries one photographic backdrop — a collage of Ghatsila — behind the header
and hero, fading into the page background before the pillars.

**The asset is not in git.** Drop it in as:

```
public/ghatsila.jpg
```

That is the only place the filename appears outside CSS; to rename it, change `--hero-image`
in `src/styles.css` and nothing else.

**Preparing the file.** Export it *wider than it looks like it needs to be* — the backdrop is
`background-size: cover`, so on a 2560px display a 1024px-wide source is upscaled 2.5× and
goes visibly soft:

| | |
| --- | --- |
| width | **2400–2800px** (16:9, so ~2560×1440) |
| format | JPEG, quality 72–78 |
| target size | **under ~350 KB** — it is decoration on a public page, not content |
| content | keep the calmer landscape frames in the upper band; that is the part that survives a wide crop, and on a phone it is nearly all that is visible |

**If the file is absent the page still renders correctly**, with no backdrop, no broken-image
glyph, no layout shift and no build error. That is why it is a CSS `background-image` pointing
at an absolute `/public` URL rather than an `<img>` or a bundler-resolved `import` — either of
those would fail the build or paint a broken icon in production.

**It is decorative and yields to the user.** It is an empty `aria-hidden` element, so it is
never announced; and it is removed entirely under `prefers-contrast: more`,
`forced-colors: active`, `prefers-reduced-transparency: reduce`, and when printing.

Optional, once you have modern formats to hand — swap one line in `src/styles.css` for
automatic AVIF/WebP selection (only add formats whose files actually exist, or they will 404):

```css
--hero-image: image-set(
  url("/ghatsila.avif") type("image/avif"),
  url("/ghatsila.webp") type("image/webp"),
  url("/ghatsila.jpg")  type("image/jpeg")
);
```

---

## Environment setup

```bash
npm ci
npm run dev          # Vite dev server, proxying /api → http://127.0.0.1:3001
```

Start the backend first; the dev server proxies `/api` to it (see `vite.config.ts`).

This repository ships **no `.env.example`, and needs none.** There is exactly one optional
variable:

| Variable | Default | What it does |
| --- | --- | --- |
| `VITE_API_BASE_URL` | *(unset)* | The API **origin**. Leave it unset for production: the SPA and API are served same-origin behind nginx, so requests are relative `/api/...` and the HttpOnly cookie rides along. A malformed value throws at module load rather than quietly talking to the wrong place. |

There is deliberately **no frontend variable for the passcode, the session or any secret.**

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server. |
| `npm run build` | `tsc -b && vite build` → `dist/`. The typecheck is strict and includes the contract type-assertions. |
| `npm run preview` | Serve the built bundle locally. |
| `npm test` | Every test, under `node:test` with native type-stripping. No bundler, no jsdom. |
| `npm run contract:verify` | Recompute the vendored contract digest and check it against the pin. |
| `npm run contract:types` | Regenerate `src/api/contract.generated.ts` from the vendored contract. |
| `npm run contract:types:check` | Regenerate and fail if the committed file is stale. |

### Tests

```bash
npm test
```

Covers: routing and which paths are protected; theme persistence, fallback and both themes'
rendering hooks; the passcode/session API contract and its fail-closed behaviour; CSRF token
lifecycle; SSE reconnection and 401 teardown; readiness ordering across a backend restart;
status integrity; response shapes against fixtures captured from a running backend; that the
public page cannot reach the trading API; and that no legacy branding remains in the shipped
source.

---

## Production deployment

Build, then serve `dist/` as static files behind **nginx + HTTPS** — ideally on the **same
origin** as the API, which is what the frontend defaults to.

```bash
npm ci && npm run build      # → dist/
```

### The SPA fallback is required

`/box` is a **real URL**. The browser can request it directly on a bookmark, a refresh or a
shared link, and there is no `/box` file on disk and no `/box` route on the backend. Without a
fallback that request 404s and the workspace is unreachable except by clicking through from
the home page.

```nginx
root /var/www/gts;                 # this repo's built dist/
index index.html;

# THE SPA FALLBACK — required.
location / { try_files $uri $uri/ /index.html; }

# Hashed assets are immutable; index.html must NEVER be cached, or a browser keeps
# loading an old bundle that references deleted asset hashes.
location /assets/    { add_header Cache-Control "public, max-age=31536000, immutable"; }
location = /index.html { add_header Cache-Control "no-store" always; }

# Same-origin API: keeps the session cookie same-origin and CSRF trivial.
location /api/ { proxy_pass http://gts_backend; }
```

nginx must **not** try to protect `/box` — authorisation is the backend's job, enforced per
request on every `/api/box/*` call.

`GET /api/box/stream` is Server-Sent Events and needs its own location with
`proxy_buffering off`, `proxy_cache off`, a long `proxy_read_timeout` and
`X-Accel-Buffering: no`, or the live board appears frozen. The backend repo's
`deploy/nginx.conf` carries the complete, commented configuration for both topologies.

Other requirements: **HTTPS** (the session cookie is `Secure` in production), the backend's
`FRONTEND_URL` / `CSRF_ALLOWED_ORIGIN` must name this exact origin, and the backend port is
never exposed directly.
