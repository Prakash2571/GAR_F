/**
 * The GTS Box site passcode gate.
 *
 * WHAT IT IS — AND IS NOT
 * -----------------------
 * This is a UX gate, not a security boundary. The real gate is the backend, which answers
 * 401 for every /api/box/* request without a valid session cookie. This component only
 * decides which surface to show:
 *   • unauthenticated → a minimal passcode screen, and NOTHING else;
 *   • authenticated   → the children (the Box dashboard) mount.
 *
 * NON-NEGOTIABLES
 *   • The session lives in an HttpOnly cookie the backend sets on a correct passcode. This
 *     component NEVER reads or writes any session token in localStorage. It holds one
 *     boolean in React state and nothing else.
 *   • On any 401 anywhere in the app (surfaced via `onUnauthorized` from the http wrapper),
 *     authenticated state is cleared and the gate returns — the SSE teardown is handled by
 *     the dashboard's own 401 subscription.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { accessStatus, logout, verifyPasscode } from "../api/access.ts";
import { clearCsrfToken, onUnauthorized } from "../api/http.ts";
import BrandMark from "../BrandMark.tsx";
import ThemeToggle from "../ThemeToggle.tsx";

type GateState = "checking" | "locked" | "unlocked";

export interface AccessGateProps {
  /** Rendered only once a valid session exists. */
  children: (ctx: { onLock: () => void }) => React.ReactNode;
}

export default function AccessGate({ children }: AccessGateProps) {
  const [state, setState] = useState<GateState>("checking");
  const [passcode, setPasscode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // On mount, ask the backend whether the current cookie is already a valid session, so a
  // returning user with a live session skips the gate.
  useEffect(() => {
    let cancelled = false;
    accessStatus()
      .then((s) => {
        if (!cancelled) setState(s.authenticated ? "unlocked" : "locked");
      })
      .catch(() => {
        // Any failure (incl. a 401) means: show the gate.
        if (!cancelled) setState("locked");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A 401 ANYWHERE clears authenticated state and returns to the gate. The dashboard's own
  // subscriber closes the SSE; this one flips the UI back to locked. `notifyUnauthorized`
  // already dropped the in-memory CSRF token; clearing again here is a cheap belt-and-braces
  // so a reset gate never holds a stale token.
  useEffect(() => {
    return onUnauthorized(() => {
      clearCsrfToken();
      setState("locked");
      setPasscode("");
    });
  }, []);

  useEffect(() => {
    if (state === "locked") inputRef.current?.focus();
  }, [state]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting || passcode.trim() === "") return;
      setSubmitting(true);
      setError(null);
      try {
        const result = await verifyPasscode(passcode);
        if (result.authenticated) {
          // Clear the passcode from memory the instant it is no longer needed. It is never
          // persisted — the session is the HttpOnly cookie the backend just set.
          setPasscode("");
          setState("unlocked");
        } else {
          setError("That passcode was not accepted.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "That passcode was not accepted.");
      } finally {
        setSubmitting(false);
      }
    },
    [passcode, submitting],
  );

  const onLock = useCallback(() => {
    void logout().finally(() => {
      setState("locked");
      setPasscode("");
    });
  }, []);

  if (state === "checking") {
    return (
      <div className="gate">
        <div className="gate-card" aria-busy="true">
          <span className="spinner" />
          <span className="gate-checking">Checking session…</span>
        </div>
      </div>
    );
  }

  if (state === "unlocked") {
    return <>{children({ onLock })}</>;
  }

  return (
    <div className="gate">
      <div className="gate-topbar">
        <ThemeToggle />
      </div>
      <form className="gate-card" onSubmit={(e) => void onSubmit(e)}>
        <div className="gate-brand">
          <BrandMark />
          <div className="gate-lockup">
            <h1 className="brand-word">
              GTS <b>Box</b>
            </h1>
            <span className="gate-desc">Box-arbitrage research desk</span>
          </div>
        </div>
        {/* What the product IS, stated before the passcode rather than after it. Deliberately
            describes only what the system does — it makes no claim about the execution mode,
            because that is the backend's to report and is not known until the gate opens. */}
        <p className="gate-thesis">
          Four-leg box arbitrage on NSE F&amp;O. Continuous pricing of the ATM window, the full
          expected-net arithmetic behind every entry decision, and an audit record of each
          execution attempt.
        </p>
        <p className="gate-sub">Enter the site passcode to continue.</p>
        <label className="gate-field">
          <span className="sr-only">Site passcode</span>
          <input
            ref={inputRef}
            type="password"
            className="gate-input"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="Passcode"
            autoComplete="current-password"
            disabled={submitting}
            aria-invalid={error !== null}
            aria-label="Site passcode"
          />
        </label>
        <button
          type="submit"
          className="btn btn--primary btn--full gate-submit"
          disabled={submitting || passcode.trim() === ""}
        >
          {submitting ? "Verifying…" : "Unlock"}
        </button>
        {error && (
          <p className="gate-error" role="alert">
            {error}
          </p>
        )}
        <p className="gate-note">
          GTS Box is protected by a site passcode. Access is granted by the GTS Box backend —
          this screen does not store anything on your device.
        </p>
      </form>
    </div>
  );
}
