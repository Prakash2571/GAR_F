/**
 * Reading the result of an in-app broker sign-in off the workspace URL.
 *
 * THE ROUND TRIP THIS COMPLETES
 * The operator clicks "Connect", the backend returns the broker's consent URL, the browser
 * leaves this app entirely, authenticates at Zerodha or Dhan, and the broker redirects to
 * the BACKEND's callback. The backend exchanges the one-time code, stores the token, and
 * sends the browser back here as
 *
 *     /box?broker_login={broker}&status=connected
 *     /box?broker_login={broker}&status=failed&reason={code}
 *
 * A full page load happens in between, so no React state, no closure and no in-memory
 * variable survives. The URL is the ONLY channel — which is exactly why this module exists
 * and why it is pure: the query string is the whole input.
 *
 * WHY NOTHING IS PERSISTED CLIENT-SIDE
 * There is deliberately no `localStorage`/`sessionStorage` write anywhere in this flow. It
 * would be the obvious place to stash "which broker am I signing into" or an OAuth nonce,
 * and it is the wrong place for both: the nonce round-trips through the broker and is
 * verified SERVER-side against a single-use record, so the browser has nothing worth
 * keeping. (CI also enforces a two-key localStorage allow-list, which is a good rule this
 * flow has no reason to bend.)
 *
 * WHY THE PARAMS ARE STRIPPED AFTER READING
 * `?status=connected` left in the address bar would re-announce a stale success on every
 * reload, and a shared/bookmarked URL would announce someone else's sign-in. The caller
 * reads the outcome once, shows it, then rewrites the URL with `history.replaceState`.
 *
 * NOTHING HERE TRUSTS THE URL. The values are attacker-supplied in principle (anyone can
 * type them), so they are only ever turned into a MESSAGE — never into a session, a
 * permission or a token. The authoritative state always comes from `GET /api/broker/status`.
 *
 * WHY THE RETURN LANDS ON `/box`, AND WHY THE SESSION SURVIVES IT
 * `/box` is chosen because it is an EXISTING route: the SPA router needs no new path and the
 * server needs no new rewrite rule. The subtle part is the cookie. The site session is
 * `SameSite=Strict`, and the browser arrives here at the end of a redirect chain that STARTED
 * cross-site (at the broker), so the browser may withhold the session cookie on that final
 * DOCUMENT request. That is harmless: the document is a static asset needing no session. The
 * moment the SPA is running, its own `fetch` calls are first-party requests, the Strict cookie
 * IS sent, and `AccessGate`'s `GET /api/access/status` on mount re-establishes the session and
 * re-seeds the CSRF token. So the operator lands signed in, and the flow needs no cookie
 * relaxation anywhere.
 */

import type { BrokerId, BrokerLoginOutcome } from "../api/types.ts";

/** The query parameters the backend's post-login redirect uses. */
export const BROKER_LOGIN_PARAM = "broker_login";
export const BROKER_LOGIN_STATUS_PARAM = "status";
export const BROKER_LOGIN_REASON_PARAM = "reason";

function isBrokerId(raw: string | null): raw is BrokerId {
  return raw === "zerodha" || raw === "dhan";
}

/**
 * Parse a sign-in outcome out of a `location.search`, or `null` when there is none.
 *
 * Returns `null` — not a "failed" outcome — for anything unrecognised. A malformed or
 * partial query string means "no sign-in just happened", and inventing a failure notice
 * from it would alarm an operator who merely reloaded the page.
 *
 * Never throws: a malformed search string yields `null`.
 */
export function readBrokerLoginOutcome(search: string): BrokerLoginOutcome | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }

  const broker = params.get(BROKER_LOGIN_PARAM);
  if (!isBrokerId(broker)) return null;

  const status = params.get(BROKER_LOGIN_STATUS_PARAM);
  if (status !== "connected" && status !== "failed") return null;

  const reason = params.get(BROKER_LOGIN_REASON_PARAM);
  return {
    broker,
    status,
    // A reason is meaningful only on failure; a success that carries one is ignored rather
    // than rendered, so a hand-edited URL cannot attach a scary sentence to a success.
    reason: status === "failed" && reason ? reason : null,
  };
}

/**
 * Remove the sign-in parameters, preserving every other query parameter.
 *
 * Returns a value ready for `history.replaceState` — `""` when nothing remains, otherwise
 * a leading-`?` search string. Other parameters are preserved because the workspace URL may
 * legitimately carry unrelated state, and silently dropping it would be a second bug.
 */
export function stripBrokerLoginParams(search: string): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return "";
  }
  params.delete(BROKER_LOGIN_PARAM);
  params.delete(BROKER_LOGIN_STATUS_PARAM);
  params.delete(BROKER_LOGIN_REASON_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** Display name for a broker. Kept here so the login surface and the panel agree. */
export function brokerLabel(broker: BrokerId): string {
  return broker === "zerodha" ? "Zerodha" : "Dhan";
}

/**
 * Turn a backend failure code into a sentence that tells the operator WHAT TO DO.
 *
 * Every branch names the next action, because "state_mismatch" on its own is unactionable
 * and the operator's real question is always "do I click Connect again, or is something
 * actually broken?".
 *
 * An UNRECOGNISED code is rendered as itself (underscores spaced out) rather than replaced
 * with a generic message: a backend that grows a new reason should surface it, not have it
 * flattened into "something went wrong".
 */
export function describeBrokerLoginFailure(broker: BrokerId, reason: string | null): string {
  const name = brokerLabel(broker);
  switch (reason) {
    case "no_pending_login":
      return `${name} sign-in could not be matched to a request from this app. Start the sign-in from here and complete it in the same browser.`;
    case "login_expired":
      return `The ${name} sign-in took too long and expired. Click Connect to try again.`;
    case "state_mismatch":
    case "state_missing":
      return `The ${name} sign-in could not be verified, so it was refused. Click Connect to start a fresh sign-in.`;
    case "not_ready":
      return `${name} sign-in was refused because the server is still starting up. Wait a moment, then click Connect again.`;
    case "not_configured":
      return `${name} is not configured on the server, so it cannot be signed in to. An operator needs to set its app credentials.`;
    case "broker_denied":
      return `${name} did not approve the sign-in — it was cancelled or declined at the broker.`;
    case "missing_credential":
      return `${name} redirected back without a sign-in code. Click Connect to try again; if it repeats, check the redirect URL registered on the broker app.`;
    case "exchange_failed":
      return `${name} rejected the sign-in code. Click Connect to try again — see the ${name} card below for the reason the server recorded.`;
    case null:
    case "":
      return `The ${name} sign-in did not complete. Click Connect to try again.`;
    default:
      return `The ${name} sign-in failed: ${reason.replace(/_/g, " ")}.`;
  }
}

/** The notice text for an outcome, success or failure. */
export function describeBrokerLoginOutcome(outcome: BrokerLoginOutcome): string {
  if (outcome.status === "connected") {
    // Deliberately says what did NOT happen too: a connected broker is not a trading broker,
    // and an operator who assumes otherwise has misread the system.
    return `${brokerLabel(outcome.broker)} is connected. This does not change which broker is active or arm live trading.`;
  }
  return describeBrokerLoginFailure(outcome.broker, outcome.reason);
}
