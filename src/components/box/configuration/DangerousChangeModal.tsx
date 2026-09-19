/**
 * THE DANGEROUS-CHANGE CONFIRMATION.
 *
 * DELIBERATELY NOT "Are you sure?". A generic prompt trains an operator to dismiss it, and a dialog
 * that is always dismissed makes the one that mattered invisible. This one carries information the
 * operator did not already have: the old value, the new value, what widens as a result, and when it
 * takes effect.
 *
 * THIS IS NOT A SECURITY CONTROL, and the code must not read as though it were. The backend refuses a
 * widening while armed, refuses a raise past a deployment ceiling, and refuses a risk-increasing
 * change from a `trade`-role operator, whether or not this dialog was shown or confirmed. What the
 * dialog prevents is an operator changing a risk limit WITHOUT NOTICING — a different failure, and a
 * real one.
 *
 * All wording comes from `describeChange()` in src/lib/operatorConfig.ts, which is directly
 * unit-tested. Nothing here composes a sentence of its own, so the tested text is the text that
 * appears.
 *
 * `dismissible={!busy}` rather than a no-op `onClose`: while a write is in flight, Escape and a scrim
 * click must not appear to cancel something that is already at the backend.
 */

import Modal from "../../ui/Modal.tsx";
import Button from "../../ui/Button.tsx";
import type { ChangeSummary } from "../../../lib/operatorConfig.ts";

export function DangerousChangeModal({
  summary,
  busy,
  onConfirm,
  onCancel,
}: {
  /** Null when no confirmation is pending — the parent renders nothing. */
  summary: ChangeSummary | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (summary === null) return null;

  return (
    <Modal
      title={summary.riskIncreasing ? "Confirm a risk-increasing change" : "Confirm this change"}
      subtitle={summary.title}
      onClose={onCancel}
      dismissible={!busy}
      className="cfg-confirm-modal"
    >
      <div className="cfg-confirm">
        {/* THE TRANSITION, as the headline. An operator should not have to read prose to find out
            which direction the number is moving. */}
        <p
          className={`cfg-confirm-transition${
            summary.riskIncreasing ? " cfg-confirm-transition--risk" : ""
          }`}
        >
          <span className="cfg-confirm-old">{summary.oldLabel}</span>
          <span className="cfg-confirm-arrow" aria-hidden="true">
            {" → "}
          </span>
          <span className="cfg-confirm-new">{summary.newLabel}</span>
        </p>

        <p className="cfg-confirm-effect">{summary.effect}</p>
        <p className="cfg-confirm-when">{summary.when}</p>

        {summary.requiresFlat && (
          <p className="cfg-confirm-requires">
            This change requires the system to be flat and the live session disarmed. The backend
            refuses it otherwise.
          </p>
        )}

        {summary.requiresFullAdmin && (
          <p className="cfg-confirm-requires">
            Raising this requires full administrator access.
          </p>
        )}

        {summary.caveat !== null && <p className="cfg-confirm-caveat">{summary.caveat}</p>}

        <div className="cfg-confirm-actions">
          <Button variant="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={summary.riskIncreasing ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Saving…" : summary.riskIncreasing ? "Apply anyway" : "Apply"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
