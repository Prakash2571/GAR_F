/**
 * A status badge.
 *
 * NEVER COLOUR ALONE. Every badge renders a text LABEL, and a glyph shape that differs per
 * tone, so the state is legible to a colour-blind operator, in a monochrome screenshot, and
 * to a screen reader. Colour is reinforcement, not the signal — which matters more here than
 * on a normal page, because these badges report trading readiness and execution mode.
 *
 * `tone` is presentation. It must always be DERIVED from backend state by the caller; this
 * component never infers a status of its own.
 */

export type StatusTone = "neutral" | "positive" | "warning" | "negative" | "info" | "live";

/**
 * A distinct glyph per tone, so two badges are distinguishable with colour removed.
 * Purely decorative: the adjacent label is the accessible text.
 */
const GLYPH: Record<StatusTone, string> = {
  neutral: "\u25CB", // ○ hollow — nothing asserted
  positive: "\u25CF", // ● solid — good
  warning: "\u25B2", // ▲ triangle — attention
  negative: "\u25A0", // ■ square — blocked
  info: "\u25C6", // ◆ diamond — informational
  live: "\u25CF", // ● solid, but styled distinctly — real money
};

export interface StatusBadgeProps {
  tone?: StatusTone;
  /** The visible, screen-reader-readable state text. Required — colour is never the signal. */
  children: React.ReactNode;
  /** Longer explanation on hover / as the accessible description. */
  title?: string;
  /**
   * When true the badge is announced as a live region, so a screen reader hears a change of
   * state without the user having to go looking for it. Use for readiness and execution
   * mode; do not use for static labels, which would make the page chatty.
   */
  announce?: boolean;
  className?: string;
}

export default function StatusBadge({
  tone = "neutral",
  children,
  title,
  announce = false,
  className = "",
}: StatusBadgeProps) {
  return (
    <span
      className={`gts-badge gts-badge--${tone}${className ? ` ${className}` : ""}`}
      {...(title !== undefined ? { title } : {})}
      {...(announce ? { role: "status" as const } : {})}
    >
      <span className="gts-badge-glyph" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      <span className="gts-badge-label">{children}</span>
    </span>
  );
}
