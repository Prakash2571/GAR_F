/**
 * The button primitive.
 *
 * Always a real `<button>` with an explicit `type` — never a styled `<div>` — so it is
 * keyboard-activatable, focusable, announced as a button, and (for `type="submit"`) wired
 * to its form's Enter-key submission for free.
 *
 * Variants map to intent, not to colour:
 *   primary   the one affirmative action on a surface
 *   secondary a neutral action (the default)
 *   quiet     a low-emphasis toolbar action
 *   danger    a destructive or exposure-changing action, deliberately visually separated
 *             from ordinary controls so it is harder to press by accident
 */

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width (dialog actions, narrow columns). */
  full?: boolean;
}

export default function Button({
  variant = "secondary",
  size = "md",
  full = false,
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    "btn",
    variant !== "secondary" ? `btn--${variant}` : "",
    size === "sm" ? "btn--sm" : "",
    full ? "btn--full" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...rest} />;
}
