/**
 * A REPLY IS NOT FINISHED WHEN ITS HEADERS ARRIVE.
 *
 * `tests/boundedRequests.test.mjs` proves that a request which never produces headers is bounded and is
 * classified as an unknown outcome. Every stall it exercises holds the `fetch` PROMISE pending, which is
 * why it could not see the defect these tests exist for: `fetch` resolves on headers, and the body is
 * read afterwards. The deadline used to be cleared at that moment, so
 *
 *   · a response that sent headers and then stalled its body was unbounded — the promise never
 *     settled, the single-flight slot was never released and the control stayed busy forever;
 *   · a body that truncated mid-flight was swallowed into a generic "unreadable reply" error, and a
 *     truncated 2xx therefore reached the operator as a clean failure even though the server had
 *     demonstrably accepted the mutation;
 *   · a 500/502/504 on a mutation was presented as an ordinary refusal, though none of those statuses
 *     proves the operation did not act.
 *
 * The rule being pinned: bound the WHOLE reply, and never present an unproven outcome as a proven one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  RequestTimeoutError,
  UnreadableResponseError,
  isUnknownOutcome,
  request,
  setCsrfToken,
} from "../src/api/http.ts";

function withFetch(handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => handler({ url: String(input), init });
  return {
    restore() {
      if (previous === undefined) delete globalThis.fetch;
      else globalThis.fetch = previous;
    },
  };
}

const abortError = () => {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
};

/**
 * A response whose HEADERS are complete and whose BODY never finishes.
 *
 * Built from a real `ReadableStream` that enqueues nothing and never closes, wired to the request's
 * signal so an abort rejects the in-flight read exactly as a real fetch body does. This is the shape no
 * previous test produced.
 */
function stalledBody({ status = 200, signal, headers = { "content-type": "application/json" } } = {}) {
  let cancel;
  const body = new ReadableStream({
    start(controller) {
      cancel = (reason) => {
        try {
          controller.error(reason);
        } catch {
          /* already errored */
        }
      };
      if (signal) {
        if (signal.aborted) cancel(abortError());
        else signal.addEventListener("abort", () => cancel(abortError()), { once: true });
      }
    },
  });
  return new Response(body, { status, headers });
}

/** A response whose body errors partway through: a connection dropped mid-reply. */
function truncatedBody({ status = 200, chunk = '{"ok":tr' } = {}) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
      controller.error(new Error("terminated"));
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/* ════════════ 1. the deadline must cover the body, not just the headers ════════════ */

