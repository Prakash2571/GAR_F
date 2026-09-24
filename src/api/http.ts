/**
 * The one HTTP transport for the whole GTS Algo Research frontend.
 *
 * NO CLIENT-SIDE CREDENTIAL STORE
 * -------------------------------
 * An earlier generation of this transport read and wrote a bearer token in `localStorage`
 * and appended it to the SSE query string. The session is now an HttpOnly cookie the
 * browser attaches automatically, so NONE of that exists here. There is no token to read,
 * store, log or leak — the wrapper simply sends `credentials: "include"` on every request
 * and lets the same-origin cookie do its job. That property is enforced by CI, which scans
 * the built bundle and fails on any localStorage key outside a two-entry UI-preference
 * allow-list.
 *
 * THE FOUR THINGS THIS WRAPPER GUARANTEES
 *   1. Same-origin credentials: the session cookie rides on every call, incl. the SSE.
 *   2. Honest JSON errors: a proxy's HTML 502 no longer surfaces as a JSON parse error.
 *   3. A CSRF token header on every MUTATING request (POST/PUT/PATCH/DELETE). The token is
 *      held ONLY in this module's process memory — it is delivered in the JSON body of
 *      `POST /api/access/verify` (login) and of an authenticated `GET /api/access/status`
 *      (post-reload session recovery), captured via `setCsrfToken`, and echoed back in the
 *      `x-csrf-token` header. It is NEVER read from a cookie, and NEVER written to
 *      localStorage, sessionStorage, IndexedDB, a URL, a query string or a log. The backend
 *      derives its readable CSRF cookie name from a configurable `SESSION_COOKIE_NAME`, so
 *      reading a hardcoded cookie name here was fragile; the in-memory token is immune to
 *      that and to a custom cookie name entirely.
 *   4. A single 401 handler: any 401 notifies every subscriber exactly once so the app can
 *      tear down the SSE, drop authenticated state, clear the in-memory CSRF token and
 *      return to the gate — from one place, rather than each caller re-implementing
 *      session-expiry handling.
 */

// The CSRF request-header name is single-sourced from the vendored backend contract: it is
// generated into ./contract.generated.ts from contract/protocol.json by `npm run contract:types`.
// Importing it (rather than hardcoding the header name here) makes a backend rename propagate
// mechanically and fail CI if the frontend has not re-vendored. See the CSRF_HEADER doc below.
import { CSRF_HEADER } from "./contract.generated.ts";

/**
 * Resolve the API origin from an optional configured value.
 *
 * THE SAME-ORIGIN DEFAULT
 * -----------------------
 * When NO `VITE_API_BASE_URL` is configured (the normal production case) this returns the
 * empty string, so `apiUrl("/api/box/status")` produces the RELATIVE path
 * `/api/box/status`. Production serves the SPA and the API on the SAME ORIGIN behind nginx,
 * so a relative path is correct: the browser resolves it against the page's own origin and
 * the HttpOnly session cookie rides along. This is why an absent value must NOT fall back to
 * `http://localhost:3001` — that old default made every visitor's browser call ITS OWN
 * localhost, and shipped the literal string `localhost:3001` into the public bundle.
 *
 * AN EXPLICIT VALUE IS VALIDATED, NOT TRUSTED
 * -------------------------------------------
 * If `VITE_API_BASE_URL` IS supplied it is treated as an ORIGIN ONLY (endpoints add their
 * own "/api/..." prefix). The full policy, enforced below:
 *
 *   ACCEPTED
 *     "https://api.example.com"       → "https://api.example.com"
 *     "http://api.example.com:8080"   → "http://api.example.com:8080"
 *     "https://api.example.com/"      → trailing slash stripped
 *     "https://api.example.com///"    → repeated trailing slashes stripped
 *     "https://api.example.com/api"   → trailing "/api" stripped (so endpoints do not double it)
 *     "https://api.example.com/api/"  → both stripped
 *
 *   REJECTED (throws at module load)
 *     not an absolute URL             "not a url", "://missing-scheme", "http//broken"
 *     not http(s)                     "javascript:", "ftp:", "file:"
 *     a QUERY STRING                  "https://api.example.com?debug=1"
 *     a FRAGMENT                      "https://api.example.com#x"
 *     EMBEDDED CREDENTIALS            "https://user:pass@api.example.com"
 *     any OTHER PATH                  "https://api.example.com/foo", ".../api/v2"
 *
 * A query string and a fragment are rejected rather than stripped because neither has any
 * meaning on an origin and both previously CORRUPTED every derived URL (the query was
 * concatenated into the base, so the endpoint path landed inside the query). A base path is
 * rejected because no endpoint in this app expects one.
 *
 * Rejection THROWS at module load rather than silently degrading to same-origin: a
 * misconfigured API origin is a deployment error and must surface loudly, not be masked by
 * quietly talking to the wrong place.
 *
 * Exported so it can be unit-tested directly under `node:test` (which passes an explicit
 * argument) without a bundler.
 *
 * @param raw the configured value, or `undefined`/empty when none is set.
 * @returns the normalised absolute origin, or `""` for same-origin.
 * @throws if a non-empty value is not a valid absolute http/https URL.
 */
