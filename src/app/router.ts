/**
 * The History-API layer of the router: ~70 lines, no dependency.
 *
 * WHY NOT REACT ROUTER
 * --------------------
 * This application has exactly TWO routes — a public landing page and one protected
 * workspace — and no nested layouts, no route params, no loaders and no data APIs. A routing
 * library would ship a runtime dependency (and a lockfile/audit surface) to every visitor to
 * replace the code below, against a stated preference for keeping the dependency surface
 * minimal and staying on plain React + Vite.
 *
 * If the route table ever grows real structure — nested layouts, parameterised paths,
 * per-route data loading — replace this module with React Router rather than growing it.
 * Everything outside this file and `lib/routing.ts` talks to routing only through
 * `useLocation` and `navigate`, so that swap stays local.
 *
 * THE PURE DECISIONS LIVE IN `lib/routing.ts` and are unit-tested there. This file holds only
 * what genuinely needs the browser: pushState/replaceState, popstate, and the hook that
 * re-renders on a URL change.
 *
 * SERVER REQUIREMENT: real URLs, not hash routes, so the server must return index.html for
 * any unknown path (`try_files … /index.html`). See README "Deployment".
 */

import { useEffect, useState } from "react";
import { normalizePath, isSameUrl } from "../lib/routing.ts";

export interface AppLocation {
  /** Pathname with a trailing slash normalised away (except for the root "/"). */
  pathname: string;
  /** Raw query string, including the leading "?" when non-empty. */
  search: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();

/** True in the browser; false under `node:test`, where there is no History API. */
const hasDom = (): boolean =>
  typeof window !== "undefined" && typeof window.history !== "undefined";

/** The current location, read from the browser. Falls back to "/" without a DOM. */
export function readLocation(): AppLocation {
  if (!hasDom()) return { pathname: "/", search: "" };
  return {
    pathname: normalizePath(window.location.pathname),
    search: window.location.search,
  };
}

function notify(): void {
  // Copied before iteration: a listener may unsubscribe during notification.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* one broken subscriber must not stop the others from learning the URL changed */
    }
  }
}

/**
 * Navigate within the app.
 *
 * `replace: true` is for a redirect the user should not be able to press Back into — e.g.
 * bouncing an unauthenticated visitor off /box, where leaving the failed attempt in the
 * history stack just traps them in a loop.
 *
 * Navigating to the URL already displayed is a no-op, so a redirect effect that re-runs
 * cannot spam the history stack.
 */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (!hasDom()) return;
  const current = `${window.location.pathname}${window.location.search}`;
  if (isSameUrl(current, to)) return;
  if (options.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  notify();
}

/** Subscribe to URL changes. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current location, re-rendering the caller whenever it changes. */
export function useLocation(): AppLocation {
  const [location, setLocation] = useState<AppLocation>(readLocation);

  useEffect(() => {
    const sync = () => setLocation(readLocation());
    // Both sources of a URL change: our own navigate(), and the browser's back/forward.
    const unsubscribe = subscribe(sync);
    window.addEventListener("popstate", sync);
    // The URL can have changed between the initial useState and this effect running.
    sync();
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", sync);
    };
  }, []);

  return location;
}

export { readQueryParam } from "../lib/routing.ts";
