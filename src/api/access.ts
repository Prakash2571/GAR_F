/**
 * The site-passcode access API.
 *
 * GTS Box is gated by a single site passcode. Verifying it establishes an HttpOnly session
 * cookie server-side; the browser never sees, stores or forwards a SESSION token. These
 * three calls are the entire surface the access layer needs.
 *
 * CSRF token lifecycle lives here too: `verify` and an authenticated `status` return a
 * `csrf_token` in their JSON body; this module hands it to the in-memory store in `http.ts`
 * (`setCsrfToken`) so mutating requests can echo it in the `x-csrf-token` header. `logout`
 * clears it. NOTHING here reads or writes the session or the CSRF token in localStorage —
 * the session lives only in the cookie the backend sets and clears; the CSRF token lives
 * only in process memory.
 */

import { ApiError, clearCsrfToken, request, setCsrfToken } from "./http.ts";

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
 * The passcode was not accepted.
 *
 * A DISTINCT type so the UI can render ONE fixed, uninformative string ("Invalid passcode")
 * for this case while still surfacing the backend's own generic message for an operational
 * failure (rate limited, access temporarily unavailable). The backend answers an identical
 * 401 body whether the passcode was wrong or no secret is configured at all, so this type
 * carries no information about which — and neither does anything rendered from it.
 */
export class PasscodeRejectedError extends Error {
  constructor() {
    super("Invalid passcode");
    this.name = "PasscodeRejectedError";
  }
}

/**
 * Verify the site passcode.
 *
 * On success the backend sets the HttpOnly session cookie and returns a `csrf_token` in the
 * body, which is captured into the in-memory store so subsequent mutations can echo it.
 *
 * On a rejected passcode the backend answers 401 and this rejects with
 * `PasscodeRejectedError`; on any other failure it rejects with the backend's own generic
 * message. Either way the stale token (if any) is cleared.
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
        // A 401 here means "wrong passcode", NOT "session expired": it must not fire the
        // session-expiry teardown, and there is no session to tear down yet.
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
    // 401 is the ONE outcome that means "that passcode was not accepted". Everything else
    // (429 rate limited, 503 access unavailable, a transport failure) is an operational
    // problem and must not be disguised as a wrong passcode.
    if (err instanceof ApiError && err.status === 401) throw new PasscodeRejectedError();
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
 * return the UI to the public site locally, even if the network call fails, so a failure is
 * logged rather than surfaced. The in-memory CSRF token is cleared regardless of the network
 * outcome.
 *
 * CSRF: `csrfBestEffort`, NOT `csrfExempt`. The backend's logout route requires the
 * `x-csrf-token` header when the session is LIVE (revoking a live session is a real state
 * change) and accepts the call without one when the session is already dead (there is
 * nothing left to protect, and a browser holding a stale cookie must still be able to clear
 * it). Best-effort sends the header whenever a token is held and omits it otherwise, so BOTH
 * halves of that route work — an unconditional exemption would earn a 403 on the live path
 * and leave the server-side session un-revoked until it expired.
 */
export async function logout(): Promise<void> {
  try {
    await request<{ ok?: boolean }>("/api/access/logout", "Failed to log out", {
      method: "POST",
      csrfBestEffort: true,
    });
  } catch (err) {
    // The session ends locally regardless; a failed logout must not trap the user inside.
    console.warn("[access] logout request failed; clearing locally anyway.", err);
  } finally {
    // The token is dead once the user logs out — drop it no matter what the network did.
    clearCsrfToken();
  }
}