export function resolveApiOrigin(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  // Absent or empty ⇒ same-origin. Relative "/api/..." paths, no origin prefix.
  if (trimmed === "") return "";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `VITE_API_BASE_URL is not a valid absolute URL: "${trimmed}". ` +
        `Set it to a backend ORIGIN like "https://api.example.com", or leave it unset to ` +
        `use same-origin "/api" requests.`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `VITE_API_BASE_URL must use http or https, not "${url.protocol}": "${trimmed}".`,
    );
  }

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * AN ORIGIN, AND NOTHING BUT AN ORIGIN.
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * THE DEFECT THIS CLOSES. The old normalisation was
   *
   *     `${url.origin}${url.pathname}${url.search}`.replace(/\/+$/, "").replace(/\/api$/i, "")
   *
   * which CONCATENATED THE QUERY STRING into the base and silently DISCARDED any fragment. Because
   * `apiUrl()` appends the endpoint path, a value like "https://api.example.com?debug=1" produced
   *
   *     https://api.example.com?debug=1/api/box/status
   *
   * — a URL whose path is `/` and whose query is `debug=1/api/box/status`. Every request 404s or
   * hits the wrong route, and the SSE URL is broken the same way. A trailing-slash strip cannot
   * help, because the query is not at the end after concatenation.
   *
   * THE FINAL POLICY, enforced here and asserted in tests/apiSameOrigin.test.mjs:
   *   • absent / empty / whitespace  → "" (same-origin; relative "/api/..." paths)
   *   • must parse as an ABSOLUTE URL and use http: or https:
   *   • NO query string and NO fragment — neither has any meaning on an origin, and both silently
   *     corrupt every derived URL, so they are a deployment error rather than something to strip
   *   • NO embedded credentials ("https://user:pass@host") — those would be sent on every request
   *   • the ONLY paths tolerated are the two documented accidents: a trailing slash, and a trailing
   *     "/api" (with or without its own trailing slash). Both are stripped so the endpoints' own
   *     "/api/..." prefix cannot double up into "/api/api/...". ANY OTHER PATH is rejected — the
   *     value is an origin, and a base path would produce "https://host/foo/api/..." which no
   *     endpoint in this app expects.
   *
   * Rejection is a THROW at module load, deliberately: a misconfigured API origin must surface as a
   * failed deployment, not as a frontend quietly talking to the wrong place.
   */
  if (url.search !== "") {
    throw new Error(
      `VITE_API_BASE_URL must not contain a query string: "${trimmed}". It is an ORIGIN only ` +
        `(endpoints add their own "/api/..." path), and a query string corrupts every request URL. ` +
        `Use "${url.origin}".`,
    );
  }
  if (url.hash !== "") {
    throw new Error(
      `VITE_API_BASE_URL must not contain a fragment: "${trimmed}". It is an ORIGIN only, and a ` +
        `fragment is never sent to a server. Use "${url.origin}".`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      `VITE_API_BASE_URL must not contain embedded credentials: "${trimmed}". Credentials in the ` +
        `base URL would be attached to every request. Use "${url.origin}" and rely on the session cookie.`,
    );
  }

  // Tolerate ONLY a trailing slash and a trailing "/api"; reject any other path.
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path.toLowerCase() !== "/api") {
    throw new Error(
      `VITE_API_BASE_URL must not contain a path: "${trimmed}" has path "${url.pathname}". It is an ` +
        `ORIGIN only — endpoints add their own "/api/..." prefix, so a base path would produce ` +
        `"${url.origin}${path}/api/...". Use "${url.origin}".`,
    );
  }
  return url.origin;
}

/**
 * Read VITE_API_BASE_URL defensively.
 *
 * `import.meta.env` is injected by Vite in the browser build but is `undefined` under Node's
 * native type-stripping (where the tests run). Reading it through a guarded cast lets this
 * module be imported directly by `node:test` without a bundler — there it always reads as
 * absent, so the module resolves to the same-origin default.
 */
