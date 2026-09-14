/**
 * Theme selection and persistence — no React.
 *
 * Kept out of the toggle COMPONENT so the parts that can silently break are unit-testable
 * without a DOM library: what is read from storage, what a corrupt value falls back to, and
 * exactly which document properties a theme sets. `main.tsx` also needs `applyTheme` before
 * the first render, which is a module concern rather than a component one.
 */

export type Theme = "dark" | "light";

/**
 * localStorage key for the theme preference.
 *
 * A UI PREFERENCE, NOT A CREDENTIAL. This is one of only two keys the application writes
 * client-side; CI scans the built bundle and fails on any localStorage key outside that
 * allow-list, which is what keeps a session token from ever being stashed here.
 *
 * The key was renamed with the rebrand. The only consequence is that an existing visitor's
 * stored preference is not found once, so they fall back to their OS `prefers-color-scheme`
 * and re-pick if they want something else. No session, no data and no trading state is
 * carried in it, so a one-time reset is the whole cost.
 */
export const THEME_STORAGE_KEY = "gts_theme";

/**
 * The browser-UI colour per theme, kept in step with `--bg` in styles.css.
 *
 * Set on the `theme-color` meta so mobile browser chrome matches the page instead of framing
 * a near-black page in white.
 */
export const THEME_COLOR: Record<Theme, string> = {
  dark: "#060708",
  light: "#f6f7f8",
};

/** DARK is the default and the primary identity — a product decision, not a fallback. */
export const DEFAULT_THEME: Theme = "dark";

/**
 * THE PUBLIC LANDING PAGE IS DARK ONLY. It has no theme control and ignores both the stored
 * preference and the OS one.
 *
 * The page is a single composed surface — one photographic backdrop, one headline, a scrim
 * tuned in measured steps against that photograph's luminance. Light mode required a second,
 * separately tuned set of those values, and the two could not be kept honest against each
 * other: every adjustment to the backdrop silently invalidated the other theme's contrast.
 * The workspace at /box is different — it is dense, long-lived, read for hours, and carries no
 * photography — so it KEEPS the toggle and both palettes. Light mode is not removed from the
 * application, only from this one page.
 *
 * Applied WITHOUT persisting, so a visitor who chose light for the workspace still gets it
 * there. See `main.tsx` (pre-render, to avoid a flash) and `LandingPage.tsx` (on mount, for
 * client-side navigation back from /box).
 */
export const LANDING_THEME: Theme = "dark";

/**
 * Interpret a raw stored value.
 *
 * Only the two exact strings are honoured. Anything else — absent, empty, "Dark", a
 * half-written value, a key left behind by another application — is NOT a theme, and
 * returning `null` lets the caller fall through to the OS preference rather than pinning
 * the page to a theme the user never chose.
 */
export function parseStoredTheme(raw: string | null | undefined): Theme | null {
  return raw === "light" || raw === "dark" ? raw : null;
}

/**
 * The stored preference, else the OS preference, else dark.
 *
 * Reads `localStorage` and `window.matchMedia` from globals so it can be exercised with
 * stubs. Storage can throw outright (private mode, disabled cookies) and `matchMedia` does
 * not exist in every environment, so both are guarded: the app must still render with a
 * working theme when it simply cannot remember or detect one.
 */
export function readStoredTheme(): Theme {
  try {
    const stored = parseStoredTheme(localStorage.getItem(THEME_STORAGE_KEY));
    if (stored !== null) return stored;
  } catch {
    /* fall through to the OS preference */
  }
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persist the preference. Never throws — an unwritable store must not break the toggle. */
export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The active theme still works when storage is unavailable; it just is not remembered.
  }
}

/**
 * Apply a theme to the document.
 *
 * THREE THINGS, and all three matter:
 *   • `data-theme` on <html> is the single switch every token in styles.css hangs off, so
 *     there is exactly one place a theme is selected.
 *   • `color-scheme` makes form controls, scrollbars and the caret follow the theme instead
 *     of staying in the browser default — the detail that otherwise leaves a white scrollbar
 *     down the side of a near-black page.
 *   • the `theme-color` meta colours the mobile browser chrome.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}
