import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";

export type Theme = "dark" | "light";

const THEME_STORAGE_KEY = "gtsbox.theme";

export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  // These two literals are --surface-0 of each theme. CSS cannot set the browser chrome colour,
  // so this is one of the three places the token contract is duplicated by necessity — keep it
  // in step with the :root blocks in styles.css (see the header comment there).
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#f7f9fc" : "#0b0e13");
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const isLight = theme === "light";
  const nextTheme = isLight ? "dark" : "light";
  // One string for both the tooltip and the accessible name. The control always
  // announces the action it will perform next.
  const label = `Switch to ${nextTheme} mode`;

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The active theme still works when storage is unavailable.
    }
  }, [theme]);

  return (
    <button
      type="button"
      className="btn theme-toggle"
      aria-label={label}
      aria-pressed={isLight}
      title={label}
      onClick={() => setTheme(nextTheme)}
    >
      {isLight ? (
        <SunIcon size={16} weight="regular" aria-hidden="true" />
      ) : (
        <MoonIcon size={16} weight="regular" aria-hidden="true" />
      )}
      <span>{isLight ? "Light" : "Dark"}</span>
    </button>
  );
}
