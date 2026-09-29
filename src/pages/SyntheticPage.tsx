/**
 * /synth: the synthetic-futures arbitrage workspace. Protected by <ProtectedRoute> exactly
 * like /box; its API is the gts-synth Go service behind the same session.
 */

import { useCallback } from "react";
import Synthetic from "../components/synth/Synthetic.tsx";
import { useAccess } from "../auth/AccessGate.tsx";
import { navigate } from "../app/router.ts";
import { ROUTE_PATHS } from "../lib/routing.ts";

export default function SyntheticPage() {
  const { lock } = useAccess();
  const onLock = useCallback(() => {
    void lock().finally(() => navigate(ROUTE_PATHS.landing, { replace: true }));
  }, [lock]);
  return <Synthetic onLock={onLock} />;
}
