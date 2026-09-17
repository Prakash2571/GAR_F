import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import App from "./app/App.tsx";
import ScrollToTop from "./ScrollToTop.tsx";
import { applyTheme, readStoredTheme } from "./ThemeToggle.tsx";
import { LANDING_THEME } from "./lib/theme.ts";
import { resolveRoute } from "./lib/routing.ts";
import { captureBrokerLoginOutcome } from "./lib/brokerLogin.ts";
import "./styles.css";

// Applied BEFORE the first render so the correct theme is painted immediately. Doing it in a
// component effect would flash the default theme for one frame on every load.
//
// ROUTE-AWARE, because the public page is dark only (see LANDING_THEME). Deciding this here
// rather than in LandingPage's effect is what prevents a visitor whose stored preference is
// light from seeing one white frame before the effect corrects it. Anything that is not the
// workspace is the landing page — an unknown path is redirected to it — so `box` is the only
// case that reads the stored preference.
applyTheme(resolveRoute(window.location.pathname) === "box" ? readStoredTheme() : LANDING_THEME);

/**
 * Captured BEFORE the first render, for one reason: the authentication gate can navigate away
 * from this URL before the broker panel ever mounts.
 *
 * When the backend finishes an in-app broker sign-in it redirects here with
 * `?broker_login=…&status=…`. If the session lapsed while the operator was away at the broker
 * — the one moment it plausibly could — `ProtectedRoute` replaces the URL with `/?auth=1` and
 * the outcome is gone, so a FAILED sign-in would show no notice and no reason at all. Reading
 * it here puts it in module memory, which survives every client-side navigation (the router
 * uses the History API), so the panel still finds it after the passcode is re-entered.
 *
 * The parameters are stripped immediately so a reload cannot re-announce a stale result and a
 * shared URL cannot announce someone else's sign-in. `replaceState` rather than `pushState`,
 * so Back does not walk the operator through the redirect. Any unrelated query parameter is
 * preserved.
 */
const { cleanedSearch } = captureBrokerLoginOutcome(window.location.search);
if (cleanedSearch !== window.location.search) {
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${cleanedSearch}${window.location.hash}`,
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <ScrollToTop />
  </React.StrictMode>,
);
