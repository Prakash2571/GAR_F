/**
 * The protected GTS Box workspace route.
 *
 * A thin seam between routing/session concerns and the (deliberately untouched) trading
 * dashboard. It exists so `Box.tsx` keeps knowing nothing about routing: it is handed one
 * callback, `onLock`, and does not care that "lock" now also means "navigate to /".
 *
 * TEARDOWN ORDER. `lock()` revokes the server session and flips the provider to `anonymous`.
 * That unmounts this route's subtree — the dashboard's effect cleanups close the SSE stream
 * and clear every interval — and `<ProtectedRoute>` then navigates to the public page. So the
 * stream is torn down as part of leaving the protected surface, never left running behind a
 * public page. The same sequence runs unprompted when a 401 expires the session.
 */

import { useCallback } from "react";
import Box from "../Box.tsx";
import { useAccess } from "../auth/AccessGate.tsx";
import { navigate } from "../app/router.ts";
import { ROUTE_PATHS } from "../lib/routing.ts";

export default function BoxPage() {
  const { lock } = useAccess();

  const onLock = useCallback(() => {
    void lock().finally(() => {
      // Explicit navigation as well as the provider state change: `<ProtectedRoute>` would
      // redirect anyway, but going straight to the canonical public URL avoids a transient
      // "returning…" frame on a deliberate, user-initiated lock.
      navigate(ROUTE_PATHS.landing, { replace: true });
    });
  }, [lock]);

  return <Box onLock={onLock} />;
}
