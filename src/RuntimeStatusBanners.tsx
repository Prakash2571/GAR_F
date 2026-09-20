/**
 * Plain-language readiness banners for the Box dashboard — the RENDERER only.
 *
 * The derivation and, crucially, the WORDING live in `./lib/runtimeBanners.ts`. They were moved out
 * of this file so they can be asserted by `node:test`: Node's type-stripping loads `.ts` but not
 * `.tsx` (JSX needs a transform), so a sentence kept here is untestable without a renderer. One of
 * these sentences previously told operators that exits were unaffected by a PostgreSQL outage while
 * no reduction could reach the broker at all — a claim that must be pinned by a test, not reviewed
 * by eye. See tests/pgOutageBanner.test.mjs.
 */

import { buildRuntimeBanners, type RuntimeBannerInput } from "./lib/runtimeBanners.ts";

export type { Banner, RuntimeBannerInput } from "./lib/runtimeBanners.ts";
export { buildRuntimeBanners } from "./lib/runtimeBanners.ts";

export function RuntimeStatusBanners(props: RuntimeBannerInput) {

  const banners = buildRuntimeBanners(props);
  if (banners.length === 0) return null;

  return (
    <>
      {banners.map((b) => (
        <div key={b.key} className={`banner banner--${b.kind}`}>
          {b.text}
        </div>
      ))}
    </>
  );
}