function readApiBaseUrl(): string | undefined {
  try {
    const env = (import.meta as unknown as { env?: { VITE_API_BASE_URL?: string } }).env;
    return env?.VITE_API_BASE_URL;
  } catch {
    return undefined;
  }
}

/**
 * The resolved API origin. `""` means same-origin (relative `/api/...` paths). A configured
 * value is a validated, normalised absolute http(s) origin. A misconfigured value throws
 * HERE, at module load, on purpose.
 */
export const API_ORIGIN = resolveApiOrigin(readApiBaseUrl());

/**
 * Build the URL for an "/api/..." path.
 *
 * With the same-origin default (`API_ORIGIN === ""`) this returns the path VERBATIM — a
 * relative `/api/...` URL the browser resolves against its own origin, so the HttpOnly
 * session cookie is attached and no origin/token leaks into the URL. With a configured
 * origin it prefixes that origin. This is the single chokepoint every REST call AND the SSE
 * URL go through, so the same-origin rule and the no-token-in-URL rule hold everywhere.
 */
export function apiUrl(path: string): string {
  return `${API_ORIGIN}${path}`;
}

/* ------------------------------- 401 subscribers ------------------------------ */

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/**
 * Subscribe to session-expiry (HTTP 401). Returns an unsubscribe function.
 *
 * The AccessGate and the SSE effect both subscribe: one 401 anywhere means the session is
 * gone, so the SSE must close and the app must return to the passcode screen.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** Fire the 401 handlers once. Exported so the SSE path can share the same notification. */
export function notifyUnauthorized(): void {
  // A 401 means the session is gone: the in-memory CSRF token is now stale and must never be
  // reused on a subsequent request. Clearing it HERE covers every 401 the wrapper detects,
  // plus any SSE-path 401 that fires this directly.
  clearCsrfToken();
  for (const listener of [...unauthorizedListeners]) {
    try {
      listener();
    } catch {
      /* a listener must never break the notification of the others */
    }
  }
}

/* ---------------------------------- CSRF token -------------------------------- */

/**
 * Header the backend expects the CSRF token echoed back in on a mutating request.
 *
 * SINGLE-SOURCED FROM THE VENDORED CONTRACT — NOT hardcoded here. `CSRF_HEADER` is imported
 * (see the top-of-file import) from `./contract.generated.ts`, which `npm run contract:types`
 * emits straight from the vendored, digest-verified `contract/protocol.json` (the backend's
 * single source of truth). This file is bundled by Vite for the browser and must not read the
 * filesystem at runtime, so a build-time-generated constant — not a runtime JSON read — is what
 * keeps the header name mechanical: a backend rename changes protocol.json (and the digest),
 * regenerates the constant, and the committed-generated-file CI check plus the transport test
 * fail until the frontend re-vendors deliberately. There is no independent literal here.
 */

/**
 * The CSRF token, held ONLY in this module's process memory.
 *
 * WHY IN MEMORY, NOT A COOKIE
 * ---------------------------
 * The token is NOT the session — the session is an HttpOnly cookie unreadable by JS by
 * design. The CSRF token is a separate value whose only job is to be echoed in a header so a
 * cross-site form POST (which cannot set custom headers) is rejected. The backend delivers
 * it in the JSON body of `/api/access/verify` and of an authenticated `/api/access/status`,
 * and derives the name of its readable CSRF *cookie* from a configurable
 * `SESSION_COOKIE_NAME`. Reading a hardcoded cookie name here broke any deployment that set
 * a custom name; holding the body-delivered token in memory is immune to that.
 *
 * It is deliberately NOT persisted to localStorage, sessionStorage, IndexedDB, a URL, a
 * query string or a log — a page reload drops it, and the post-reload `/api/access/status`
 * recovery path re-seeds it from the body.
 */
let csrfToken: string | null = null;

/**
 * Store the CSRF token in process memory.
 *
 * Called after a successful login (`/api/access/verify`) and after an authenticated
 * `/api/access/status` that carries a `csrf_token` (post-reload recovery). A nullish or
 * empty value clears the store rather than holding an empty string.
 */
export function setCsrfToken(token: string | null | undefined): void {
  csrfToken = token ? token : null;
}

/** The in-memory CSRF token, or `null` if none is held. */
export function getCsrfToken(): string | null {
  return csrfToken;
}

/**
 * Drop the in-memory CSRF token.
 *
 * Called on logout, on any HTTP 401 (via `notifyUnauthorized`), on failed authentication and
 * on gate reset — anywhere the session is known to be gone or invalid.
 */
export function clearCsrfToken(): void {
  csrfToken = null;
}

