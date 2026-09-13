/**
 * The GTS Algo Research wordmark: the mark plus its text lockup.
 *
 * THREE VARIANTS, ONE COMPONENT — so the brand can never drift between surfaces:
 *   "full"    GTS + "GTS Algo Research"       — the public landing header.
 *   "product" GTS + "GTS Box" + a subtitle    — the protected trading workspace header.
 *   "short"   GTS only                         — tight spaces (a modal head, a footer).
 *
 * The text is real text, not an image: it is selectable, searchable, scales with the
 * user's font settings and needs no separate asset per theme.
 */

import GTSMark from "./GTSMark.tsx";

export type GTSWordmarkVariant = "full" | "product" | "short";

export interface GTSWordmarkProps {
  variant?: GTSWordmarkVariant;
  /** Mark size in px. Text scales from CSS, not from this. */
  markSize?: number;
  /**
   * Secondary line under the product name. Only read for `variant="product"`.
   * Supplied by the caller because on the Box header it is DERIVED from the backend's
   * execution mode and must not be a hardcoded claim about what the server is doing.
   */
  subtitle?: React.ReactNode;
  className?: string;
}

export default function GTSWordmark({
  variant = "full",
  markSize = 22,
  subtitle,
  className = "",
}: GTSWordmarkProps) {
  return (
    <span className={`gts-wordmark gts-wordmark--${variant}${className ? ` ${className}` : ""}`}>
      <GTSMark size={markSize} />
      {variant === "short" ? (
        <span className="gts-wordmark-short">GTS</span>
      ) : variant === "product" ? (
        <span className="gts-wordmark-text">
          <span className="gts-wordmark-name">GTS Box</span>
          {subtitle !== undefined && <span className="gts-wordmark-sub">{subtitle}</span>}
        </span>
      ) : (
        <span className="gts-wordmark-text">
          <span className="gts-wordmark-name">
            <span className="gts-wordmark-lead">GTS</span> Algo Research
          </span>
        </span>
      )}
    </span>
  );
}
