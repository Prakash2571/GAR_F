/**
 * The access layer's data contract and its single hardest invariant.
 *
 * The frontend gate is UX; the backend is the boundary. What the FRONTEND must guarantee is:
 *   • an UNSET session reads as not-authenticated (the public page shows);
 *   • an INVALID passcode rejects, with a rejection that reveals NOTHING about the server;
 *   • a NON-401 failure is not disguised as a wrong passcode;
 *   • a VALID passcode reports authenticated (the protected workspace may mount);
 *   • logout revokes SERVER-SIDE when it can, and still always ends the session locally;
 *   • and, non-negotiably, NONE of these paths writes a session token to localStorage — the
 *     session lives only in the HttpOnly cookie the backend sets.
 *
 * The provider and the passcode dialog are React components that need a DOM to render, so
 * these tests exercise the access API they are built on and assert the localStorage invariant
 * directly with a spy. The passcode is only ever sent in the request body, never persisted.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  verifyPasscode,
  accessStatus,
  logout,
  PasscodeRejectedError,
} from "../src/api/access.ts";

/** Spy on localStorage so we can prove NOTHING is ever written during an access flow. */
function installLocalStorageSpy() {
  const writes = [];
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      writes.push({ k, v });
      store.set(k, v);
    },
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  return writes;
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body });
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

test("UNSET session: accessStatus reports not authenticated, writes no localStorage", async () => {
  const writes = installLocalStorageSpy();
  stubFetch(() => jsonResponse(200, { authenticated: false }));
  const status = await accessStatus();
  assert.equal(status.authenticated, false);
  assert.equal(writes.length, 0, "no token written to localStorage");
});

test("INVALID passcode: verify rejects with PasscodeRejectedError, no localStorage write", async () => {
  const writes = installLocalStorageSpy();
  stubFetch(() => jsonResponse(401, { error: "Invalid passcode." }));
  await assert.rejects(
    () => verifyPasscode("wrong"),
    (err) => {
      // A DISTINCT error type, so the UI can render one fixed, uninformative string for a
      // rejected passcode without pattern-matching the backend's prose.
      assert.ok(err instanceof PasscodeRejectedError, "a 401 is a passcode rejection");
      assert.equal(err.message, "Invalid passcode");
      return true;
    },
  );
  assert.equal(writes.length, 0, "a rejected passcode never persists anything");
});

test("INVALID passcode: the rejection carries NOTHING about the server or the secret", async () => {
  installLocalStorageSpy();
  // Even if a future backend leaked detail in the body, a 401 collapses to the fixed string:
  // the UI must never be able to tell "wrong passcode" from "no secret configured", and must
  // never surface an attempt count, a database hint or any server internal.
  stubFetch(() =>
    jsonResponse(401, { error: "SITE_ACCESS_SECRET is unset; attempt 4 of 10 from 10.0.0.1" }),
  );
  await assert.rejects(
    () => verifyPasscode("wrong"),
    (err) => {
      assert.equal(err.message, "Invalid passcode");
      assert.doesNotMatch(err.message, /SECRET|attempt|10\.0\.0\.1/i);
      return true;
    },
  );
});

test("a NON-401 verify failure is NOT disguised as a wrong passcode", async () => {
  installLocalStorageSpy();
  // Rate limiting and "access temporarily unavailable" are operational problems. Reporting
  // them as "Invalid passcode" would send the operator hunting for a typo that does not
  // exist, so they keep the backend's own (already generic) message.
  stubFetch(() =>
    jsonResponse(429, { error: "Too many attempts. Please wait a few minutes and try again." }),
  );
  await assert.rejects(
    () => verifyPasscode("x"),
    (err) => {
      assert.ok(!(err instanceof PasscodeRejectedError), "429 is not a passcode rejection");
      assert.match(err.message, /Too many attempts/);
      return true;
    },
  );
});

test("VALID passcode: verify reports authenticated, and STILL writes no localStorage", async () => {
  const writes = installLocalStorageSpy();
  const calls = stubFetch(() => jsonResponse(200, { authenticated: true }));
  const result = await verifyPasscode("s3cret");
  assert.equal(result.authenticated, true);
  // The session is the HttpOnly cookie the backend set — the client stores nothing.
  assert.equal(writes.length, 0, "a successful login writes NO session token to localStorage");
  // The passcode travels only in the request body, never anywhere else.
  assert.equal(calls[0].body, JSON.stringify({ passcode: "s3cret" }));
});

test("the passcode is never written to localStorage under any key", async () => {
  const writes = installLocalStorageSpy();
  stubFetch(() => jsonResponse(200, { authenticated: true }));
  await verifyPasscode("top-secret-passcode");
  const leaked = writes.some(
    (w) => String(w.v).includes("top-secret-passcode") || String(w.k).includes("passcode"),
  );
  assert.equal(leaked, false, "the passcode must never reach localStorage");
});

test("logout never rejects, even on a server error, and writes no localStorage", async () => {
  const writes = installLocalStorageSpy();
  stubFetch(() => jsonResponse(500, { error: "boom" }));
  await logout(); // must resolve, so the gate always closes locally
  assert.equal(writes.length, 0);
});

test("verify sends credentials:include so the cookie can be set", async () => {
  installLocalStorageSpy();
  const calls = stubFetch(() => jsonResponse(200, { authenticated: true }));
  await verifyPasscode("x");
  assert.equal(calls[0].init.credentials, "include");
});
