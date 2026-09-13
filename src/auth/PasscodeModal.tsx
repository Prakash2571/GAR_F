/**
 * The "Enter GTS Box" passcode dialog.
 *
 * The only place a passcode is ever typed. It posts to `POST /api/access/verify` and, on
 * success, the backend sets an HttpOnly session cookie — this component never receives,
 * stores or forwards a session token.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   • It does not persist the passcode. The value lives in React state for the duration of
 *     one submit and is cleared immediately on success. No localStorage, no sessionStorage,
 *     no form autofill hint beyond the browser's own `current-password`.
 *   • It does not reveal whether a passcode is configured on the server, how many attempts
 *     have failed, or anything about the backend, its database or its configuration. A
 *     rejected passcode always renders exactly "Invalid passcode" (the backend also answers
 *     an identical body whether the passcode was wrong or no secret is set at all).
 *   • It does not distinguish a wrong passcode from an operational failure by guessing at
 *     prose: `verifyPasscode` throws a typed `PasscodeRejectedError` only for a 401, so a
 *     429 or 503 surfaces the backend's own generic message instead of being mislabelled.
 *
 * KEYBOARD AND FOCUS are handled by `<Modal>` (Escape to close, focus moved in and restored
 * on close, focus trapped) plus a real `<form>`, which gives Enter-to-submit for free.
 */

import { useCallback, useRef, useState } from "react";
import Modal from "../components/ui/Modal.tsx";
import Button from "../components/ui/Button.tsx";
import { PasscodeRejectedError } from "../api/access.ts";
import { useAccess } from "./AccessGate.tsx";

export interface PasscodeModalProps {
  onClose: () => void;
  /** Called after a session has been established. Navigates to the workspace. */
  onAuthenticated: () => void;
}

export default function PasscodeModal({ onClose, onAuthenticated }: PasscodeModalProps) {
  const { verify } = useAccess();
  const [passcode, setPasscode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Synchronous double-submit guard.
   *
   * `disabled={submitting}` alone is not enough: two Enter keypresses in the same frame both
   * read `submitting === false` from their render closure and both fire. A ref is claimed
   * synchronously, before React re-renders.
   */
  const inFlight = useRef(false);

  const onSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (inFlight.current) return;
      const candidate = passcode;
      if (candidate.trim() === "") return;
      inFlight.current = true;
      setSubmitting(true);
      setError(null);
      try {
        const ok = await verify(candidate);
        if (ok) {
          // Clear the passcode from memory the instant it is no longer needed. It was never
          // persisted — the session is the HttpOnly cookie the backend just set.
          setPasscode("");
          onAuthenticated();
          return;
        }
        setError("Invalid passcode");
      } catch (err) {
        if (err instanceof PasscodeRejectedError) {
          // ONE fixed string. Nothing about the server, the secret or the attempt count.
          setError("Invalid passcode");
        } else {
          // An operational failure (rate limited, access temporarily unavailable, network
          // down). The backend's own messages are already generic and secret-free.
          setError(
            err instanceof Error && err.message
              ? err.message
              : "Could not verify the passcode. Please try again.",
          );
        }
        // Keep focus on the field so a retry needs no mouse.
        inputRef.current?.focus();
        inputRef.current?.select();
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    },
    [passcode, verify, onAuthenticated],
  );

  return (
    <Modal
      title="Enter GTS Box"
      subtitle="Private algorithmic trading workspace"
      onClose={onClose}
      // Not dismissible mid-verify: closing the dialog while the request is in flight would
      // leave the session established with the UI still on the public page.
      dismissible={!submitting}
      className="gts-dialog--passcode"
    >
      <form className="gts-passcode-form" onSubmit={(event) => void onSubmit(event)}>
        <div className="gts-field">
          <label className="gts-field-label" htmlFor="gts-passcode">
            Passcode
          </label>
          <input
            ref={inputRef}
            id="gts-passcode"
            name="passcode"
            type="password"
            className="gts-field-input"
            value={passcode}
            onChange={(event) => setPasscode(event.target.value)}
            autoComplete="current-password"
            // `autoFocus` is intentional here and is not the anti-pattern it is on a page:
            // this dialog exists solely to receive this one value, and <Modal> would move
            // focus to this same first control anyway.
            autoFocus
            disabled={submitting}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? "gts-passcode-error" : undefined}
            spellCheck={false}
          />
        </div>

        {/* A live region, so the rejection is announced rather than only seen. Present in the
            DOM even when empty so the announcement fires on content change. */}
        <p className="gts-field-error" id="gts-passcode-error" role="alert">
          {error ?? ""}
        </p>

        <div className="gts-dialog-actions">
          <Button variant="quiet" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={submitting || passcode.trim() === ""}
            aria-busy={submitting}
          >
            {submitting ? "Verifying…" : "Continue"}
          </Button>
        </div>

        <p className="gts-passcode-note">
          Access is granted by the GTS Algo Research backend. Nothing is stored on this device.
        </p>
      </form>
    </Modal>
  );
}
