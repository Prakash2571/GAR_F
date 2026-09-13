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
import "./styles.css";

// Applied BEFORE the first render so the correct theme is painted immediately. Doing it in a
// component effect would flash the default theme for one frame on every load.
applyTheme(readStoredTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <ScrollToTop />
  </React.StrictMode>,
);
