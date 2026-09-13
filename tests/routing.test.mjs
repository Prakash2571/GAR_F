/**
 * ROUTING: the public page is public, and only /box is protected.
 *
 * This is the security-relevant half of the routing change, so it is pinned directly rather
 * than left to a rendering test. The route decisions live in `src/lib/routing.ts` precisely so
 * they can be exercised here with no DOM and no bundler:
 *
 *   • "/" resolves to the LANDING surface and is NOT protected;
 *   • "/box" resolves to the workspace and IS protected;
 *   • a typo, a nested path, a case variant or a lookalike ("/Box", "/box2", "/box/x") is
 *     UNKNOWN and is NOT protected — which matters because `isProtectedPath` is what decides
 *     whether the auth guard runs, so anything it wrongly called protected-or-not would
 *     either lock the public page or expose the workspace;
 *   • a trailing slash does not change the route ("/box/" is still the workspace, and must not
 *     be bounced to the public page);
 *   • the redirect URL an unauthenticated visitor is sent to carries the flag that opens the
 *     passcode dialog.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ROUTE_PATHS,
  AUTH_REDIRECT_URL,
  normalizePath,
  resolveRoute,
  isProtectedPath,
  readQueryParam,
  isSameUrl,
} from "../src/lib/routing.ts";

test("the canonical paths are the two documented routes", () => {
  assert.equal(ROUTE_PATHS.landing, "/");
  assert.equal(ROUTE_PATHS.box, "/box");
});

test('"/" is the public landing route and is NOT protected', () => {
  assert.equal(resolveRoute("/"), "landing");
  assert.equal(
    isProtectedPath("/"),
    false,
    "the landing page must stay public — the gate protects the workspace only",
  );
});

test('"/box" is the workspace route and IS protected', () => {
  assert.equal(resolveRoute("/box"), "box");
  assert.equal(isProtectedPath("/box"), true);
});

test("a trailing slash does not change the route", () => {
  assert.equal(normalizePath("/box/"), "/box");
  assert.equal(normalizePath("/box//"), "/box");
  assert.equal(resolveRoute("/box/"), "box");
  assert.equal(isProtectedPath("/box/"), true, '"/box/" must not be bounced to the public page');
  // The root is the one path allowed to end in a slash.
  assert.equal(normalizePath("/"), "/");
  assert.equal(resolveRoute("/"), "landing");
});

test("an empty pathname resolves to the public page rather than to nothing", () => {
  assert.equal(normalizePath(""), "/");
  assert.equal(resolveRoute(""), "landing");
});

test("a lookalike path is UNKNOWN and is NOT protected", () => {
  // None of these may resolve to the workspace. `isProtectedPath` gating on an exact match
  // is what makes that true.
  for (const path of ["/box2", "/boxes", "/box/extra", "/Box", "/BOX", "/api/box", "/box.html"]) {
    assert.equal(resolveRoute(path), "unknown", `${path} must not resolve to a real route`);
    assert.equal(isProtectedPath(path), false, `${path} must not be treated as the workspace`);
  }
});

test("the unauthenticated redirect lands on the public page WITH the dialog flag", () => {
  assert.equal(AUTH_REDIRECT_URL, "/?auth=1");
  const [path, search] = AUTH_REDIRECT_URL.split("?");
  assert.equal(resolveRoute(path), "landing", "the redirect target is the PUBLIC page");
  assert.equal(readQueryParam(`?${search}`, "auth"), "1");
});

test("readQueryParam returns null for an absent key and never throws on junk", () => {
  assert.equal(readQueryParam("", "auth"), null);
  assert.equal(readQueryParam("?other=1", "auth"), null);
  assert.equal(readQueryParam("?auth=1&x=2", "auth"), "1");
  // An empty value is still PRESENT: "/?auth" must open the dialog, so the caller checks for
  // `!== null` rather than for truthiness.
  assert.equal(readQueryParam("?auth", "auth"), "");
  assert.equal(readQueryParam("?%%%broken", "auth"), null);
});

test("navigating to the URL already displayed is a no-op", () => {
  // The guard behind this is what stops a redirect effect that re-runs from pushing the same
  // entry repeatedly and trapping the user behind a stack of identical URLs.
  assert.equal(isSameUrl("/?auth=1", "/?auth=1"), true);
  assert.equal(isSameUrl("/", "/?auth=1"), false);
  assert.equal(isSameUrl("/box", "/"), false);
});
