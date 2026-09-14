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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <ScrollToTop />
  </React.StrictMode>,
);
