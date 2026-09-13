/**
 * The one dialog primitive.
 *
 * It exists so every overlay in the app gets the same keyboard and screen-reader
 * behaviour instead of each one re-implementing (and forgetting) part of it:
 *
 *   • `role="dialog"` + `aria-modal` + a programmatic `aria-labelledby`, so assistive
 *     technology announces the dialog and its title.
 *   • Escape closes — the standard way out of a dialog.
 *   • A click on the scrim closes; a click inside never does (the handler checks the
 *     event target is the scrim itself, so a drag that ends outside a control does not
 *     dismiss the dialog).
 *   • Focus is MOVED into the dialog on open and RESTORED to the element that opened it
 *     on close, so keyboard focus is never dumped back at the top of the document.
 *   • Focus is TRAPPED: Tab and Shift+Tab cycle within the dialog, so a keyboard user
 *     cannot tab into the inert page behind it.
 *   • Background scroll is locked while it is open.
 *
 * Escape and scrim dismissal can be disabled (`dismissible={false}`) for a dialog that
 * must not be closed accidentally mid-operation.
 */

import { useCallback, useEffect, useId, useRef } from "react";

export interface ModalProps {
  /** Dialog title. Rendered as the heading AND used as the accessible name. */
  title: string;
  /** Optional line under the title. */
  subtitle?: React.ReactNode;
  onClose: () => void;
  /** When false, Escape and scrim clicks do NOT close. Default true. */
  dismissible?: boolean;
  /** Extra class on the dialog surface, for size/variant. */
  className?: string;
  children: React.ReactNode;
}

/** Everything focusable, in DOM order, for the focus trap. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function Modal({
  title,
  subtitle,
  onClose,
  dismissible = true,
  className = "",
  children,
}: ModalProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const subtitleId = useId();

  /**
   * Restore focus on unmount.
   *
   * Captured in a ref at mount rather than read at unmount: by then the opener may have
   * been re-rendered and `document.activeElement` is whatever the browser fell back to.
   */
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // Only restore if the opener is still in the document; focusing a detached node throws
      // away focus entirely.
      const opener = openerRef.current;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  // Move focus into the dialog. The first focusable element is the right target for a form
  // dialog (it is the input the user came here to fill in); the surface itself is the
  // fallback for a dialog with no controls.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const first = surface.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? surface).focus();
  }, []);

  // Lock background scroll for as long as the dialog is open, restoring the previous value
  // rather than assuming it was "" (nested dialogs, or a page that sets its own overflow).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // Focus trap. Without it, Tab from the last control walks into the page behind the
      // scrim, which is visually inert but still reachable by keyboard.
      const surface = surfaceRef.current;
      if (!surface) return;
      const focusable = [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [dismissible, onClose],
  );

  return (
    <div
      className="gts-scrim"
      // Only a click that STARTS and ENDS on the scrim itself dismisses; a click that
      // originated inside the dialog bubbles here with a different target.
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={surfaceRef}
        className={`gts-dialog${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(subtitle !== undefined ? { "aria-describedby": subtitleId } : {})}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="gts-dialog-head">
          <h2 className="gts-dialog-title" id={titleId}>
            {title}
          </h2>
          {subtitle !== undefined && (
            <p className="gts-dialog-sub" id={subtitleId}>
              {subtitle}
            </p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
