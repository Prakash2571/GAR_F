/**
 * FIX 3b — the in-memory CSRF token contract.
 *
 * The backend no longer accepts the readable CSRF cookie as a substitute for the
 * `x-csrf-token` HEADER on a protected mutation, and it derives that cookie's NAME from a
 * configurable `SESSION_COOKIE_NAME`. So the frontend must:
 *   • hold the CSRF token ONLY in process memory (never a cookie, never localStorage/etc.);
 *   • capture it from the body of `/api/access/verify` (login) and of an authenticated
 *     `/api/access/status` (post-reload recovery);
 *   • echo it as `x-csrf-token` on every mutating request, and NEVER on a GET;
 *   • throw locally rather than fire a headerless mutation when no token is held;
 *   • send `/api/access/verify` WITHOUT a CSRF header;
 *   • clear the token on 401 and on logout;
 *   • never leak the token into a URL or into localStorage/sessionStorage.
 *
 * These drive the REAL modules with a stubbed global `fetch`, following the conventions in
 * `apiUnauthorized.test.mjs` and `accessGate.test.mjs`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  request,
  getCsrfToken,
  setCsrfToken,
  clearCsrfToken,
  notifyUnauthorized,
  MissingCsrfTokenError,
} from "../src/api/http.ts";
import { verifyPasscode, accessStatus, logout } from "../src/api/access.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Install a fake global fetch that returns a chosen response, capturing every call. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, headers: init?.headers ?? {} });
    return handler(url, init);
  };
  return calls;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

/** A recording spy over localStorage AND sessionStorage that captures every setItem. */
function installStorageSpies() {
  const writes = [];
  const make = () => {
    const store = new Map();
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        writes.push({ k: String(k), v: String(v) });
        store.set(k, v);
      },
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  };
  globalThis.localStorage = make();
  globalThis.sessionStorage = make();
  return writes;
}

function reset() {
  clearCsrfToken();
  delete globalThis.document;
}

test("verify captures the returned csrf_token and a later mutation echoes it exactly", async () => {
  reset();
  const calls = stubFetch((url) => {
    if (String(url).includes("/api/access/verify")) {
      return jsonResponse(200, { authenticated: true, role: "full", csrf_token: "TOK-FROM-VERIFY" });
    }
    return jsonResponse(200, { ok: true });
  });

  await verifyPasscode("s3cret");
  assert.equal(getCsrfToken(), "TOK-FROM-VERIFY", "token captured from verify body");

  await request("/api/box/start", "Failed", { method: "POST" });
  const mutation = calls.find((c) => String(c.url).includes("/api/box/start"));
  assert.equal(
    mutation.headers["x-csrf-token"],
    "TOK-FROM-VERIFY",
    "the mutation echoes exactly the token verify returned",
  );
  reset();
});

test("post-reload recovery: an authenticated status seeds the token, then a mutation carries it", async () => {
  reset(); // fresh process, no verify happened
  assert.equal(getCsrfToken(), null, "process memory starts empty");
  const calls = stubFetch((url) => {
    if (String(url).includes("/api/access/status")) {
      return jsonResponse(200, { authenticated: true, role: "full", csrf_token: "TOK-FROM-STATUS" });
    }
    return jsonResponse(200, { ok: true });
  });

  const status = await accessStatus();
  assert.equal(status.authenticated, true);
  assert.equal(getCsrfToken(), "TOK-FROM-STATUS", "token seeded from status body");

  await request("/api/box/stop", "Failed", { method: "POST" });
  const mutation = calls.find((c) => String(c.url).includes("/api/box/stop"));
  assert.equal(mutation.headers["x-csrf-token"], "TOK-FROM-STATUS");
  reset();
});

test("an unauthenticated status does NOT seed a token", async () => {
  reset();
  stubFetch(() => jsonResponse(200, { authenticated: false }));
  const status = await accessStatus();
  assert.equal(status.authenticated, false);
  assert.equal(getCsrfToken(), null, "no token from an unauthenticated status");
  reset();
});

