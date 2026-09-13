/**
 * Pure routing logic — no React, no DOM.
 *
 * Kept apart from `src/app/router.ts` (which owns the History API and the `useLocation`
 * hook) so the decisions that actually matter can be unit-tested directly under
 * `node:test`, with no bundler and no jsdom:
 *
 *   • which surface a URL maps to, including the "unknown path" case;
 *   • whether a path is the PROTECTED one, which is what decides whether the auth guard
 *     applies;
 *   • trailing-slash normalisation, so "/box/" is not treated as an unknown path and
 *     silently redirected to the public page;
 *   • query reading, which is how "/?auth=1" opens the passcode dialog;
 *   • the no-op guard that stops a redirect effect pushing the same URL repeatedly.
 */

/** Canonical route paths. Nothing should navigate to a bare string literal. */
export const ROUTE_PATHS = {
  landing: "/",
  box: "/box",
} as const;

export type RouteName = "landing" | "box" | "unknown";

/**
 * Normalise a pathname so route matching is not defeated by a trailing slash.
 * "/box/" and "/box" are the same route; "/" stays "/"; an empty value is "/".
 */
export function normalizePath(pathname: string): string {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "") || "/";
  return pathname;
}

/**
 * Which surface a pathname maps to.
 *
 * "unknown" is returned rather than guessed at: the caller redirects it to the public page.
 * Note that an unknown path is NOT treated as the protected route — a typo must never be
 * able to reach the workspace, and `isProtectedPath` is the function that decides that.
 */
export function resolveRoute(pathname: string): RouteName {
  const path = normalizePath(pathname);
  if (path === ROUTE_PATHS.box) return "box";
  if (path === ROUTE_PATHS.landing) return "landing";
  return "unknown";
}

/**
 * Whether this path requires a session.
 *
 * The authentication wrapper protects the workspace and NOTHING else. The public page must
 * stay public — it is the surface an anonymous visitor is meant to see.
 */
export function isProtectedPath(pathname: string): boolean {
  return resolveRoute(pathname) === "box";
}

/** Read one query parameter from a search string. Never throws. */
export function readQueryParam(search: string, key: string): string | null {
  try {
    return new URLSearchParams(search).get(key);
  } catch {
    return null;
  }
}

/**
 * Whether navigating to `to` from `current` would change anything.
 *
 * The redirect that bounces an unauthenticated visitor off /box runs inside an effect that
 * can re-run. Without this guard each re-run would push another history entry, and Back
 * would walk the user through a stack of identical URLs.
 */
export function isSameUrl(current: string, to: string): boolean {
  return current === to;
}

/** The URL an unauthenticated visitor is sent to: the public page with the dialog open. */
export const AUTH_REDIRECT_URL = `${ROUTE_PATHS.landing}?auth=1`;
