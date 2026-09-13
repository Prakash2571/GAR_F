/**
 * The public site header.
 *
 * Two things only: who this is, and the one way in. No navigation links, because there are
 * no other public pages — inventing a nav bar for a single page is how a small research site
 * starts looking like a marketing template.
 */

import GTSWordmark from "../brand/GTSWordmark.tsx";
import ThemeToggle from "../../ThemeToggle.tsx";
import Button from "../ui/Button.tsx";

export interface LandingHeaderProps {
  onEnterBox: () => void;
  /**
   * True while the session state is still unknown. The CTA stays enabled — it does the right
   * thing either way — but says so, rather than silently doing nothing on the first click.
   */
  busy?: boolean;
}

export default function LandingHeader({ onEnterBox, busy = false }: LandingHeaderProps) {
  return (
    <header className="gts-site-header">
      <a className="gts-site-brand" href="/" aria-label="GTS Algo Research — home">
        <GTSWordmark variant="full" markSize={22} />
      </a>
      <div className="gts-site-header-actions">
        <ThemeToggle />
        <Button variant="primary" onClick={onEnterBox} aria-busy={busy}>
          Enter Box
        </Button>
      </div>
    </header>
  );
}
