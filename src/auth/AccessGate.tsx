/**
 * The site-passcode session layer for GTS Algo Research.
 *
 * WHAT IT IS — AND IS NOT
 * -----------------------
 * This is session STATE and UX, not a security boundary. The real boundary is the backend,
 * which answers 401 for every `/api/box/*` request without a valid session cookie. This
 * provider only decides which surface the browser is allowed to MOUNT:
 *   • anonymous     → the public landing page; the protected workspace is never mounted, so
 *                     no Box SSE, broker, portfolio or history request is ever issued.
 *   • authenticated → `<ProtectedRoute>` mounts the Box workspace.
 *   • checking      → neither; a neutral loading surface, so protected content cannot flash
 *                     on screen before the backend has confirmed the session.
 *
 * NON-NEGOTIABLES (unchanged from the proven implementation this refactor grew out of)
 *   • The session lives in an HttpOnly cookie the backend sets on a correct passcode. This
 *     module NEVER reads or writes a session token in localStorage, sessionStorage or any
 *     other client store. It holds one enum in React state and nothing else.
 *   • The passcode itself is never persisted anywhere. It exists as a React input value for
 *     the duration of one submit and is cleared the instant it is no longer needed.
 *   • On any 401 anywhere in the app (surfaced via `onUnauthorized` from the http wrapper)
 *     authenticated state is cleared. That UNMOUNTS the workspace, whose own cleanup tears
 *     down the SSE stream and every timer, and `<ProtectedRoute>` then returns the browser
 *     to the public landing page.
 *
 * WHY A PROVIDER RATHER THAN A WRAPPER COMPONENT
 * Session state is now read in three places that are not in a parent/child relationship —
 * the landing header ("Enter Box" must skip the passcode when a session already exists),
 * the passcode modal, and the protected route — so it lives in context instead of being
 * threaded through render props.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { accessStatus, logout, verifyPasscode } from "../api/access.ts";
import { clearCsrfToken, onUnauthorized } from "../api/http.ts";

/**
 * "checking" is a REAL state, not a cosmetic one: until the backend has answered
 * `/api/access/status` we do not know whether this browser holds a session, and rendering
 * either the protected workspace or a passcode prompt would be a guess. Protected content
 * must never appear during it.
 */
export type AccessState = "checking" | "anonymous" | "authenticated";

export interface AccessContextValue {
  state: AccessState;
  /** Convenience for `state === "authenticated"`. */
  authenticated: boolean;
  /**
   * Verify a passcode against the backend.
   *
   * Resolves `true` when a session was established. Resolves `false` — it does NOT throw —
   * when the passcode was simply not accepted, because that is an expected outcome the UI
   * renders as one generic message rather than an error condition. It rejects only on a
   * genuine transport/server failure.
   */
  verify: (passcode: string) => Promise<boolean>;
  /** Revoke the session server-side and drop authenticated state locally. */
  lock: () => Promise<void>;
  /** Re-ask the backend whether a session exists. Used after a manual reload path. */
  refresh: () => Promise<void>;
}

const AccessContext = createContext<AccessContextValue | null>(null);

export function AccessProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AccessState>("checking");

  // On mount, ask the backend whether the current cookie is already a valid session, so a
  // returning user with a live session is never asked for the passcode again. This also
  // re-seeds the in-memory CSRF token after a page reload (see api/access.ts).
  const refresh = useCallback(async () => {
    try {
      const status = await accessStatus();
      setState(status.authenticated ? "authenticated" : "anonymous");
    } catch {
      // Any failure — including a 401 — means: treat this browser as anonymous. Failing
      // closed is the only safe direction for an access decision.
      setState("anonymous");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await accessStatus();
        if (!cancelled) setState(status.authenticated ? "authenticated" : "anonymous");
      } catch {
        if (!cancelled) setState("anonymous");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * A 401 ANYWHERE clears authenticated state.
   *
   * That is what stops protected activity: dropping to "anonymous" unmounts the workspace,
   * and the workspace's own effect cleanup closes the SSE stream and clears its timers.
   * `notifyUnauthorized` has already dropped the in-memory CSRF token; clearing it again
   * here is a cheap belt-and-braces so a reset session never holds a stale token.
   */
  useEffect(
    () =>
      onUnauthorized(() => {
        clearCsrfToken();
        setState("anonymous");
      }),
    [],
  );

  const verify = useCallback(async (passcode: string): Promise<boolean> => {
    const result = await verifyPasscode(passcode);
    if (result.authenticated) {
      setState("authenticated");
      return true;
    }
    return false;
  }, []);

  const lock = useCallback(async (): Promise<void> => {
    // `logout()` never rejects: it revokes the server session, clears the cookies and the
    // in-memory CSRF token, and logs rather than surfaces a network failure — pressing Lock
    // must always end the local session even if the request could not be delivered.
    await logout();
    setState("anonymous");
  }, []);

  const value = useMemo<AccessContextValue>(
    () => ({
      state,
      authenticated: state === "authenticated",
      verify,
      lock,
      refresh,
    }),
    [state, verify, lock, refresh],
  );

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

/** Read the session state. Throws if used outside the provider — a wiring bug, not a runtime case. */
export function useAccess(): AccessContextValue {
  const ctx = useContext(AccessContext);
  if (ctx === null) {
    throw new Error("useAccess must be used inside <AccessProvider>.");
  }
  return ctx;
}
