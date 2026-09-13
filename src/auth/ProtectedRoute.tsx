/**
 * Route guard for the protected workspace.
 *
 * THE ONE RULE: children are rendered ONLY in the `authenticated` state. Neither `checking`
 * nor `anonymous` renders any part of the workspace, so there is no window — not even one
 * frame — in which protected trading content is on screen before the backend has confirmed
 * the session. That also means the workspace's data effects (the Box SSE stream, broker
 * status, readiness polling, history) cannot run: they are mounted with the workspace, and it
 * is never mounted speculatively.
 *
 * WHY A REDIRECT RATHER THAN AN INLINE PASSCODE SCREEN
 * A direct visit to /box without a session sends the browser to `/?auth=1`, which renders the
 * public landing page and opens the passcode dialog on top of it. One passcode surface, one
 * place it can be wrong, and the URL always matches what is on screen. `replace: true` keeps
 * the failed /box attempt out of the history stack, so Back does not bounce the visitor
 * through the redirect again.
 *
 * THE 401 PATH runs through here too. A 401 anywhere flips the provider to `anonymous`, this
 * component stops rendering the workspace (unmounting it, which tears down its stream and
 * timers via its own effect cleanup) and then navigates back to the public page with the
 * dialog open. Teardown therefore happens as part of leaving the protected surface, not after.
 */

import { useEffect } from "react";
import { navigate } from "../app/router.ts";
import { AUTH_REDIRECT_URL } from "../lib/routing.ts";
import { useAccess } from "./AccessGate.tsx";

export interface ProtectedRouteProps {
  children: React.ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { state } = useAccess();

  useEffect(() => {
    if (state === "anonymous") navigate(AUTH_REDIRECT_URL, { replace: true });
  }, [state]);

  if (state === "authenticated") return <>{children}</>;

  // `checking` and `anonymous` share one neutral surface that asserts NOTHING about the
  // session or the trading system. It is not a passcode form and not a dashboard skeleton:
  // a skeleton of the workspace would imply the workspace is loading, which is exactly the
  // impression an unauthenticated visitor must not be given.
  return (
    <div className="gts-route-wait" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="gts-route-wait-text">
        {state === "checking" ? "Checking session…" : "Returning to GTS Algo Research…"}
      </span>
    </div>
  );
}
