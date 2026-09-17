/**
 * THE OPERATOR BLOCKLIST — underlyings the engine must never ENTER.
 *
 * This is the only control on the page that can make the system trade LESS by name. Everything else
 * is a threshold or a mode; this is "not this one, not today".
 *
 * Three things this component is careful about, because getting any of them wrong would make a safety
 * control read as decoration:
 *
 * 1. `readable: false` IS AN ALARM, NOT AN EMPTY LIST. When the backend cannot read the durable
 *    blocklist it refuses EVERY new entry, because a list it cannot read cannot confirm that any name
 *    is permitted. Rendering that state as "no exclusions" would tell the operator the opposite of
 *    what is happening, so it gets a loud banner and the list is not presented as authoritative.
 *
 * 2. AN EXCLUSION NEVER TRAPS A POSITION, and the copy says so. A box already open on an excluded
 *    name keeps streaming, keeps being monitored and still exits. Operators hesitate over a control
 *    they think might strand exposure, so the guarantee is stated where the decision is made rather
 *    than in a doc.
 *
 * 3. THE LIST IS SERVER STATE, THE INPUT IS LOCAL STATE. This page re-renders several times a second
 *    off the SSE snapshot; binding the symbol field to anything derived from `status` would fight
 *    every keystroke. Same reasoning as BoxGates.
 */

import { useState } from "react";
import {
  excludeUnderlying,
  includeUnderlying,
  type BoxExcludedUnderlyings,
} from "./api";

/** Mirrors the backend's own bound (MAX_EXCLUSION_REASON_LENGTH) so the field cannot over-type. */
const MAX_REASON = 280;

/**
 * What the backend will accept, so an obviously-bad symbol is refused before a round trip.
 *
 * `&` is deliberately allowed: `M&M` and `M&MFIN` are real NSE underlyings, and a naive `A-Z0-9`
 * pattern would silently reject exactly the names an operator is most likely to exclude during a
 * corporate action.
 */
const SYMBOL_PATTERN = /^[A-Za-z0-9&\-_]{1,32}$/;

