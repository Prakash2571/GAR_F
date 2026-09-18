/**
 * PRE-RUN CONFIRMATION — what is about to be watched, and what will not be.
 *
 * WHY RUN NEEDS A DIALOG AT ALL
 *
 * RUN used to be an obvious, cheap action: with one configured underlying there was nothing to check.
 * Watching the whole F&O universe changes that. The set of names that will be considered is now a
 * decision with roughly two hundred parts, and it is only visible if the operator went looking for it
 * in another tab. This puts the answer in front of the one gesture that acts on it.
 *
 * IT CONFIRMS, IT DOES NOT GATE. Every real refusal lives in the backend — readiness blockers, the
 * arm verdict, the blocklist, the quantity envelope. A frontend dialog that blocked RUN would be a
 * second, weaker copy of authority that already exists elsewhere and would drift from it. So this
 * only ever informs and asks; the only thing it can do is not proceed.
 *
 * ASYMMETRIC BY DESIGN: only STARTING is confirmed. Stopping stays instant, because a dialog in front
 * of the control that reduces activity is exactly the wrong place for friction.
 *
 * The three facts it goes out of its way to surface are the ones that are otherwise silent:
 *   - `blocked_by_caps` — names that are not excluded and still cannot trade. They look enabled.
 *   - `blocklist_readable: false` — the backend is refusing all entry; RUN will scan and never enter.
 *   - `built: false` — no universe pass yet, so the counts are not yet meaningful.
 */

import { useEffect, useRef, useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { fetchBoxUniverse, type BoxUniverse } from "../../api";
import type { ModeLabel } from "../../lib/honestLabels.ts";

export function RunConfirm({
  mode,
  busy,
  onConfirm,
  onCancel,
}: {
  /**
   * THE BACKEND'S OWN EXECUTION MODE, via `modeLabel(status.execution_mode)`.
   *
   * WAS `live: boolean`, AND WAS BEING HANDED THE SSE CONNECTION STATE.
   *
   * `Box.tsx` has two unrelated things that could be called "live": `headerMode.live` (the engine is
   * in a live EXECUTION MODE) and `live` (the SSE stream is currently CONNECTED — its own prop doc in
   * BoxHeader says "Presentation only — NOT evidence of tradability"). This dialog was passed the
   * second one, so its headline tracked the stream socket instead of the execution mode:
   *
   *   stream connected, paper engine  → "LIVE mode — entered with REAL orders"  (false alarm)
   *   stream dropped, LIVE engine     → "Paper simulation — no order reaches any broker"
   *
   * The second line is the one that matters. A genuinely live deployment whose stream had blipped
   * would tell the operator, in the confirmation dialog for the button that starts automated entry,
   * that nothing reaches the broker. A reassurance derived from a socket is not a safety property.
   *
   * Taking the whole `ModeLabel` rather than a boolean also means the paper claim can be gated on
   * `known`, so an unreported mode is stated as unknown instead of being rendered as paper.
   */
  mode: ModeLabel;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [universe, setUniverse] = useState<BoxUniverse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus CANCEL. A stray Enter should not start a scanner that may place real orders.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  useEffect(() => {
    let cancelled = false;
    fetchBoxUniverse()
      .then((u) => {
        if (!cancelled) setUniverse(u);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not read the tradable universe.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const s = universe?.summary ?? null;

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div
        className="modal modal--sm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="box-run-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2 id="box-run-title">Start scanning?</h2>
            {/* THREE states, not two. "Not live" and "unknown" must never share a sentence: only a
                CONFIRMED paper mode earns the words "no order reaches any broker", and the paper
                mode is NAMED because paper_legging and paper_touch model different executions. */}
            <p className={mode.live || !mode.known ? "modal-sub is-warn" : "modal-sub"}>
              {mode.live
                ? "LIVE mode — qualifying boxes are entered with REAL orders."
                : mode.known
                  ? `Paper simulation (${mode.badge.replace(/^paper — /, "")}) — no order reaches any broker.`
                  : "Execution mode UNKNOWN — the backend has not reported it. Do not assume this is paper."}
            </p>
          </div>
          <button
            type="button"
            className="modal-x"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
          >
            <XIcon size={18} weight="regular" aria-hidden="true" />
          </button>
        </header>

        <div className="modal-body confirm-modal-body">
          {error !== null && (
            <p className="box-exclusions-msg box-exclusions-msg--warn">
              {error} You can still start — the backend, not this dialog, decides what may be entered.
            </p>
          )}

          {s !== null && (
            <>
              <dl className="box-universe-stats box-run-stats">
                <div>
                  <dt>Will be considered</dt>
                  <dd>{s.watchable}</dd>
                </div>
                <div>
                  <dt>You excluded</dt>
                  <dd>{s.excluded}</dd>
                </div>
                <div className={s.blocked_by_caps > 0 ? "is-warn" : undefined}>
                  <dt>Cannot trade</dt>
                  <dd>{s.blocked_by_caps}</dd>
                </div>
                <div>
                  <dt>In the board</dt>
                  <dd>{s.total}</dd>
                </div>
              </dl>

              <ul className="box-delete-effects">
                <li>
                  <strong>{s.watchable}</strong> underlying{s.watchable === 1 ? "" : "s"} will be
                  observed and may be entered, subject to every gate and the inventory ceiling.
                </li>
                {s.excluded > 0 && (
                  <li>
                    <strong>{s.excluded}</strong> excluded name{s.excluded === 1 ? "" : "s"} will not
                    be entered in any mode. Boxes already open on them still exit normally.
                  </li>
                )}
                {s.blocked_by_caps > 0 && (
                  <li className="box-run-warn">
                    <strong>{s.blocked_by_caps}</strong> name{s.blocked_by_caps === 1 ? "" : "s"} you
                    have <em>not</em> excluded cannot trade under the current quantity caps — every
                    entry is refused before the first leg is sent. Exclude them in the Universe tab so
                    the caps and the blocklist agree.
                  </li>
                )}
                {universe !== null && !universe.blocklist_readable && (
                  <li className="box-run-warn">
                    The blocklist cannot be read, so the backend is refusing <strong>every</strong> new
                    entry. Scanning will run and nothing will be entered.
                  </li>
                )}
                {universe !== null && !universe.built && (
                  <li className="box-run-warn">
                    No universe pass has completed yet, so these counts are not final.
                  </li>
                )}
              </ul>
            </>
          )}

          {s === null && error === null && <p className="box-dim">Reading the universe…</p>}

          <p className="box-dim">
            To change what is watched, cancel and use <strong>Controls → Universe</strong>.
          </p>

          <div className="modal-actions">
            <button className="btn modal-action" ref={cancelRef} onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn btn--primary modal-action"
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? "Starting…" : "Start scanning"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
