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

**The asset is in git and bundled**, at:

```
src/image/gts2.jpg      3840 × 2160, 2.2 MB
```

`src/styles.css` references it with a path relative to itself (`url("./image/gts2.jpg")`), so
Vite resolves it at build time and emits a content-hashed copy into `dist/assets/`. That is the
only place the filename appears; to swap the photograph, change `--hero-image` there and
nothing else.

The earlier `gts.png` (1366 × 768) was removed once this replaced it — nothing referenced it and
it was 2.35 MB of dead weight in every checkout. It is still in history:
`git checkout f02d571 -- src/image/gts.png`.

It previously lived at an absolute `/public` URL, chosen so a *missing* file degraded to "no
backdrop" rather than breaking the build. That mattered while the asset was outside the repo,
but it also meant a wrong filename failed **silently**, as a 404 the page could not report —
which is exactly how the backdrop spent its first release invisible. Now that the file is
committed, build-time resolution is strictly better: a bad path is a loud build error, and the
content hash makes the asset permanently cacheable with no stale-cache risk when it changes.

**Resolution is now correct; weight is not.** At 3840px wide the backdrop is *downscaled* on
every display in normal use, which is the condition under which a CSS background looks genuinely
crisp — the previous 1366px source was upscaled ~1.4× at 1920px and ~1.9× at 2560px, and
upscaling is softness no filter can undo.

The remaining issue is transfer size: **2.2 MB for decoration on a public page.** 4K is more
resolution than the backdrop can use, since it is cropped to a band and sits under a scrim. A
2560px export at q76 would look identical and cost roughly a tenth:

```bash
magick src/image/gts2.jpg -resize 2560x -quality 76 src/image/gts2.jpg
```

| | current | target |
| --- | --- | --- |
| width | 3840px | 2400–2800px |
| size | 2.2 MB | under ~350 KB |

**Content note:** keep the calmer landscape frames in the upper band. The backdrop is
`background-size: cover` in a band far wider than 16:9, so it is cropped vertically — most on a
phone, where the sides go too.

**A missing file is now a build failure, by design.** The trade is deliberate: a loud error at
build time is worth more than a silent 404 in production. If you need the old
degrade-to-nothing behaviour, move the file back to `public/` and use an absolute URL.

**It is decorative and yields to the user.** It is an empty `aria-hidden` element, so it is
never announced; and it is removed entirely under `prefers-contrast: more`,
`forced-colors: active`, `prefers-reduced-transparency: reduce`, and when printing.

Optional, once you have modern formats to hand — swap one line in `src/styles.css` for
automatic AVIF/WebP selection. Every file listed must exist, or the build now fails rather than
404ing:

```css
--hero-image: image-set(
  url("./image/gts.avif") type("image/avif"),
  url("./image/gts.webp") type("image/webp"),
  url("./image/gts.jpg")  type("image/jpeg")
);
```

### Retuning the backdrop

Every knob is a custom property at the top of `src/styles.css`. There is now **one** set, not
one per theme — see "The landing page is dark only" below.

| property | does |
| --- | --- |
| `--hero-photo-opacity` | strength — `0.36` |
| `--hero-photo-blur` | `0px`. It was `14px`, which is what made the photograph unreadable |
| `--hero-photo-filter` | `saturate(1.06) contrast(1.08) brightness(0.88)` |
| `--hero-photo-fade` | mask that ends the photo layer downwards |
| `--hero-veil` | the two-axis scrim |
| `--hero-max-height` | ceiling on the band's height |
| `--hero-copy` / `--hero-copy-quiet` | hero text colours, brighter than the site tokens |

**The two veil gradients multiply.** This is the trap in this component. A horizontal ramp that
looks reasonable on its own — say `0.74` at the left falling to `0` at the right — combines with
the vertical one to put the left edge under `~0.92` while the right sits under `~0.70`, so the
same photograph is visible on one side and *completely gone* on the other at identical height.
Keep the horizontal axis shallow, and read the measured figures in the comment on `--hero-veil`
before changing a stop.

**Contrast is bought from the type, not the scrim.** Against the current veil, the site's own
`--text-secondary` measures 3.0:1 and `--text-muted` 1.6:1 over the photograph — both unusable.
That is why the hero copy has its own brighter tokens plus a hairline `text-shadow`. Darkening
the veil to rescue dim grey text would defeat the point of the backdrop; brighten the text
instead, and re-check the ratios if you lower the veil further.

The band fills the width and crops vertically, centred. Showing the image **whole** instead is
two lines — `height: auto; aspect-ratio: 16 / 9;` on `.gts-hero-backdrop` plus
`background-size: contain` on its `::before` — but on a laptop that yields a centred panel
narrower than the 1180px text column, which reads as a mistake rather than a backdrop.

### The landing page is dark only

`/` ignores the stored and OS theme preferences and has no theme control. `/box` keeps both the
toggle and both palettes — light mode is removed from the public page, not from the application.

The page is a single composed surface whose scrim is tuned in measured steps against one
photograph's luminance. Light mode needed a second, independently tuned set of those values, and
the two could not be kept honest against each other: every backdrop adjustment silently
invalidated the other theme's contrast. The workspace is the opposite case — dense, read for
hours, no photography — so it keeps the choice.

Enforced in three places, and all three are needed:

| where | why |
| --- | --- |
| `main.tsx` | applies it **pre-render**, so a visitor whose stored preference is light never sees a white frame |
| `LandingPage.tsx` | on mount, for client-side navigation back from `/box`; the cleanup restores the *stored* preference |
| `LandingHeader.tsx` | no `ThemeToggle` — a control that appeared to do nothing would be worse than none |

Neither path writes to storage, so a workspace preference survives a visit to the public page.
`[data-theme="light"]` no longer defines any `--hero-*` value; to restore a light backdrop,
re-add those and give the landing page a control again.

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