/**
 * Thrown before a mutating request is sent when no CSRF token is held.
 *
 * Firing the request anyway would earn a backend 403 whose cause is opaque; failing here
 * names the actual problem (no session-bound CSRF token) so it is legible in the UI and in
 * error reporting, without ever touching the network.
 */
export class MissingCsrfTokenError extends Error {
  constructor(what: string) {
    super(
      `${what}: no CSRF token is available for this mutating request. ` +
        `Sign in again to obtain one (the session may have expired).`,
    );
    this.name = "MissingCsrfTokenError";
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * DEFAULT REQUEST DEADLINES. Every request through this wrapper now has one.
 *
 * WHY THIS IS NEEDED. There was no application-level timeout anywhere: `RequestOptions.signal` was
 * forwarded to `fetch` but nothing in the app ever created an `AbortController`, so `request()` hung
 * exactly as long as the browser's socket did. A stalled request therefore held whatever single-flight
 * slot its caller had taken, and in `BoxExecutionControl` that slot was shared by the working-order
 * cancellation and the emergency flatten — so one black-holed cancellation disabled the panic button for
 * the life of the mounted component.
 *
 * WHY THE VALUES DIFFER. A mutation may legitimately take longer than a read (a cancellation sweep walks
 * the durable journal and talks to the broker per order), and cutting it off early is not free: the
 * server keeps going regardless. So mutations get a longer deadline, and the deadline is presented to the
 * operator as an UNKNOWN OUTCOME rather than a failure.
 *
 * WHAT A DEADLINE DOES NOT DO — and this is the important part. Aborting closes THIS end of the socket.
 * It does not cancel the server operation, and it does not undo anything the server already did or sent
 * to the broker. A `RequestTimeoutError` therefore means "we stopped waiting", never "it did not happen".
 * The server side is bounded separately, by operation identity and de-duplication
 * (`GAR_B/src/box/exposureOperations.ts`), so a retry after a timeout joins the original operation
 * instead of starting a second one.
 */
export const DEFAULT_READ_TIMEOUT_MS = 15_000;
export const DEFAULT_MUTATION_TIMEOUT_MS = 30_000;

/**
 * A request this client stopped waiting for. NOT evidence that the operation failed.
 *
 * Distinct from `ApiError` (the server answered and refused), from `MissingCsrfTokenError` (refused
 * locally, provably nothing sent) and from a raw `fetch` rejection (the network failed, and whether
 * anything was received is unknown). Callers must present it as an UNKNOWN OUTCOME: for a mutation, the
 * operation may be complete, partially complete, or still running on the server.
 */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  /** True when the abandoned request was a mutation, so the caller can warn about a blind retry. */
  readonly mutating: boolean;

  constructor(what: string, timeoutMs: number, mutating: boolean) {
    super(
      `${what}: no reply after ${Math.round(timeoutMs / 1000)}s, so this client stopped waiting. ` +
        (mutating
          ? "THE OUTCOME IS UNKNOWN — aborting does not cancel the server operation, which may have " +
            "completed, partly completed, or still be running. Refresh to see the current state before " +
            "retrying."
          : "The server may still be working; refresh to retry."),
    );
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
    this.mutating = mutating;
  }
}

/**
 * A request that never reached a reply because the transport failed. Outcome UNKNOWN for a mutation.
 *
 * `fetch` rejects with a bare `TypeError: Failed to fetch` for a DNS failure, a refused connection, a
 * CORS rejection AND a connection dropped mid-response — the last of which may be AFTER the server
 * acted. Wrapping it makes that ambiguity explicit instead of letting an opaque browser string reach the
 * operator, who would reasonably read "Failed to fetch" as "nothing happened".
 */
export class NetworkError extends Error {
  readonly mutating: boolean;
  readonly cause: unknown;

