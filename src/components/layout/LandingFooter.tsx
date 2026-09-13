/**
 * The public site footer.
 *
 * Identity, location, ownership. No link list: there are no other public pages and no
 * external profiles to point at, and a footer full of dead links is worse than a short one.
 */

export default function LandingFooter() {
  return (
    <footer className="gts-site-footer">
      <div className="gts-site-footer-inner">
        <div className="gts-site-footer-identity">
          <span className="gts-site-footer-name">GTS Algo Research</span>
          <span className="gts-site-footer-line">Ghatsila · India</span>
          <span className="gts-site-footer-line">A BeOnEdge project</span>
        </div>
        <span className="gts-site-footer-copy">© GTS Algo Research</span>
      </div>
    </footer>
  );
}
