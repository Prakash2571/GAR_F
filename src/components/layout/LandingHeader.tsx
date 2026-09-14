/**
 * The public site header.
 *
 * Two things only: who this is, and the one way in. No navigation links, because there are
 * no other public pages — inventing a nav bar for a single page is how a small research site
 * starts looking like a marketing template.
 *
 * AND NO THEME TOGGLE. The public page is dark only — see LANDING_THEME in lib/theme.ts for
 * why. The control is not merely hidden: the page does not honour a light preference at all,
 * so offering a switch that appeared to do nothing would be worse than offering none. The
 * workspace header keeps its toggle.
 */

import GTSWordmark from "../brand/GTSWordmark.tsx";
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
        <Button variant="primary" onClick={onEnterBox} aria-busy={busy}>
          Enter Box
        </Button>
      </div>
    </header>
  );
}
