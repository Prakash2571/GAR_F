/**
 * The route table.
 *
 *   /      LandingPage    public
 *   /box   BoxPage        protected by <ProtectedRoute>
 *   /synth SyntheticPage  protected by <ProtectedRoute>
 *   *      → /            unknown paths redirect to the public page
 *
 * The authentication wrapper is applied to the two workspaces ONLY. The landing page must stay public: it is
 * the surface an anonymous visitor is supposed to see, and putting a gate in front of it would
 * both break the product and make the passcode prompt the first thing the world saw of the
 * project.
 *
 * Unknown paths REDIRECT rather than rendering a 404 page: there are two real routes and
 * nothing worth telling a visitor about a mistyped third.
 *
 * The path→surface decision itself is `resolveRoute` in lib/routing.ts, which is unit-tested.
 */

import { useEffect } from "react";
import { navigate, useLocation } from "./router.ts";
import { ROUTE_PATHS, resolveRoute } from "../lib/routing.ts";
import LandingPage from "../pages/LandingPage.tsx";
import BoxPage from "../pages/BoxPage.tsx";
import SyntheticPage from "../pages/SyntheticPage.tsx";
import ProtectedRoute from "../auth/ProtectedRoute.tsx";

export default function Routes() {
  const { pathname } = useLocation();
  const route = resolveRoute(pathname);

  // An unknown path is corrected in an effect, not during render: navigating while rendering
  // mutates history as a side effect of a render pass, which React may run more than once.
  const unknown = route === "unknown";
  useEffect(() => {
    if (unknown) navigate(ROUTE_PATHS.landing, { replace: true });
  }, [unknown]);

  if (route === "box") {
    return (
      <ProtectedRoute>
        <BoxPage />
      </ProtectedRoute>
    );
  }

  if (route === "synth") {
    return (
      <ProtectedRoute>
        <SyntheticPage />
      </ProtectedRoute>
    );
  }

  // The landing page is also what an unknown path shows for the one frame before the redirect
  // effect runs — correct, since that is where the redirect is going.
  return <LandingPage />;
}
