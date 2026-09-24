/**
 * EVERY REQUEST IS BOUNDED, AND A BOUND IS NOT A FAILURE.
 *
 * THE DEFECT
 *
 * There was no application-level timeout anywhere. `RequestOptions.signal` was forwarded to `fetch`, but
 * nothing in the app ever constructed an `AbortController`, so `request()` hung exactly as long as the
 * browser's socket did. A stalled request held whatever single-flight slot its caller had taken — and in
 * `BoxExecutionControl` the working-order cancellation and the emergency flatten shared one un-keyed
 * `"emergency"` slot, so one black-holed cancellation disabled the panic button for the life of the
 * mounted component.
 *
 * Separately, `ReconnectingBoxStream.handleError` set a `probing` latch that was only cleared when the
 * probe settled. A probe that never settled meant neither `.then` nor `.catch` ran: the latch stayed set,
 * `scheduleReconnect()` was never called, and every later `onerror` short-circuited on it. The stream
 * stayed closed forever — no reconnect, and no teardown to the access gate either.
 *
 * WHAT THESE TESTS ENFORCE
 *
 *   1. A deadline exists, differs for reads and mutations, and is overridable.
 *   2. A timeout is its OWN error class and is classified as an UNKNOWN OUTCOME — aborting closes this
 *      end of the socket and does not cancel the server operation.
 *   3. A transport failure is also unknown for a mutation, rather than an opaque "Failed to fetch".
 *   4. A local refusal and a server refusal are NOT unknown: nothing happened, provably.
 *   5. The structured refusal field wins over the generic HTTP sentence — a 409 sweep refusal carries
 *      `blocked_reason`, not `error`.
 *   6. Timers and listeners are cleaned up whatever happens.
 *   7. A caller's own abort is passed through untouched, not relabelled as a timeout.
 *   8. The SSE auth probe cannot wedge the reconnect latch.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  DEFAULT_MUTATION_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
  MissingCsrfTokenError,
  NetworkError,
  RequestTimeoutError,
  describeRequestFailure,
  isUnknownOutcome,
  refusalReason,
  request,
  setCsrfToken,
} from "../src/api/http.ts";
import { ReconnectingBoxStream } from "../src/lib/boxStream.ts";

/** Swap `globalThis.fetch`, restoring it afterwards. */
function withFetch(handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return handler({ url: String(input), init, calls });
  };
  return {
    calls,
    restore() {
      if (previous === undefined) delete globalThis.fetch;
      else globalThis.fetch = previous;
    },
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fetch that only settles when its signal aborts — what a black-holed request looks like.
 *
 * It rejects immediately for a signal that is ALREADY aborted, because that is what a real `fetch` does;
 * a fake that only listened for the event would hang forever on that input and the test would be
 * measuring the fake rather than the wrapper.
 */
const abortError = () => {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
};
const blackHole = ({ init }) =>
  new Promise((_resolve, reject) => {
    if (init.signal?.aborted) { reject(abortError()); return; }
    init.signal?.addEventListener("abort", () => reject(abortError()));
  });

/** Drain microtasks AND the macrotask queue, so a multi-step promise chain has completed. */
const settle = () => new Promise((r) => setImmediate(r));

/* ═══════════════════ 1. the deadlines exist and are distinguishable ═══════════════════ */

test("reads and mutations have different default deadlines, and a mutation's is longer", () => {
  assert.equal(typeof DEFAULT_READ_TIMEOUT_MS, "number");
  assert.equal(typeof DEFAULT_MUTATION_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_READ_TIMEOUT_MS > 0, "a read must be bounded");
  assert.ok(DEFAULT_MUTATION_TIMEOUT_MS > 0, "a mutation must be bounded");
  assert.ok(
    DEFAULT_MUTATION_TIMEOUT_MS > DEFAULT_READ_TIMEOUT_MS,
    "a cancellation sweep walks the durable journal and talks to the broker per order, so it may " +
      "legitimately take longer than a read",
  );
});

/* ═══════════════════ 2. a timeout is its own class, and is UNKNOWN ═══════════════════ */

test("a stalled GET times out with RequestTimeoutError and aborts the fetch", async (t) => {
  const stub = withFetch(blackHole);
  t.after(() => stub.restore());

  const error = await request("/api/box/status", "Failed to load the box status", { timeoutMs: 40 })
    .then(() => null, (e) => e);

  assert.ok(error instanceof RequestTimeoutError, `expected RequestTimeoutError, got ${error}`);
  assert.equal(error.timeoutMs, 40);
  assert.equal(error.mutating, false);
  assert.ok(
    stub.calls[0].init.signal instanceof AbortSignal,
    "the wrapper must pass a signal it controls, or it cannot abort anything",
  );
  assert.equal(stub.calls[0].init.signal.aborted, true, "and it must actually abort");
});

test("a stalled MUTATION times out and says the outcome is UNKNOWN, not that it failed", async (t) => {
  setCsrfToken("t");
  const stub = withFetch(blackHole);
  t.after(() => stub.restore());

  const error = await request("/api/box/live/flatten", "Failed to flatten attributed Box exposure", {
    method: "POST", timeoutMs: 40,
  }).then(() => null, (e) => e);

  assert.ok(error instanceof RequestTimeoutError);
  assert.equal(error.mutating, true);
  assert.match(
    error.message, /OUTCOME IS UNKNOWN/,
    "aborting closes THIS end of the socket; the server operation keeps running",
  );
  assert.match(
    error.message, /does not cancel the server operation/,
    "the operator must not read a timeout as 'it did not happen'",
  );
  assert.match(error.message, /Refresh to see the current state before retrying/);
});

test("a timeout and a transport failure are UNKNOWN; refusals are not", async (t) => {
  setCsrfToken("t");
  const stub = withFetch(blackHole);
  t.after(() => stub.restore());

  const timeout = await request("/api/x", "what", { method: "POST", timeoutMs: 30 })
    .then(() => null, (e) => e);
  assert.equal(isUnknownOutcome(timeout), true);
  assert.equal(isUnknownOutcome(new NetworkError("what", true, new TypeError("Failed to fetch"))), true);

  // Provably nothing happened: a local CSRF refusal and a server refusal.
  assert.equal(isUnknownOutcome(new MissingCsrfTokenError("what")), false);
  assert.equal(isUnknownOutcome(new ApiError("refused", 409, { blocked_reason: "no" })), false);
  assert.equal(isUnknownOutcome(new Error("something else")), false);
});

/* ═══════════════════ 3. transport failure is wrapped, not opaque ═══════════════════ */

test("a fetch rejection becomes NetworkError and names the ambiguity for a mutation", async (t) => {
  setCsrfToken("t");
  const stub = withFetch(() => { throw new TypeError("Failed to fetch"); });
  t.after(() => stub.restore());

  const error = await request("/api/box/live/cancel-working", "Failed to cancel working Box orders", {
    method: "POST",
  }).then(() => null, (e) => e);

  assert.ok(error instanceof NetworkError, `expected NetworkError, got ${error}`);
  assert.equal(error.mutating, true);
  assert.match(
    error.message, /OUTCOME IS UNKNOWN/,
    "`fetch` rejects identically for a refused connection and a connection dropped mid-response — the " +
      "latter may be AFTER the server acted, so 'Failed to fetch' must not be shown as 'nothing happened'",
  );
  assert.match(error.message, /Failed to fetch/, "the underlying cause is preserved");
});

test("a GET transport failure does not claim an unknown mutation outcome", async (t) => {
  const stub = withFetch(() => { throw new TypeError("Failed to fetch"); });
  t.after(() => stub.restore());
  const error = await request("/api/box/status", "Failed to load the box status")
    .then(() => null, (e) => e);
  assert.ok(error instanceof NetworkError);
  assert.equal(error.mutating, false);
  assert.doesNotMatch(error.message, /OUTCOME IS UNKNOWN/);
  assert.match(error.message, /Check the connection/);
});

/* ═══════════════════ 4. the structured refusal wins ═══════════════════ */

test("a 409 carrying blocked_reason surfaces that reason, not the generic HTTP sentence", async (t) => {
  setCsrfToken("t");
  const reason =
    "The durable order-intent journal could not be read, so the working orders to cancel cannot be " +
    "identified and NOTHING was attempted. Restore PostgreSQL, or cancel from the broker terminal.";
  const stub = withFetch(() => json({ attempted: false, ok: false, blocked_reason: reason }, 409));
  t.after(() => stub.restore());

  const error = await request("/api/box/live/cancel-working", "Failed to cancel working Box orders", {
    method: "POST",
  }).then(() => null, (e) => e);

  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 409);
  // The message itself is still the generic one, because `readJson` reads `body.error` — which this
  // response does not have. That is exactly how the real reason went missing.
  assert.match(error.message, /HTTP 409/);
  assert.equal(
    refusalReason(error), reason,
    "THE FIX: the structured field must be reachable, or the operator sees only '(HTTP 409)' while the " +
      "actionable reason sits unread on ApiError.body",
  );
  assert.equal(describeRequestFailure(error), reason, "and the display helper must prefer it");
});