test("a response that sends headers and STALLS ITS BODY is still bounded", async () => {
  const stub = withFetch(({ init }) => stalledBody({ signal: init.signal }));
  try {
    const started = Date.now();
    await assert.rejects(
      () => request("/api/box/status", "Failed to load the box status", { timeoutMs: 60 }),
      (err) => {
        assert.ok(
          err instanceof RequestTimeoutError,
          `a stalled BODY must time out like a stalled request, got ${err?.name}: ${err?.message}`,
        );
        assert.equal(err.timeoutMs, 60);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5_000, "it must not have waited on the socket");
  } finally {
    stub.restore();
  }
});

test("a MUTATION whose body stalls is an UNKNOWN outcome, not a failure", async () => {
  setCsrfToken("csrf-token");
  const stub = withFetch(({ init }) => stalledBody({ signal: init.signal }));
  try {
    await assert.rejects(
      () =>
        request("/api/box/flatten-all", "Failed to flatten all Box positions", {
          method: "POST",
          timeoutMs: 60,
        }),
      (err) => {
        assert.ok(isUnknownOutcome(err), "the server accepted the request; the outcome is unknown");
        assert.match(err.message, /OUTCOME IS UNKNOWN/);
        return true;
      },
    );
  } finally {
    stub.restore();
    setCsrfToken(null);
  }
});

test("the caller's own abort still cuts a stalled BODY, and is not relabelled", async () => {
  // The abort bridge used to be torn down when the headers arrived, so an unmounting component could
  // not cancel a body read at all. An AbortError must propagate untouched: a deliberate cancellation
  // is not a failure to show anyone.
  const stub = withFetch(({ init }) => stalledBody({ signal: init.signal }));
  const controller = new AbortController();
  try {
    const pending = request("/api/box/status", "Failed to load the box status", {
      signal: controller.signal,
      timeoutMs: 0,
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, (err) => {
      assert.equal(err.name, "AbortError");
      assert.ok(!(err instanceof RequestTimeoutError), "a caller abort is not a timeout");
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("a settled request leaves no timer armed once the BODY has been read", async () => {
  const stub = withFetch(
    () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await request("/api/box/status", "Failed to load the box status", { timeoutMs: 30_000 });
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.equal(after, before, "the deadline must be cleared after the body, not leaked");
  } finally {
    stub.restore();
  }
});

/* ════════════ 2. an interrupted body is an unproven outcome, not a clean error ════════════ */

test("a TRUNCATED 2xx on a mutation reports an unknown outcome", async () => {
  setCsrfToken("csrf-token");
  const stub = withFetch(() => truncatedBody({ status: 200 }));
  try {
    await assert.rejects(
      () =>
        request("/api/box/trades/abc/close", "Failed to close the Box position", { method: "POST" }),
      (err) => {
        assert.ok(
          err instanceof UnreadableResponseError,
          `expected an unreadable-reply error, got ${err?.name}`,
        );
        assert.equal(err.status, 200);
        assert.ok(
          isUnknownOutcome(err),
          "THE DEFECT: a truncated SUCCESS was presented as a clean failure, so the panel never " +
            "reconciled and the operator was invited to retry an operation that had already acted",
        );
        return true;
      },
    );
  } finally {
    stub.restore();
    setCsrfToken(null);
  }
});

test("a truncated body on a READ is an error but NOT an unknown outcome", async () => {
  // Nothing was mutated, so there is no ambiguity to warn about — only a failed read to retry.
  const stub = withFetch(() => truncatedBody({ status: 200 }));
  try {
    await assert.rejects(
      () => request("/api/box/status", "Failed to load the box status"),
      (err) => {
        assert.ok(err instanceof UnreadableResponseError);
        assert.equal(isUnknownOutcome(err), false);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test("a 2xx with an empty or non-JSON body is classified the same way", async () => {
  setCsrfToken("csrf-token");
  const stub = withFetch(() => new Response("<html>gateway</html>", { status: 200 }));
  try {
    await assert.rejects(
      () => request("/api/box/scanner/start", "Failed to start the scanner", { method: "POST" }),
      (err) => {
        assert.ok(err instanceof UnreadableResponseError);
        assert.ok(isUnknownOutcome(err));
        return true;
      },
    );
  } finally {
    stub.restore();
    setCsrfToken(null);
  }
});

/* ════════════ 3. which HTTP failures prove that nothing happened ════════════ */

test("a 504 on a mutation does NOT prove the operation was refused", async () => {
  setCsrfToken("csrf-token");
  const stub = withFetch(() => new Response("gateway timeout", { status: 504 }));
  try {
    await assert.rejects(
      () => request("/api/box/flatten-all", "Failed to flatten all Box positions", { method: "POST" }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 504);
        assert.ok(
          isUnknownOutcome(err),
          "a proxy's gateway timeout may have been produced after the app acted",
        );
        assert.match(err.message, /OUTCOME IS UNKNOWN/);
        return true;
      },
    );
  } finally {
    stub.restore();
    setCsrfToken(null);
  }
});

test("a 500 on a mutation is unproven; the SAME status on a read is not", async () => {
  setCsrfToken("csrf-token");
  const stub = withFetch(() =>
    new Response(JSON.stringify({ error: "Unexpected server error.", code: "internal_error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
  );
  try {
    await assert.rejects(
      () => request("/api/box/trades/abc", "Failed to delete the Box trade", { method: "DELETE" }),
      (err) => {
        assert.ok(isUnknownOutcome(err), "the handler was entered before it broke");
        return true;
      },
    );
    await assert.rejects(
      () => request("/api/box/trades", "Failed to load Box trades"),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(isUnknownOutcome(err), false, "a failed READ changes nothing by definition");
        return true;
      },
    );
  } finally {
    stub.restore();
    setCsrfToken(null);
  }
});

test("an application refusal still proves nothing happened", async () => {
  setCsrfToken("csrf-token");
  const stub = withFetch(() =>
    new Response(
      JSON.stringify({ blocked_reason: "The durable order-intent journal could not be read." }),
      { status: 409, headers: { "content-type": "application/json" } },
    ),
  );
  try {
    await assert.rejects(
      () => request("/api/box/orders/cancel", "Failed to cancel working Box orders", { method: "POST" }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(
          isUnknownOutcome(err),
          false,
          "a 4xx refusal IS proof the server declined before acting; warning about it would cry wolf",
        );
        assert.doesNotMatch(err.message, /OUTCOME IS UNKNOWN/);
        return true;
      },
    );
  } finally {
    stub.restore();
    setCsrfToken(null);
  }
});

test("a 5xx the access gate emits BEFORE any handler runs proves nothing happened", async () => {
  // Otherwise every mutation attempted during a database outage would raise an "outcome unknown"
  // alarm, when the middleware provably refused it before a broker could be reached.
  setCsrfToken("csrf-token");
  const stub = withFetch(() =>
    new Response(
      JSON.stringify({ error: "Authentication is temporarily unavailable.", code: "auth_unavailable" }),
      { status: 503, headers: { "content-type": "application/json" } },
    ),
  );
  try {
    await assert.rejects(
      () => request("/api/box/flatten-all", "Failed to flatten all Box positions", { method: "POST" }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(isUnknownOutcome(err), false);
        return true;
      },
    );
  } finally {
    stub.restore();
    setCsrfToken(null);
  }
});