  constructor(what: string, mutating: boolean, cause: unknown) {
    super(
      `${what}: the request could not be completed (${
        cause instanceof Error ? cause.message : String(cause)
      }). ` +
        (mutating
          ? "THE OUTCOME IS UNKNOWN — the request may have reached the server before the connection " +
            "failed. Refresh to see the current state before retrying."
          : "Check the connection and retry."),
    );
    this.name = "NetworkError";
    this.mutating = mutating;
    this.cause = cause;
  }
}

/**
 * Is this outcome one where the operation MAY have taken effect?
 *
 * The single place that question is answered, so no caller has to re-derive it from an instanceof chain
 * and get it wrong. A local CSRF refusal and a server refusal are both "provably nothing happened"; a
 * timeout and a transport failure are not.
 */
export function isUnknownOutcome(error: unknown): boolean {
  if (error instanceof RequestTimeoutError || error instanceof NetworkError) return true;
  // A reply that arrived but could not be read through. See UnreadableResponseError.
  if (error instanceof UnreadableResponseError) return error.mutating;
  // A server failure whose status does not prove the operation was refused BEFORE it acted.
  if (error instanceof ApiError) return error.outcomeUnknown;
  return false;
}

/**
 * HTTP statuses that do NOT prove the server refused before acting.
 *
 * The distinction this encodes: a 409 or a 422 is the application itself saying "I looked at this and
 * declined" — nothing happened, and telling the operator so is correct. A 500 is the opposite: the
 * handler was entered and then something broke, and whether the broker order went out before it broke
 * is exactly what the status cannot say. A 502/504 is worse still, because the reply may have been
 * produced by a proxy that never learned what the application did.
 *
 * 408 is included for the same reason as a client-side timeout: the server gave up waiting, it did not
 * report that nothing was started.
 */
function statusProvesNothingHappened(status: number): boolean {
  if (status === 408) return false;
  return status < 500;
}

/**
 * Stable error codes that DO prove a mutation was refused before reaching the handler, even though
 * their status is a 5xx.
 *
 * Without this, every mutation attempted during a database outage would be presented as "the outcome is
 * unknown, refresh before retrying" — alarming, and wrong: these are refusals emitted by the access
 * middleware *before* any handler runs, so provably nothing was sent to a broker. The list is
 * deliberately tiny and matches the backend's own `ApiErrorBody.code` values; anything not named here
 * is treated as unproven.
 */
const PROVEN_PRE_ACTION_CODES = new Set(["auth_unavailable", "access_unavailable", "not_ready"]);

function bodyProvesPreActionRefusal(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" && PROVEN_PRE_ACTION_CODES.has(code);
}

/**
 * A reply whose STATUS was received but whose BODY could not be read through to a usable value.
 *
 * WHY THIS IS NOT AN ORDINARY ERROR. The response headers — including a 2xx — are proof the server
 * accepted and processed the request. A body that then truncates, fails to decode, or arrives as
 * something other than JSON tells us nothing about whether the operation completed; for a mutation the
 * honest answer is "it may well have". This was previously swallowed twice over: the body-read
 * rejection was discarded by a `.catch(() => "")` and the result surfaced as a generic
 * `Error("…unreadable reply")`, which `isUnknownOutcome` classified as a clean failure. A truncated
 * success response therefore reached the operator as a red failure message with no state reconciliation
 * — the single most misleading outcome the panel can produce.
 *
 * For a READ, nothing acted, so it is a plain failure and `isUnknownOutcome` stays false.
 */
export class UnreadableResponseError extends Error {
  readonly status: number;
  readonly mutating: boolean;
  readonly cause: unknown;

