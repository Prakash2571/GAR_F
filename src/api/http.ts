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

/* ----------------------------------- request ---------------------------------- */

export interface RequestOptions {
  method?: string;
  /** A JSON-serialisable body. Set automatically as JSON with the right Content-Type. */
  body?: unknown;
  /** Extra headers, merged after the defaults. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
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
async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text().catch(() => "");
  let body: (T & { error?: string }) | null = null;
  try {
    body = text ? (JSON.parse(text) as T & { error?: string }) : null;
  } catch {
    // Not JSON — fall through to the status-based message below.
  }
  // The PARSED body travels with the error, not just the message. Some endpoints answer a non-2xx
  // with a STRUCTURED, actionable payload rather than only a sentence — the operator-configuration
  // PATCH returns `{ applied: false, version, reason, problems[] }` on a 409/422/403, where the
  // version is needed to resynchronise and `problems` names the offending field. Without the body a
  // caller would have to parse prose to find them, and one that forgot would render "request failed"
  // for a refusal that had a precise reason attached. `body` is `null` when the reply was not JSON.
  if (!res.ok) throw new ApiError(body?.error ?? `${what} (HTTP ${res.status}).`, res.status, body);
  if (body === null) throw new Error(`${what}: the server sent an unreadable reply.`);
  return body;
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

  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
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

  const res = await fetch(apiUrl(path), {
    method,
    headers,
    credentials: "include",
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // A 401 means the session is gone. Notify the app ONCE from here, then throw so the
  // caller still sees the failure. Every /api/box/* call funnels through this wrapper, so
  // this is the single place session-expiry is detected. The login call opts out
  // (suppressUnauthorized): a wrong passcode is not an expired session.
  if (res.status === 401 && !options.suppressUnauthorized) {
    notifyUnauthorized();
    throw new UnauthorizedError(what);
  }

  return readJson<T>(res, what);
}

/** Thrown on any HTTP 401 so callers can branch on session expiry if they need to. */
export class UnauthorizedError extends Error {
  constructor(what: string) {
    super(`${what}: your session has expired (HTTP 401).`);
    this.name = "UnauthorizedError";
  }
}