test("refusalReason prefers blocked_reason over error, and returns null for non-ApiErrors", () => {
  assert.equal(
    refusalReason(new ApiError("generic", 409, { blocked_reason: "structured", error: "generic" })),
    "structured",
    "blocked_reason is more specific than error and must win",
  );
  assert.equal(refusalReason(new ApiError("generic", 500, { error: "server said" })), "server said");
  assert.equal(refusalReason(new ApiError("generic", 500, null)), null);
  assert.equal(refusalReason(new ApiError("generic", 500, "not an object")), null);
  assert.equal(refusalReason(new Error("plain")), null);
  assert.equal(refusalReason(new RequestTimeoutError("what", 100, true)), null);
});

test("describeRequestFailure falls back to the message, then to a generic sentence", () => {
  assert.equal(describeRequestFailure(new Error("boom")), "boom");
  assert.equal(describeRequestFailure(null), "The request failed.");
  assert.equal(describeRequestFailure({}), "The request failed.");
});

/* ═══════════════════ 5. cleanup ═══════════════════ */

test("a successful request leaves no pending deadline timer", async (t) => {
  const stub = withFetch(() => json({ ok: true }));
  t.after(() => stub.restore());

  // If the timer leaked, this would keep the event loop alive and abort a later request.
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await request("/api/box/status", "what", { timeoutMs: 5_000 });
  await new Promise((r) => setImmediate(r));
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(
    after <= before,
    `a settled request must clear its deadline timer (timeouts before=${before} after=${after}); a leak ` +
      "would accumulate one per request in a long-lived panel",
  );
});