  constructor(what: string, status: number, mutating: boolean, cause: unknown) {
    super(
      `${what}: the server answered HTTP ${status} but its reply could not be read` +
        (cause instanceof Error && cause.message !== "" ? ` (${cause.message})` : "") +
        ". " +
        (mutating
          ? "THE OUTCOME IS UNKNOWN — the server had already accepted the request, so the operation " +
            "may have completed. Refresh to see the current state before retrying."
          : "Refresh to retry."),
    );
    this.name = "UnreadableResponseError";
    this.status = status;
    this.mutating = mutating;
    this.cause = cause;
  }
}

/* ----------------------------------- request ---------------------------------- */

export interface RequestOptions {
  method?: string;
  /** A JSON-serialisable body. Set automatically as JSON with the right Content-Type. */
  body?: unknown;
  /** Extra headers, merged after the defaults. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Override the default deadline. `0` disables it (only for a genuinely unbounded stream).
   *
   * Defaults to `DEFAULT_MUTATION_TIMEOUT_MS` for a mutating method and `DEFAULT_READ_TIMEOUT_MS`
   * otherwise. A caller-supplied `signal` is still honoured and is merged with the deadline, so
   * whichever fires first wins and cleanup happens either way.
   */
  timeoutMs?: number;
  /**
   * When true, a 401 does NOT fire the global unauthorized handler and does NOT throw an
   * UnauthorizedError — it surfaces the backend's error message like any other failure.
   *
   * This is for the LOGIN call: a 401 from `/api/access/verify` means "wrong passcode", not
   * "your session expired". Routing that through the session-expiry teardown would be wrong,
   * and there is no session to tear down yet.
   */
  suppressUnauthorized?: boolean;
  /**
   * When true, a MUTATING request is sent WITHOUT a CSRF header and WITHOUT requiring an
   * in-memory token. Use this ONLY for the one call the backend accepts without one:
   *
   *   • `POST /api/access/verify` — the login call itself MINTS the token (there is none to
   *     send yet), and the backend treats it as the sole public mutation.
   *
   * Every other mutating request MUST carry the token: if none is held the wrapper throws a
   * `MissingCsrfTokenError` rather than firing a request the backend will 403.
   */
  csrfExempt?: boolean;
  /**
   * Send the CSRF header WHEN a token is held, and omit it (without throwing) when none is.
   *
   * This exists for exactly one call: `POST /api/access/logout`.
   *
   * The backend's logout route is deliberately asymmetric. With a LIVE session, revoking it
   * is a real state change and the route REQUIRES an allowed Origin plus a matching
   * `x-csrf-token` header. With no live session there is nothing to protect, so it clears
   * the cookies and returns 200 without a header.
   *
   * Logout therefore cannot be `csrfExempt`: omitting the header while the session is live
   * earns a 403, the server session is never revoked, and the UI "logs out" locally while a
   * valid session keeps sitting in the database until it expires. It also cannot be a normal
   * mutation, because that would throw `MissingCsrfTokenError` and strand a browser holding
   * a dead cookie it can no longer clear. Best-effort satisfies both halves of the route.
   */
  csrfBestEffort?: boolean;
}

/**
 * Parse a JSON response, or throw an error that names what actually happened.
 *
 * Reading the body as text and parsing it ourselves means a non-JSON failure (an nginx 502
 * HTML page, a gateway timeout) still reports its status instead of surfacing an opaque
 * `Unexpected token '<'` parse error.
 */
async function readJson<T>(
  res: Response,
  what: string,
  ctx: {
    /** True for POST/PUT/PATCH/DELETE: a failure here may have left the server changed. */
    readonly mutating: boolean;
    /** Rethrows as a timeout/caller-abort when OUR deadline or the caller killed the body read. */
    readonly onBodyReadFailure: (cause: unknown) => never;
  },
): Promise<T> {
  /*
   * THE BODY READ IS NOT ALLOWED TO FAIL SILENTLY.
   *
   * This used to be `res.text().catch(() => "")`, which turned every body-level failure — a connection
   * dropped mid-body, a truncated chunked response, a decode error, our own deadline firing — into an
   * empty string, and an empty string into a generic "unreadable reply" error. The information that the
   * server had ALREADY accepted the request was thrown away with it.
   */
  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    // Always throws — it decides WHICH error class the failure deserves (timeout, caller abort, or an
    // unreadable reply). The rethrow below is unreachable and exists only so control-flow analysis can
    // see that `text` is assigned on every path that continues.
    ctx.onBodyReadFailure(cause);
    throw cause;
  }

  let body: (T & { error?: string }) | null = null;
  let parseFailed = false;
  try {
    body = text ? (JSON.parse(text) as T & { error?: string }) : null;
  } catch {
    // Not JSON — fall through to the status-based message below.
    parseFailed = true;
  }
  // The PARSED body travels with the error, not just the message. Some endpoints answer a non-2xx
  // with a STRUCTURED, actionable payload rather than only a sentence — the operator-configuration
  // PATCH returns `{ applied: false, version, reason, problems[] }` on a 409/422/403, where the
  // version is needed to resynchronise and `problems` names the offending field. Without the body a
  // caller would have to parse prose to find them, and one that forgot would render "request failed"
  // for a refusal that had a precise reason attached. `body` is `null` when the reply was not JSON.
  if (!res.ok) {
    /*
     * IS THIS FAILURE PROOF THAT NOTHING HAPPENED? Usually yes, sometimes not, and the difference has to
     * be carried rather than assumed. A 409 refusal is proof; a 500 after the handler was entered, or a
     * 504 from a proxy that never learned the outcome, is not. Only mutations can be ambiguous.
     */
    const outcomeUnknown =
      ctx.mutating && !statusProvesNothingHappened(res.status) && !bodyProvesPreActionRefusal(body);
    const base = body?.error ?? `${what} (HTTP ${res.status}).`;
    const message = outcomeUnknown
      ? `${base} THE OUTCOME IS UNKNOWN — this status does not prove the operation was refused before ` +
        "it acted. Refresh to see the current state before retrying."
      : base;
    throw new ApiError(message, res.status, body, outcomeUnknown);
  }
  if (body === null) {
    /*
     * A 2xx WHOSE BODY IS EMPTY OR NOT JSON. The server accepted the request — the status says so — and
     * then the confirmation was unusable. For a mutation that is an unknown outcome, not a failure, so
     * it must NOT come back as a bare `Error` the way it used to.
     */
    throw new UnreadableResponseError(
      what,
      res.status,
      ctx.mutating,
      parseFailed ? new Error("the reply was not valid JSON") : new Error("the reply was empty"),
    );
  }
  return body;
}

