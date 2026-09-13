/**
 * GTS Box application root.
 *
 * There is exactly ONE route — `/` — the Box dashboard. There is no router, no calendar
 * board, no admin page. The whole app is gated by the site passcode:
 *
 *   AccessGate (locked) → the minimal passcode screen, and nothing else.
 *   AccessGate (unlocked) → the Box dashboard mounts.
 *
 * A 401 anywhere returns to the gate (wired inside AccessGate + the dashboard's own SSE
 * teardown), so no session state has to live here.
 */

import AccessGate from "./auth/AccessGate.tsx";
import Box from "./Box.tsx";

export default function App() {
  return <AccessGate>{({ onLock }) => <Box onLock={onLock} />}</AccessGate>;
}
