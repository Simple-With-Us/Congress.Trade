/**
 * LEGALCOMPLIANCE-04 / CT-1336: non-affiliation copy shared across web, iOS,
 * legal pages, and social (OG) share unfurls.  Keep strings identical everywhere
 * they appear so the disclaimer cannot drift.
 */

/** Full sentence in Terms of Service §1 and legal callouts. */
export const NOT_AFFILIATED_SENTENCE =
  'Congress.Trade is an independent, privately operated service and is not affiliated with, endorsed by, or sponsored by the U.S. Congress, the U.S. House of Representatives, the U.S. Senate, the Office of Government Ethics, or any government agency.';

/** Site-footer combined line (owner 2026-08-20).  Two spaces around each · and no trailing period. */
export const SITE_FOOTER_DISCLAIMER =
  'Congress.Trade  ·  educational tool for public STOCK Act (2012) disclosures  ·  not financial advice  ·  $ estimated from brackets  ·  independent/private service not affiliated with or endorsed/sponsored by any government agency';

/** Short line on rendered OG card art and appended to og:description / twitter:description. */
export const OG_SHARE_DISCLAIMER_LINE =
  'Not affiliated with the U.S. Congress or any government agency.';

const OG_SUFFIX = ` ${OG_SHARE_DISCLAIMER_LINE}`;

/** Append the share-card non-affiliation line once (idempotent). */
export function withOgShareDisclaimer(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return OG_SHARE_DISCLAIMER_LINE;
  if (trimmed.includes(OG_SHARE_DISCLAIMER_LINE)) return trimmed;
  return `${trimmed}${OG_SUFFIX}`;
}