test("timeoutMs 0 disables the deadline", async (t) => {
  let sawSignal;
  const stub = withFetch(({ init }) => {
    sawSignal = init.signal;
    return json({ ok: true });
  });
  t.after(() => stub.restore());
  await request("/api/box/status", "what", { timeoutMs: 0 });
  // A controller is still supplied (so a caller signal can be merged), but nothing will abort it.
  assert.equal(sawSignal.aborted, false);
});

/* ═══════════════════ 6. a caller's own abort is not a timeout ═══════════════════ */

test("a caller's abort propagates untouched rather than being relabelled a timeout", async (t) => {
  const stub = withFetch(blackHole);
  t.after(() => stub.restore());

  const controller = new AbortController();
  const pending = request("/api/box/status", "what", { signal: controller.signal, timeoutMs: 10_000 });
  controller.abort();
  const error = await pending.then(() => null, (e) => e);

  assert.equal(
    error instanceof RequestTimeoutError, false,
    "a deliberate cancellation — a component unmounting, say — is not a timeout and must not be reported " +
      "to the operator as one",
  );
  assert.equal(error instanceof NetworkError, false, "nor a transport failure");
  assert.equal(error.name, "AbortError");
});

test("a signal already aborted before the call aborts immediately", async (t) => {
  const stub = withFetch(blackHole);
  t.after(() => stub.restore());
  const controller = new AbortController();
  controller.abort();
  const error = await request("/api/box/status", "what", { signal: controller.signal })
    .then(() => null, (e) => e);
  assert.equal(error instanceof RequestTimeoutError, false);
});