test("a GET carries NO x-csrf-token header even when a token is held", async () => {
  reset();
  setCsrfToken("TOK-HELD");
  const calls = stubFetch(() => jsonResponse(200, {}));
  await request("/api/box/status", "Failed");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].headers["x-csrf-token"], undefined, "no CSRF header on a read");
  reset();
});

test("a mutation with NO token held throws MissingCsrfTokenError and never hits the network", async () => {
  reset();
  let fetched = false;
  stubFetch(() => {
    fetched = true;
    return jsonResponse(200, {});
  });
  await assert.rejects(
    () => request("/api/box/start", "Failed to start the box scanner", { method: "POST" }),
    (err) => err instanceof MissingCsrfTokenError,
  );
  assert.equal(fetched, false, "no request is fired when no token is held");
  reset();
});

test("an empty token is treated as no token (never sends an empty header)", async () => {
  reset();
  setCsrfToken("");
  assert.equal(getCsrfToken(), null, "an empty token clears the store");
  let fetched = false;
  stubFetch(() => {
    fetched = true;
    return jsonResponse(200, {});
  });
  await assert.rejects(
    () => request("/api/box/start", "Failed", { method: "POST" }),
    (err) => err instanceof MissingCsrfTokenError,
  );
  assert.equal(fetched, false);
  reset();
});

test("verify is sent WITHOUT a CSRF header (it is the token-minting public mutation)", async () => {
  reset();
  setCsrfToken("STALE"); // even a stale token must not ride on verify
  const calls = stubFetch(() =>
    jsonResponse(200, { authenticated: true, role: "full", csrf_token: "FRESH" }),
  );
  await verifyPasscode("x");
  const verifyCall = calls.find((c) => String(c.url).includes("/api/access/verify"));
  assert.equal(verifyCall.init.method, "POST");
  assert.equal(verifyCall.headers["x-csrf-token"], undefined, "verify carries no CSRF header");
  assert.equal(getCsrfToken(), "FRESH", "verify replaced the token with the fresh one");
  reset();
});

/**
 * LOGOUT IS BEST-EFFORT CSRF, NOT CSRF-EXEMPT.
 *
 * The backend's logout route is deliberately asymmetric: with a LIVE session, revoking it is
 * a real state change and the route REQUIRES an allowed Origin plus a matching
 * `x-csrf-token` header; with no live session there is nothing left to protect, so it clears
 * the cookies and returns 200 without one.
 *
 * This test previously asserted that logout omits the header unconditionally, which locked in
 * a real defect: on the live path the backend answered 403 `csrf_failed`, the frontend caught
 * and logged it, the UI "logged out" locally — and the server-side session row stayed VALID
 * until it expired. The two tests below pin both halves of the route instead.
 */
test("logout CARRIES the CSRF header when a token is held, so the server session is revoked", async () => {
  reset();
  setCsrfToken("TOK-LIVE");
  const calls = stubFetch(() => jsonResponse(200, { authenticated: false }));
  await logout();
  const logoutCall = calls.find((c) => String(c.url).includes("/api/access/logout"));
  assert.equal(
    logoutCall.headers["x-csrf-token"],
    "TOK-LIVE",
    "a live session's logout must echo the CSRF token or the backend refuses to revoke it",
  );
  assert.equal(getCsrfToken(), null, "logout cleared the in-memory token");
  reset();
});

test("logout still SENDS with no token held, so a dead session can always be cleared", async () => {
  reset();
  // No token: the session is already expired/revoked, or the page was reloaded and the
  // in-memory token is gone. The request must still be made (and must not throw
  // MissingCsrfTokenError), or the browser could never clear its stale cookie.
  const calls = stubFetch(() => jsonResponse(200, { authenticated: false }));
  await logout();
  const logoutCall = calls.find((c) => String(c.url).includes("/api/access/logout"));
  assert.ok(logoutCall, "logout was sent even with no CSRF token held");
  assert.equal(
    logoutCall.headers["x-csrf-token"],
    undefined,
    "no empty header is sent when there is no token",
  );
  assert.equal(getCsrfToken(), null);
  reset();
});

