/**
 * The site-passcode access API.
 *
 * GTS Box is gated by a single site passcode. Verifying it establishes an HttpOnly
 * session cookie server-side; the browser never sees, stores or forwards a SESSION token.
 * These three calls are the entire surface the AccessGate needs.
 *
 * CSRF token lifecycle lives here too: `verify` and an authenticated `status` return a
 * `csrf_token` in their JSON body; this module hands it to the in-memory store in `http.ts`
 * (`setCsrfToken`) so mutating requests can echo it in the `x-csrf-token` header. `logout`
 * clears it. NOTHING here reads or writes the session or the CSRF token in localStorage —
 * the session lives only in the cookie the backend sets and clears; the CSRF token lives
 * only in process memory.
 */

import { clearCsrfToken, request, setCsrfToken } from "./http.ts";

/** Whether a valid session currently exists, per the backend. */
export interface AccessStatus {
  /** True once a valid site session cookie is present. */
  authenticated: boolean;
  /** True when the deployment has a passcode configured at all. */
  passcode_configured?: boolean;
  /** The operator role the session grants (present when authenticated). */
  role?: string;
  /** ISO timestamp the session expires at (present when authenticated). */
  expires_at?: string;
  /**
   * The session-bound CSRF token. Present on a successful `verify` and on an authenticated
   * `status` whose request carried a matching CSRF cookie. Captured into the in-memory store
   * — NEVER persisted to localStorage/sessionStorage/etc.
   */
  csrf_token?: string;
}

/**
 * Verify the site passcode.
 *
 * On success the backend sets the HttpOnly session cookie and returns a `csrf_token` in the
 * body, which is captured into the in-memory store so subsequent mutations can echo it. On a
 * wrong passcode the backend answers a non-2xx and the promise rejects with the backend's
 * message — the gate shows it and stays closed, and the stale token (if any) is cleared.
 *
 * This is a `csrfExempt` mutation: it is the ONLY public mutation and there is no token to
 * send yet — it MINTS one.
 *
 * The passcode is sent in the request body and is NEVER persisted anywhere on the client.
 */
export async function verifyPasscode(passcode: string): Promise<AccessStatus> {
  try {
    const status = await request<AccessStatus>(
      "/api/access/verify",
      "Failed to verify the passcode",
      {
        method: "POST",
        body: { passcode },
        // The login call is the sole public mutation and mints the CSRF token — it carries
        // no CSRF header itself.
        csrfExempt: true,
        // A 401 here means "wrong passcode", NOT "session expired": surface the backend's
        // message and keep the gate closed, rather than firing the session-expiry teardown.
        suppressUnauthorized: true,
      },
    );
    if (status.authenticated && status.csrf_token) {
      setCsrfToken(status.csrf_token);
    } else {
      // A non-authenticated verify (or one without a token) must not leave a stale token.
      clearCsrfToken();
    }
    return status;
  } catch (err) {
    // Failed authentication clears any token held from a previous session.
    clearCsrfToken();
    throw err;
  }
}

/**
 * Ask the backend whether the current cookie is a valid session.
 *
 * On the post-reload recovery path the process memory is empty; if the backend returns a
 * `csrf_token` (because the request carried a matching CSRF cookie) it is re-seeded into the
 * in-memory store here, so mutations work again after a reload without a fresh login.
 */
export async function accessStatus(): Promise<AccessStatus> {
  const status = await request<AccessStatus>(
    "/api/access/status",
    "Failed to load the access status",
  );
  if (status.authenticated && status.csrf_token) {
    setCsrfToken(status.csrf_token);
  }
  return status;
}

/**
 * End the session.
 *
 * Never rejects and never claims success on an error status: pressing "Lock" must always
 * return the UI to the gate locally, even if the network call fails, so a failure is logged
 * rather than surfaced. The in-memory CSRF token is cleared regardless of the network
 * outcome.
 *
 * Logout is `csrfExempt`: the backend requires the CSRF header only for a LIVE session, and
 * a logout must also succeed when the session is already dead (no token to echo), so the
 * header is omitted rather than blocking on a possibly-missing token.
 */
export async function logout(): Promise<void> {
  try {
    await request<{ ok?: boolean }>("/api/access/logout", "Failed to log out", {
      method: "POST",
      csrfExempt: true,
    });
  } catch (err) {
    // The gate closes locally regardless; a failed logout must not trap the user inside.
    console.warn("[access] logout request failed; clearing locally anyway.", err);
  } finally {
    // The token is dead once the user logs out — drop it no matter what the network did.
    clearCsrfToken();
  }
}
