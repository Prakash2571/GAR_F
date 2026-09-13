/**
 * GTS Algo Research application root.
 *
 * Two routes: a PUBLIC landing page at `/` and the PROTECTED GTS Box workspace at `/box`.
 *
 *   <AccessProvider>   owns session state; probes GET /api/access/status once at start and
 *                      clears authenticated state on any 401 from anywhere in the app.
 *     <Routes>         picks the surface from the URL.
 *       /              LandingPage — public. Enter Box → passcode dialog → /box.
 *       /box           <ProtectedRoute> → the Box workspace, mounted only with a
 *                      backend-confirmed session.
 *
 * The provider sits ABOVE the router because session state outlives any single route: it is
 * read by the landing page (to skip the passcode when a session already exists), by the
 * passcode dialog, and by the route guard.
 */

import { AccessProvider } from "../auth/AccessGate.tsx";
import Routes from "./routes.tsx";

export default function App() {
  return (
    <AccessProvider>
      <Routes />
    </AccessProvider>
  );
}