test("an HTTP 401 clears the token: a following mutation must not reuse it", async () => {
  reset();
  setCsrfToken("TOK-BEFORE-401");
  stubFetch(() => jsonResponse(401, { error: "unauthorized" }));
  await assert.rejects(
    () => request("/api/box/start", "Failed", { method: "POST" }),
    /HTTP 401|expired/,
  );
  assert.equal(getCsrfToken(), null, "the 401 dropped the token");

  // A following mutation now has no token and must fail locally rather than reuse a stale one.
  await assert.rejects(
    () => request("/api/box/stop", "Failed", { method: "POST" }),
    (err) => err instanceof MissingCsrfTokenError,
  );
  reset();
});

test("notifyUnauthorized clears the token directly (shared with the SSE 401 path)", () => {
  reset();
  setCsrfToken("TOK");
  notifyUnauthorized();
  assert.equal(getCsrfToken(), null);
  reset();
});

test("failed authentication clears any previously-held token", async () => {
  reset();
  setCsrfToken("OLD");
  stubFetch(() => jsonResponse(401, { error: "Invalid passcode." }));
  await assert.rejects(() => verifyPasscode("wrong"), /Invalid passcode/);
  assert.equal(getCsrfToken(), null, "a rejected login drops the stale token");
  reset();
});

test("a custom backend SESSION_COOKIE_NAME is irrelevant: a mutation carries the header with document.cookie EMPTY", async () => {
  reset();
  // Simulate a deployment whose CSRF cookie name is unknown to the frontend — and empty.
  globalThis.document = { cookie: "" };
  const calls = stubFetch((url) => {
    if (String(url).includes("/api/access/verify")) {
      return jsonResponse(200, { authenticated: true, role: "full", csrf_token: "BODY-TOK" });
    }
    return jsonResponse(200, { ok: true });
  });
  await verifyPasscode("x");
  await request("/api/box/start", "Failed", { method: "POST" });
  const mutation = calls.find((c) => String(c.url).includes("/api/box/start"));
  assert.equal(
    mutation.headers["x-csrf-token"],
    "BODY-TOK",
    "the header comes from the body-delivered token, not any cookie",
  );
  reset();
});

test("the token never reaches localStorage/sessionStorage and never appears in a URL", async () => {
  reset();
  const writes = installStorageSpies();
  const SECRET = "SUPER-SECRET-CSRF-TOKEN";
  const calls = stubFetch((url) => {
    if (String(url).includes("/api/access/verify")) {
      return jsonResponse(200, { authenticated: true, role: "full", csrf_token: SECRET });
    }
    return jsonResponse(200, { ok: true });
  });

  await verifyPasscode("x");
  await request("/api/box/start", "Failed", { method: "POST" });
  await accessStatus?.().catch(() => {});

  const leakedToStorage = writes.some(
    (w) => w.k.includes(SECRET) || w.v.includes(SECRET),
  );
  assert.equal(leakedToStorage, false, "the CSRF token never reaches localStorage/sessionStorage");

  const leakedToUrl = calls.some((c) => String(c.url).includes(SECRET));
  assert.equal(leakedToUrl, false, "the CSRF token never appears in any request URL");

  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
  reset();
});

/* ----------------------------- source-level guards ---------------------------- */

test("http.ts contains no hardcoded csrf cookie name and never reads document.cookie", () => {
  const src = readFileSync(join(HERE, "..", "src", "api", "http.ts"), "utf8");
  assert.doesNotMatch(src, /strikedge_csrf/, "no hardcoded CSRF cookie name in http.ts");
  assert.doesNotMatch(src, /document\.cookie/, "http.ts never reads document.cookie");
});

test("access.ts never reads document.cookie for a token", () => {
  const src = readFileSync(join(HERE, "..", "src", "api", "access.ts"), "utf8");
  assert.doesNotMatch(src, /document\.cookie/, "access.ts never reads document.cookie");
});