function fmtWhen(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "—";
  return new Date(at).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

export function BoxExclusions({
  blocklist,
  canTrade,
  isFullAdmin,
  onChanged,
}: {
  /** From `status.excluded_underlyings`, so this panel needs no request of its own to render. */
  blocklist: BoxExcludedUnderlyings | undefined;
  canTrade: boolean;
  isFullAdmin: boolean;
  /** Hand the authoritative post-write list back to the page. */
  onChanged: (next: BoxExcludedUnderlyings) => void;
}) {
  const [symbol, setSymbol] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!canTrade) return null;

  const excluded = blocklist?.excluded ?? [];
  const trimmed = symbol.trim().toUpperCase();
  const symbolValid = SYMBOL_PATTERN.test(trimmed);
  const alreadyListed = excluded.some((e) => e.symbol === trimmed);
  const atCap = blocklist !== undefined && !alreadyListed && excluded.length >= blocklist.max;
  const writable = isFullAdmin && (blocklist?.persistent ?? false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!symbolValid) {
      setError("Enter one underlying name — letters, digits, &, - or _ (for example NIFTY or M&M).");
      return;
    }
    setBusy(trimmed);
    setError(null);
    setNote(null);
    try {
      const next = await excludeUnderlying(trimmed, reason.trim() === "" ? undefined : reason.trim());
      onChanged(next);
      setSymbol("");
      setReason("");
      setNote(
        `${trimmed} will not be entered in any execution mode. Any box already open on it is still ` +
          `monitored and will still exit.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to exclude ${trimmed}.`);
    } finally {
      setBusy(null);
    }
  }

  async function remove(sym: string) {
    setBusy(sym);
    setError(null);
    setNote(null);
    try {
      const next = await includeUnderlying(sym);
      onChanged(next);
      setNote(`${sym} is tradable again — the normal entry gates apply to it from the next evaluation.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to re-include ${sym}.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="box-exclusions">
      <header className="box-exclusions-h">
        <span>Excluded underlyings</span>
        <span className="pill-count">{excluded.length}</span>
        {blocklist !== undefined && !blocklist.readable && (
          <span className="box-exec-badge box-exec-badge--danger">ENTRY REFUSED</span>
        )}
      </header>

      <p className="box-exclusions-sub">
        Never enter a new box on these names — in <strong>every</strong> execution mode, paper and
        live. Exits, reductions and protective cancels are never affected, so excluding a name cannot
        trap a position that is already open.
      </p>

      {/*
        THE FAIL-CLOSED STATE, FIRST AND LOUDEST. This is not "there are no exclusions" — it is "the
        backend is refusing all new entry because it cannot tell which names are allowed".
      */}
      {blocklist !== undefined && !blocklist.readable && (
        <p className="box-exclusions-msg box-exclusions-msg--error">
          The blocklist could not be read{blocklist.error === null ? "" : ` — ${blocklist.error}`}. No
          new box is being entered, because a list that cannot be read cannot confirm any name is
          tradable. Exits and protective cancels still work, and the backend retries the read
          automatically.
        </p>
      )}

      {blocklist !== undefined && !blocklist.persistent && (
        <p className="box-exclusions-msg box-exclusions-msg--warn">
          This deployment has no box persistence, so an exclusion cannot be saved and is refused
          rather than accepted and lost on the next restart. Nothing is being forgotten — no exclusion
          could ever have been stored.
        </p>
      )}

      {excluded.length === 0 ? (
        <p className="box-exclusions-empty">
          Nothing is excluded. Every underlying in the universe is eligible, subject to the normal
          gates.
        </p>
      ) : (
        <ul className="box-exclusions-list">
          {excluded.map((e) => (
            <li key={e.symbol} className="box-exclusions-item">
              <span className="box-exclusions-sym">{e.symbol}</span>
              <span className="box-exclusions-why">
                {e.reason ?? <em className="box-dim">no reason recorded</em>}
              </span>
              <span className="box-exclusions-meta box-dim">
                {fmtWhen(e.excluded_at)}
                {e.excluded_by === null ? "" : ` · ${e.excluded_by}`}
              </span>
              {writable && (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy !== null}
                  title={`Allow new boxes on ${e.symbol} again. This does not open anything by itself — the normal gates still apply.`}
                  onClick={() => void remove(e.symbol)}
                >
                  {busy === e.symbol ? "Removing…" : "Allow"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {writable ? (
        <form className="box-exclusions-form" onSubmit={(e) => void add(e)}>
          <label className="box-exclusions-field">
            <span className="box-exclusions-k">Underlying</span>
            <input
              value={symbol}
              onChange={(ev) => setSymbol(ev.target.value)}
              placeholder="NIFTY"
              maxLength={32}
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy !== null}
              aria-invalid={symbol.trim() !== "" && !symbolValid}
            />
          </label>
          <label className="box-exclusions-field box-exclusions-field--wide">
            <span className="box-exclusions-k">Reason (optional)</span>
            <input
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              placeholder="ban period · illiquid strikes · corporate action"
              maxLength={MAX_REASON}
              disabled={busy !== null}
            />
          </label>
          <button
            className="btn btn--primary btn--sm"
            type="submit"
            disabled={busy !== null || !symbolValid || atCap}
            title={
              atCap
                ? `At most ${blocklist?.max} underlyings may be excluded.`
                : `Refuse every new box on ${trimmed === "" ? "this underlying" : trimmed}`
            }
          >
            {busy !== null && busy === trimmed ? "Excluding…" : alreadyListed ? "Update reason" : "Exclude"}
          </button>
        </form>
      ) : (
        <p className="box-exclusions-note box-dim">
          {isFullAdmin
            ? "The blocklist cannot be edited while box persistence is unavailable."
            : "Full administrator access is required to change the blocklist."}
        </p>
      )}

      {atCap && (
        <p className="box-exclusions-msg box-exclusions-msg--warn">
          The blocklist is full ({blocklist?.max}). A deny list this large is better expressed as a
          narrower universe.
        </p>
      )}
      {error && <p className="box-exclusions-msg box-exclusions-msg--error">{error}</p>}
      {note && !error && <p className="box-exclusions-msg box-exclusions-msg--ok">{note}</p>}
    </section>
  );
}
