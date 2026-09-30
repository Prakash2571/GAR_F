/**
 * The synthetic workspace's own session, over the one transport.
 *
 *   • synth mutations carry the SYNTH CSRF token (from verify / status), never the site token;
 *   • a synth 401 ends only the synth session: the site's unauthorized handler never fires;
 *   • verify is the only public synth mutation and a wrong passcode is not a session expiry;
 *   • a broker-login result in the URL is announced once and stripped.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { onUnauthorized, setCsrfToken, clearCsrfToken } from "../src/api/http.ts";
import {
  SynthPasscodeRejectedError,
  hasSynthCsrfToken,
  onSynthUnauthorized,
  startSynth,
  synthAccessStatus,
  synthVerify,
  fetchSynthStatus,
} from "../src/api/synth.ts";
import { parseBrokerLoginResult } from "../src/lib/synthView.ts";
import { SynthStream } from "../src/lib/synthStream.ts";

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

test("verify seeds the synth CSRF token and mutations send it, not the site token", async () => {
  setCsrfToken("SITE-TOKEN");
  const calls = stubFetch((url) =>
    String(url).endsWith("/access/verify")
      ? json(200, { authenticated: true, csrf_token: "SYNTH-TOKEN" })
      : json(200, { ok: true, status: { running: true } }),
  );
  await synthVerify("passcode");
  assert.equal(hasSynthCsrfToken(), true);
  assert.equal(calls[0].init.headers["x-csrf-token"], undefined, "verify carries no CSRF header");
  assert.equal(calls[0].init.credentials, "include");
  await startSynth();
  assert.equal(calls[1].url, "/api/synth/start");
  assert.equal(calls[1].init.headers["x-csrf-token"], "SYNTH-TOKEN", "the synth token, never the site token");
  clearCsrfToken();
});

test("Synth session roles and health fields preserve the server decision", async () => {
  const health = { service: "gts-synth", live: true, ready: true, state: "degraded", recovery_complete: true, storage_ready: true, entry_permitted: false, entry_block: "live_unresolved" };
  stubFetch((url) => String(url).endsWith("/access/status")
    ? json(200, { authenticated: true, role: "read", csrf_token: "READ-CSRF" })
    : json(200, health));
  assert.equal((await synthAccessStatus()).role, "read");
  assert.deepEqual(await fetchSynthStatus(), health);
});

test("a forbidden read-role control keeps the Synth session and CSRF token", async () => {
  let ended = 0;
  const off = onSynthUnauthorized(() => ended++);
  stubFetch((url) => String(url).endsWith("/access/status")
    ? json(200, { authenticated: true, role: "read", csrf_token: "READ-CSRF" })
    : json(403, { code: "forbidden", error: "Full access required for Synth controls." }));
  await synthAccessStatus();
  await assert.rejects(startSynth, (err) => err.status === 403);
  assert.equal(ended, 0);
  assert.equal(hasSynthCsrfToken(), true);
  off();
});

test("a wrong passcode is a rejection, not a session expiry", async () => {
  stubFetch(() => json(401, { error: "Invalid passcode.", code: "invalid_passcode" }));
  let siteFired = 0;
  const off = onUnauthorized(() => siteFired++);
  await assert.rejects(() => synthVerify("nope"), SynthPasscodeRejectedError);
  assert.equal(siteFired, 0);
  off();
});

test("a synth 401 ends the synth session only", async () => {
  stubFetch((url) =>
    String(url).endsWith("/access/status")
      ? json(200, { authenticated: true, csrf_token: "T" })
      : json(401, { error: "Authentication required.", code: "unauthenticated" }),
  );
  await synthAccessStatus();
  let siteFired = 0;
  let synthFired = 0;
  const offSite = onUnauthorized(() => siteFired++);
  const offSynth = onSynthUnauthorized(() => synthFired++);
  await assert.rejects(() => startSynth());
  assert.equal(synthFired, 1, "the synth gate is told");
  assert.equal(siteFired, 0, "the rest of the app is not logged out");
  assert.equal(hasSynthCsrfToken(), false, "the synth token is dropped");
  offSite();
  offSynth();
});

test("a broker-login result is announced once and stripped from the URL", () => {
  const ok = parseBrokerLoginResult("?broker_login=zerodha&status=connected&x=1");
  assert.equal(ok.result.ok, true);
  assert.equal(ok.cleaned, "?x=1");
  const bad = parseBrokerLoginResult("?broker_login=dhan&status=failed&reason=no_pending_login");
  assert.equal(bad.result.ok, false);
  assert.match(bad.result.message, /no login was started/);
  assert.equal(bad.cleaned, "");
  assert.equal(parseBrokerLoginResult("?x=1").result, null);
});

function fakeTimers() {
  const pending = [];
  return {
    setTimeoutFn: (fn, ms) => pending.push({ fn, ms }) - 1,
    clearTimeoutFn: () => {},
    pending,
  };
}

function fakeSources() {
  const made = [];
  return {
    made,
    create: (url) => {
      const listeners = {};
      const es = {
        url,
        closed: false,
        onopen: null,
        onerror: null,
        addEventListener: (t, fn) => (listeners[t] = fn),
        emit: (t, data) => listeners[t]?.({ data }),
        close() {
          this.closed = true;
        },
      };
      made.push(es);
      return es;
    },
  };
}

test("the stream reconnects after a transient drop but stops for a dead session", async () => {
  const t = fakeTimers();
  const src = fakeSources();
  let ended = 0;
  let alive = true;
  const events = [];
  const s = new SynthStream({
    url: "/api/synth/stream",
    events: ["snapshot", "session_ended"],
    onEvent: (type, data) => events.push([type, data]),
    onSessionEnded: () => ended++,
    probeSessionEnded: async () => !alive,
    create: src.create,
    ...t,
  });
  s.start();
  src.made[0].emit("snapshot", "{}");
  assert.deepEqual(events, [["snapshot", "{}"]]);
  src.made[0].onerror();
  await new Promise((r) => setImmediate(r));
  const reconnect = t.pending.find((p) => p.ms === 1000);
  assert.ok(reconnect, "a transient drop schedules a reconnect with backoff");
  reconnect.fn();
  assert.equal(src.made.length, 2);
  alive = false;
  src.made[1].onerror();
  await new Promise((r) => setImmediate(r));
  assert.equal(ended, 1, "a dead session stops the stream instead of reconnecting");
  src.made[1].emit("session_ended", "{}");
  assert.equal(ended, 1, "a stopped stream ignores late frames it no longer listens to");
});