/* ═══════════════════ 7. the SSE auth probe cannot wedge the reconnect ═══════════════════ */

/** A fake EventSource that lets a test fire `onerror`. */
function fakeSource() {
  const source = {
    listeners: new Map(),
    closed: false,
    onerror: null,
    onopen: null,
    addEventListener(type, listener) { source.listeners.set(type, listener); },
    close() { source.closed = true; },
  };
  return source;
}

test("a probe that NEVER settles does not wedge the reconnect latch", async () => {
  const timers = [];
  const created = [];
  let probeCalls = 0;

  const stream = new ReconnectingBoxStream({
    url: "https://x.test/stream",
    events: ["snapshot"],
    onEvent: () => {},
    onUnauthorized: () => { throw new Error("must not tear down on a slow probe"); },
    // The wedge: a promise that never settles.
    probeUnauthorized: () => { probeCalls += 1; return new Promise(() => {}); },
    // Deliberately distinct from baseDelayMs below, so the probe deadline and the reconnect backoff
    // cannot be confused for one another when the test inspects the scheduled timers.
    probeTimeoutMs: 777,
    baseDelayMs: 1_000,
    create: (url) => { const s = fakeSource(); created.push(s); return s; },
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimeoutFn: () => {},
  });

  stream.start();
  assert.equal(created.length, 1);
  created[0].onerror?.(new Error("socket died"));
  assert.equal(probeCalls, 1);

  // Only the PROBE DEADLINE is pending at this point; no reconnect has been scheduled, which is exactly
  // the state that used to be permanent.
  const probeTimer = timers.find((t) => t.ms === 777);
  assert.ok(probeTimer, `the probe must be raced against a deadline; timers: ${JSON.stringify(timers.map((t) => t.ms))}`);
  assert.equal(
    timers.filter((t) => t.ms === 1_000).length, 0,
    "no reconnect may be scheduled while the probe is still deciding — that is the state that used to be " +
      "permanent",
  );

  // Fire the deadline. This is what releases the latch.
  probeTimer.fn();
  await settle();

  const reconnect = timers.find((t) => t.ms === 1_000);
  assert.ok(
    reconnect,
    "THE FIX: after the probe deadline the stream must schedule a reconnect. Previously the `probing` " +
      "latch stayed set forever, so the stream neither reconnected nor tore down to the access gate — " +
      `it just stayed closed. timers: ${JSON.stringify(timers.map((t) => t.ms))}`,
  );
  stream.stop();
});

test("a TIMED-OUT probe is treated as transient, never as an expired session", async () => {
  const timers = [];
  let unauthorizedCalls = 0;
  const stream = new ReconnectingBoxStream({
    url: "https://x.test/stream",
    events: [],
    onEvent: () => {},
    onUnauthorized: () => { unauthorizedCalls += 1; },
    probeUnauthorized: () => new Promise(() => {}),
    probeTimeoutMs: 500,
    create: () => fakeSource(),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimeoutFn: () => {},
  });
  stream.start();
  stream.handleError();
  timers.find((t) => t.ms === 500).fn();
  await settle();

  assert.equal(
    unauthorizedCalls, 0,
    "a SLOW probe is weaker evidence than a FAILED one. Treating a timeout as 'session gone' would tear " +
      "a working session down to the login screen because one request was slow.",
  );
  stream.stop();
});

test("a probe that settles normally still works, and a true verdict still stops the stream", async () => {
  const timers = [];
  let unauthorizedCalls = 0;
  const stream = new ReconnectingBoxStream({
    url: "https://x.test/stream",
    events: [],
    onEvent: () => {},
    onUnauthorized: () => { unauthorizedCalls += 1; },
    probeUnauthorized: async () => true,
    probeTimeoutMs: 5_000,
    create: () => fakeSource(),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimeoutFn: () => {},
  });
  stream.start();
  stream.handleError();
  await settle();
  await settle();

  assert.equal(
    unauthorizedCalls, 1,
    "NON-VACUITY: a real 401 verdict must still stop the stream, or the previous test proves nothing",
  );
});
