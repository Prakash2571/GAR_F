/**
 * The synthetic workspace's own gate. gts-synth runs its own passcode → session → CSRF, so
 * this page asks for ITS passcode and knows nothing of any other session in the app.
 *
 * States: checking (probe /access/status) → locked (passcode form) → unlocked (workspace).
 * A 401 from any synth call (`onSynthUnauthorized`) drops back to locked, which unmounts the
 * workspace and, with it, its stream.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Button from "../ui/Button.tsx";
import GTSWordmark from "../brand/GTSWordmark.tsx";
import { describeRequestFailure } from "../../api/http.ts";
import {
  SynthPasscodeRejectedError,
  onSynthUnauthorized,
  synthAccessStatus,
  synthLogout,
  synthVerify,
  type SynthAccessRole,
  type SynthAccessStatus,
} from "../../api/synth.ts";

type GateState = "checking" | "locked" | "unlocked";

export default function SynthAccessGate({ render }: { render: (lock: () => void, role: SynthAccessRole | undefined) => ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [session, setSession] = useState<SynthAccessStatus | null>(null);
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    synthAccessStatus()
      .then((s) => {
        if (cancelled) return;
        setSession(s);
        setState(s.authenticated ? "unlocked" : "locked");
      })
      .catch(() => !cancelled && setState("locked"));
    const off = onSynthUnauthorized(() => setState("locked"));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // A role can be changed or revoked server-side while this page is open. The
  // backend checks every request; refresh the displayed controls too.
  useEffect(() => {
    if (state !== "unlocked") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void synthAccessStatus().then((s) => {
        if (cancelled) return;
        setSession(s);
        if (!s.authenticated) setState("locked");
      }).catch(() => {
        if (!cancelled) setSession(null);
      });
    }, 60000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [state]);

  const lock = useCallback(() => {
    void synthLogout().finally(() => setState("locked"));
  }, []);

  async function unlock(e: { preventDefault: () => void }) {
    e.preventDefault();
    if (!passcode) return;
    setBusy(true);
    setError(null);
    try {
      const s = await synthVerify(passcode);
      setSession(s);
      setPasscode("");
      setState(s.authenticated ? "unlocked" : "locked");
    } catch (err) {
      setError(err instanceof SynthPasscodeRejectedError ? err.message : describeRequestFailure(err));
    } finally {
      setBusy(false);
    }
  }

  if (state === "unlocked") return <>{render(lock, session?.role)}</>;
  if (state === "checking") {
    return (
      <div className="synth-gate">
        <span className="spinner" aria-label="Checking the session" />
      </div>
    );
  }
  return (
    <div className="synth-gate">
      <form className="synth-gate-card" onSubmit={(e) => void unlock(e)}>
        <GTSWordmark variant="product" markSize={20} subtitle={<span>Synthetic arbitrage</span>} />
        <p className="synth-dim">Enter the passcode of the synthetic workspace.</p>
        <input
          className="synth-input"
          type="password"
          autoComplete="current-password"
          aria-label="Passcode"
          value={passcode}
          disabled={busy}
          onChange={(e) => setPasscode(e.target.value)}
        />
        {error && <div className="banner banner--error">{error}</div>}
        <Button type="submit" variant="primary" disabled={busy || !passcode}>
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
    </div>
  );
}
