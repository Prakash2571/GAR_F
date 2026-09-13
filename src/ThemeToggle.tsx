/**
 * The theme toggle control.
 *
 * The selection/persistence logic lives in `lib/theme.ts` (and is unit-tested there); this
 * component is only the button. It is re-exported from here as well, because `main.tsx` and
 * several existing modules import `applyTheme` / `readStoredTheme` from this path.
 */

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { applyTheme, readStoredTheme, storeTheme, type Theme } from "./lib/theme.ts";

export { applyTheme, readStoredTheme, storeTheme };
export type { Theme };

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const isLight = theme === "light";
  const nextTheme: Theme = isLight ? "dark" : "light";
  // One string for both the tooltip and the accessible name. The control always announces the
  // ACTION it will perform next, not the state it is in — `aria-pressed` carries the state.
  const label = `Switch to ${nextTheme} mode`;

  useEffect(() => {
    applyTheme(theme);
    storeTheme(theme);
  }, [theme]);

  return (
    <button
      type="button"
      className="btn btn--quiet theme-toggle"
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
      <span className="theme-toggle-label">{isLight ? "Light" : "Dark"}</span>
    </button>
  );
}
