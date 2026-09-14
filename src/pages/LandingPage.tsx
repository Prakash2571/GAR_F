/**
 * The public GTS Algo Research page.
 *
 * PUBLIC MEANS PUBLIC. This page issues exactly ONE backend request in its whole lifetime,
 * and it is not this component's: the session probe (`GET /api/access/status`) that
 * `<AccessProvider>` fires once at app start. No Box SSE stream, no broker status, no
 * portfolio, no trade history, no execution status, no readiness poll — none of that is
 * imported here, let alone called. Those all live inside the workspace, which is only mounted
 * behind `<ProtectedRoute>`. That is a security boundary (nothing account-shaped is fetched
 * for an anonymous visitor) and a resource decision (a public page must not hold an SSE
 * connection open on a trading backend).
 *
 * CONTENT. Deliberately short and factual. There are no performance figures, no AUM, no
 * testimonials and no capability claims the project cannot back — a research page that
 * oversells is less credible, not more, and this one is shown publicly.
 */

import { useCallback, useEffect, useState } from "react";
import LandingHeader from "../components/layout/LandingHeader.tsx";
import LandingFooter from "../components/layout/LandingFooter.tsx";
import PasscodeModal from "../auth/PasscodeModal.tsx";
import { useAccess } from "../auth/AccessGate.tsx";
import { navigate, useLocation } from "../app/router.ts";
import { ROUTE_PATHS, readQueryParam } from "../lib/routing.ts";
import Button from "../components/ui/Button.tsx";

/** The three things the project actually does. One sentence each. */
const PILLARS = [
  {
    label: "Research",
    body: "Market structure, execution quality and systematic opportunity analysis.",
  },
  {
    label: "Systems",
    body: "Real-time market-data pipelines, broker integrations and automated execution infrastructure.",
  },
  {
    label: "Risk",
    body: "Explicit controls, deterministic state transitions and defensive execution safeguards.",
  },
] as const;

export default function LandingPage() {
  const { state, authenticated } = useAccess();
  const location = useLocation();
  const [passcodeOpen, setPasscodeOpen] = useState(false);

  /**
   * `/?auth=1` opens the dialog automatically.
   *
   * That is the URL `<ProtectedRoute>` redirects an unauthenticated visitor to, so a direct
   * hit on /box lands here with the passcode prompt already up rather than on a page with no
   * explanation of why they were moved.
   *
   * Gated on `state !== "checking"`: while the session probe is still in flight we do not yet
   * know whether a passcode is needed, and flashing a dialog at a visitor who already has a
   * live session would be wrong.
   */
  useEffect(() => {
    if (state === "checking") return;
    if (readQueryParam(location.search, "auth") === null) return;
    if (authenticated) {
      // A live session and an explicit request to authenticate: just go in.
      navigate(ROUTE_PATHS.box, { replace: true });
      return;
    }
    setPasscodeOpen(true);
  }, [state, authenticated, location.search]);

  /**
   * The single primary action.
   *
   * An already-authenticated visitor goes straight to the workspace — being asked for a
   * passcode you have already given is the classic re-authentication annoyance, and the
   * backend has already told us the session is live.
   */
  const onEnterBox = useCallback(() => {
    if (authenticated) {
      navigate(ROUTE_PATHS.box);
      return;
    }
    setPasscodeOpen(true);
  }, [authenticated]);

  /** Closing the dialog drops `?auth=1`, so the URL keeps matching what is on screen. */
  const onClosePasscode = useCallback(() => {
    setPasscodeOpen(false);
    if (readQueryParam(location.search, "auth") !== null) navigate(ROUTE_PATHS.landing, { replace: true });
  }, [location.search]);

  return (
    <div className="gts-site">
      {/*
       * A photographic sense of place — Ghatsila — behind the top of the page.
       *
       * DECORATIVE, AND ONLY DECORATIVE. It is an empty element carrying a CSS background,
       * hidden from assistive technology: it conveys nothing a screen-reader user would
       * otherwise miss, so announcing it would be noise. The text over it is unchanged and
       * keeps its own colours; the scrim in `.gts-hero-backdrop` is what protects contrast.
       *
       * WHY NOT AN <img>. The asset lives in `public/` and is referenced by absolute URL from
       * CSS, so if it is absent the layer paints nothing and the page renders exactly as it
       * did before. An <img> would show a broken-image glyph, and a bundler-resolved import
       * would fail the BUILD — neither is an acceptable outcome for decoration on the public
       * page of a trading project. See the `--hero-image` variable in styles.css.
       */}
      <div className="gts-hero-backdrop" aria-hidden="true" />

      <LandingHeader onEnterBox={onEnterBox} busy={state === "checking"} />

      <main className="gts-site-main">
        <section className="gts-hero" aria-labelledby="gts-hero-heading">
          <p className="gts-eyebrow">Algorithmic trading research · Ghatsila</p>
          <h1 className="gts-hero-heading" id="gts-hero-heading">
            Research. Engineer. Execute.
          </h1>
          <p className="gts-hero-lead">
            GTS Algo Research is an algorithmic trading research project from Ghatsila,
            developed by the BeOnEdge team.
          </p>
          <p className="gts-hero-sub">
            We build research-driven systems for market structure, execution and systematic
            trading.
          </p>
          <div className="gts-hero-actions">
            <Button variant="primary" size="md" onClick={onEnterBox} aria-busy={state === "checking"}>
              Enter Box
            </Button>
            <span className="gts-hero-hint">Private research workspace</span>
          </div>
        </section>

        <section className="gts-pillars" aria-label="What we work on">
          {PILLARS.map((pillar) => (
            <article className="gts-pillar" key={pillar.label}>
              <h2 className="gts-pillar-label">{pillar.label}</h2>
              <p className="gts-pillar-body">{pillar.body}</p>
            </article>
          ))}
        </section>
      </main>

      <LandingFooter />

      {passcodeOpen && (
        <PasscodeModal
          onClose={onClosePasscode}
          onAuthenticated={() => {
            setPasscodeOpen(false);
            navigate(ROUTE_PATHS.box, { replace: true });
          }}
        />
      )}
    </div>
  );
}
