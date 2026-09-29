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
} from "../../api/synth.ts";

type GateState = "checking" | "locked" | "unlocked";

export default function SynthAccessGate({ render }: { render: (lock: () => void) => ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    synthAccessStatus()
      .then((s) => !cancelled && setState(s.authenticated ? "unlocked" : "locked"))
      .catch(() => !cancelled && setState("locked"));
    const off = onSynthUnauthorized(() => setState("locked"));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

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
      setPasscode("");
      setState(s.authenticated ? "unlocked" : "locked");
    } catch (err) {
      setError(err instanceof SynthPasscodeRejectedError ? err.message : describeRequestFailure(err));
    } finally {
      setBusy(false);
    }
  }

  if (state === "unlocked") return <>{render(lock)}</>;
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