/**
 * The operator-facing reason a request was refused, preferring the STRUCTURED field over the generic
 * status sentence.
 *
 * WHY THIS EXISTS. `readJson` builds an `ApiError` message from `body.error`, but several refusals answer
 * with a different field: the working-order cancellation sweep refuses with **409 + `blocked_reason`**
 * (no `error` key at all), so the message became the useless `"Failed to cancel working Box orders
 * (HTTP 409)."` while the real reason — "The durable order-intent journal could not be read … Restore
 * PostgreSQL, or cancel from the broker terminal." — sat unread on `ApiError.body`. In an emergency that
 * is the difference between an operator knowing what to do and not.
 *
 * Checked in order of specificity. `next_action` is last because it is guidance rather than a cause, and
 * is only used when nothing named a cause.
 */
export function refusalReason(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["blocked_reason", "error", "detail", "reason", "next_action"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * The message to show for any failure from this wrapper, with the structured refusal preferred.
 *
 * One helper so every operator-facing surface classifies identically: a caller that forgot to read
 * `ApiError.body` is exactly how the 409 reason went missing.
 */
export function describeRequestFailure(error: unknown): string {
  const structured = refusalReason(error);
  if (structured !== null) return structured;
  if (error instanceof Error && error.message !== "") return error.message;
  return "The request failed.";
}

/**
 * A non-2xx response, carrying the HTTP status alongside the backend's own message.
 *
 * It extends `Error` and keeps `message` byte-identical to what the previous plain `Error`
 * carried, so every existing `err instanceof Error ? err.message : …` call site is
 * unaffected. The added `status` exists so a caller can distinguish outcomes that must be
 * PRESENTED differently without parsing prose — specifically, the passcode screen showing
 * one fixed "Invalid passcode" for a 401 while still surfacing the backend's own generic
 * message for a 429 (rate limited) or a 503 (access temporarily unavailable).
 */
export class ApiError extends Error {
  readonly status: number;
  /**
   * The PARSED JSON body of the failing response, or `null` when the reply was not JSON.
   *
   * Added for endpoints that answer a non-2xx with a structured, actionable payload rather than only a
   * message — see the note in `readJson`. Typed `unknown` on purpose: a caller must narrow it before
   * use, so an unexpected shape (a proxy's HTML error page, a truncated reply) cannot be read as a
   * valid domain object. `message` is unchanged, so every existing `err.message` call site is
   * unaffected.
   */
  readonly body: unknown;
  /**
   * True when this failure does NOT prove the operation was refused before it acted.
   *
   * Only ever true for a MUTATION: a failed read changes nothing by definition. Set by `readJson` from
   * the status and the body's stable code (see `statusProvesNothingHappened` and
   * `PROVEN_PRE_ACTION_CODES`), and read by `isUnknownOutcome` so callers route a 500/502/504 on a
   * mutation into the "outcome unknown, reconcile before retrying" branch instead of presenting it as a
   * clean refusal. Defaults to false, so an `ApiError` constructed by hand — including the 409 refusals
   * the tests pin — keeps the old, provable-refusal meaning.
   */
  readonly outcomeUnknown: boolean;

  constructor(message: string, status: number, body: unknown = null, outcomeUnknown = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.outcomeUnknown = outcomeUnknown;
  }
}

/**
 * The single fetch wrapper.
 *
 * - Sends `credentials: "include"` so the HttpOnly session cookie is attached.
 * - Sets `Content-Type: application/json` and serialises a JSON body when one is given.
 * - Attaches the in-memory CSRF token as the `x-csrf-token` header on every mutating
 *   request. If no token is held it throws `MissingCsrfTokenError` BEFORE hitting the
 *   network — except for a `csrfExempt` call (`/api/access/verify`, logout), which is sent
 *   without the header on purpose.
 * - On HTTP 401 it notifies the unauthorized subscribers ONCE (which also clears the
 *   in-memory CSRF token) and then throws, so the caller's own error handling still runs but
 *   the session teardown is centralised.
 *
 * `what` is a bare description ("Failed to load the box status"); the HTTP status is
 * appended by `readJson` so every endpoint phrases a failure identically.
 */
export async function request<T>(
  path: string,
  what: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (MUTATING.has(method) && !options.csrfExempt) {
    const csrf = getCsrfToken();
    if (csrf) {
      headers[CSRF_HEADER] = csrf;
    } else if (!options.csrfBestEffort) {
      // Never send an empty header. If no token is held, fail loudly and locally rather than
      // firing a request the backend will 403 with an opaque message. A `csrfBestEffort`
      // call (logout) deliberately proceeds without one — see RequestOptions.
      throw new MissingCsrfTokenError(what);
    }
  }

  const timeoutMs = options.timeoutMs ?? (MUTATING.has(method) ? DEFAULT_MUTATION_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS);
  const mutating = MUTATING.has(method);

  /*
   * THE DEADLINE, and its cleanup.
   *
   * An internally-created controller is merged with any caller-supplied signal so both can abort the
   * request and neither is lost. `timer` is cleared in a `finally` whatever happens — a leaked timer
   * would keep firing after a successful response and, in a long-lived panel, accumulate one per request.
   *
   * `abortedByDeadline` distinguishes OUR abort from the caller's. Both surface as the same
   * `AbortError` from `fetch`, and they mean different things: ours is a timeout (unknown outcome),
   * the caller's is a deliberate cancellation (e.g. a component unmounting) that must not be reported
   * to the operator as a failure at all.
   */
  const controller = new AbortController();
  let abortedByDeadline = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      abortedByDeadline = true;
      controller.abort();
    }, timeoutMs);
  }
  const callerSignal = options.signal;
  const onCallerAbort = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  /*
   * ────────────────────────────────────────────────────────────────────────────────────────────────
   * THE DEADLINE SPANS THE WHOLE REPLY, HEADERS AND BODY.
   *
   * `fetch` resolves as soon as the response HEADERS arrive; the body is still streaming. The cleanup
   * used to sit in a `finally` on the fetch alone, so the timer was cleared and the caller's abort
   * bridge torn down at exactly that moment — and then `readJson` read the body with no deadline over
   * it and no route to the abort signal. A server that flushed headers and stalled the body left the
   * returned promise pending FOREVER: nothing could time it out, and an unmounting component could not
   * cancel it either.
   *
   * That was not merely a hung request. `runOnce`'s `finally` never ran, so the single-flight slot was
   * never released and `setBusy(null)` never fired — the control stayed disabled for the life of the
   * mounted component. It is the same wedge that motivated the deadline in the first place, surviving
   * one layer further down. Status polling was affected identically.
   *
   * So the cleanup now wraps BOTH awaits. Aborting the controller rejects an in-flight `res.text()`
   * exactly as it rejects an in-flight `fetch`, which is what makes one deadline enough for both.
   * ────────────────────────────────────────────────────────────────────────────────────────────────
   */
  try {
    let res: Response;
    try {
      res = await fetch(apiUrl(path), {
        method,
        headers,
        credentials: "include",
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (abortedByDeadline) throw new RequestTimeoutError(what, timeoutMs, mutating);
      // The CALLER aborted. Propagate untouched: a deliberate cancellation is not an error to report.
      if (callerSignal?.aborted === true) throw error;
      // Anything else `fetch` rejects with is a transport failure whose outcome is unknown for a mutation.
      throw new NetworkError(what, mutating, error);
    }

    // A 401 means the session is gone. Notify the app ONCE from here, then throw so the
    // caller still sees the failure. Every /api/box/* call funnels through this wrapper, so
    // this is the single place session-expiry is detected. The login call opts out
    // (suppressUnauthorized): a wrong passcode is not an expired session.
    if (res.status === 401 && !options.suppressUnauthorized) {
      notifyUnauthorized();
      throw new UnauthorizedError(what);
    }

    return await readJson<T>(res, what, {
      mutating,
      onBodyReadFailure: (cause): never => {
        // OUR deadline cut the body off. The server had already accepted the request, so for a
        // mutation this is the canonical unknown outcome — reported exactly like a headers-stage
        // timeout, because from the operator's position it is the same event.
        if (abortedByDeadline) throw new RequestTimeoutError(what, timeoutMs, mutating);
        // The caller cancelled (a component unmounted). Not a failure to report.
        if (callerSignal?.aborted === true) throw cause;
        // The connection died partway through the reply. The status was already 2xx/4xx/5xx, so this
        // is NOT a plain network failure — it is a reply we could not read to the end.
        throw new UnreadableResponseError(what, res.status, mutating, cause);
      },
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Thrown on any HTTP 401 so callers can branch on session expiry if they need to. */
export class UnauthorizedError extends Error {
  constructor(what: string) {
    super(`${what}: your session has expired (HTTP 401).`);
    this.name = "UnauthorizedError";
  }
}
