/**
 * The GTS Algo Research brand mark.
 *
 * An abstract MARKET-STRUCTURE lattice, not a logo cliché: a square boundary, a faint
 * 3×3 grid of strike/expiry gridlines, and one solid centre cell — the at-the-money
 * cell the research is built around. It is deliberately not a candlestick, an arrow, a
 * currency glyph or a coin.
 *
 * DESIGN CONSTRAINTS THIS SATISFIES
 *   • Legible at 20px: at that size the grid recedes and what reads is "square with a
 *     solid centre", which is still a distinct silhouette.
 *   • Legible at 32px and above: the lattice resolves and the mark gains detail rather
 *     than needing a second asset.
 *   • Monochrome and `currentColor` only — no gradients, no fills that assume a light or
 *     a dark page, so one component serves both themes.
 *   • Pure inline SVG. No external image request, nothing to 404 behind a reverse proxy.
 *
 * `title` is optional: the mark is decorative next to a wordmark (so it is aria-hidden
 * by default) but can be given an accessible name when it stands alone.
 */

export interface GTSMarkProps {
  /** Rendered pixel size. The viewBox scales, so any size is valid. */
  size?: number;
  className?: string;
  /**
   * Accessible name. When omitted the mark is `aria-hidden` — correct whenever a text
   * wordmark sits beside it, because announcing the logo twice is noise.
   */
  title?: string;
}

export default function GTSMark({ size = 24, className = "", title }: GTSMarkProps) {
  // Decorative unless the caller gives it a name. Both attributes are always present so the
  // element's accessibility story is explicit rather than depending on a conditional spread.
  const decorative = title === undefined;
  return (
    <svg
      className={`gts-mark${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={title}
      focusable="false"
    >
      {/* The boundary. */}
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="2.5"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {/* The lattice. Held at a low opacity so it disappears gracefully at 20px
          instead of turning the mark into mush. */}
      <path
        d="M3 9.5h18M3 14.5h18M9.5 3v18M14.5 3v18"
        strokeWidth="1"
        opacity="0.4"
      />
      {/* The centre cell — the identity of the mark. */}
      <rect x="9.5" y="9.5" width="5" height="5" fill="currentColor" stroke="none" />
    </svg>
  );
}
