/**
 * The GTS Box mark.
 *
 * It draws the instrument, not a logo: two full-height rails are the two strikes K1 < K2, and
 * the solid bar spanning them is the box itself — which settles at the strike width wherever
 * the underlying ends up. The short ticks entering from each side are the underlying crossing
 * a payoff that does not depend on it. That is the entire thesis of the product in 24px.
 *
 * Deliberately stroked in `currentColor` on a transparent ground, so the mark inherits the
 * theme instead of carrying a hardcoded brand fill. The container supplies the quiet bordered
 * surface (see `.brand-mark` in styles.css) — this is an instrument face, not an app chiclet.
 */
export default function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-mark${className ? ` ${className}` : ""}`} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* the two strikes */}
        <path d="M7 2.5v19M17 2.5v19" opacity="0.5" />
        {/* the box: fixed value = K2 − K1 */}
        <rect x="7" y="8.5" width="10" height="7" rx="1" fill="currentColor" stroke="none" />
        {/* the underlying, which the payoff ignores */}
        <path d="M2.5 12H7M17 12h4.5" opacity="0.5" />
      </svg>
    </span>
  );
}
