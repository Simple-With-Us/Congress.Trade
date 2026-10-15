/**
 * Open Graph / Twitter card meta for shareable deep links.
 *
 * Crawlers (Slack, iMessage, X, LinkedIn) only read server-rendered meta tags —
 * they do not execute the SPA. We pick the card image + title from the request
 * query string so sharing Trends / a company / a politician unfurls the right art.
 *
 * Query priority (first match wins):
 *   1. ?member=…  → politician card
 *   2. ?ticker=…  → company card
 *   3. ?trade=…   → trade card (SEOSOCIAL-05)
 *   4. ?view=trends → trends card
 *   5. ?view=trades|people|subs → that tab's card
 *   6. default home card
 */

import { OG_IMAGE_VERSION } from './assets.ts';
import { withOgShareDisclaimer } from './disclaimers.ts';

export type OgContext = 'default' | 'trends' | 'company' | 'politician' | 'trade';

export type OgMeta = {
  context: OgContext;
  /** og:title / twitter:title — deliberately WITHOUT a "— Congress.Trade"
   *  suffix (see the comment below); every unfurl already shows the site
   *  name above the title. */
  title: string;
  description: string;
  /** <title>/history/tab text — `title` WITH the "— Congress.Trade" suffix
   *  those surfaces need since nothing else on them shows the site name
   *  (SEOSOCIAL-04). Equal to `title` only for the bare default card. */
  pageTitle: string;
  /** Absolute page URL for og:url / canonical. */
  url: string;
  /** Absolute image URL including cache-bust query. */
  imageUrl: string;
  imageAlt: string;
};

export const SITE = 'https://congress.trade';
const DEFAULT_DESC = withOgShareDisclaimer(
  'We ingest and publish public House, Senate, and Executive Branch STOCK Act disclosures ourselves — a live financial-disclosure feed, not a wrapper around one third-party API.',
);

function imagePath(context: OgContext): string {
  switch (context) {
    case 'trends':
      return '/og-image-trends.png';
    case 'company':
    // SEOSOCIAL-05: no dedicated trade-card art exists yet ("later a dynamic
    // image" per the finding) — the company lockup is the closest fit since
    // a trade card is centered on an asset, same as the company card.
    case 'trade':
      return '/og-image-company.png';
    case 'politician':
      return '/og-image-politician.png';
    default:
      return '/og-image.png';
  }
}

function absImage(context: OgContext): string {
  return `${SITE}${imagePath(context)}?v=${OG_IMAGE_VERSION}`;
}

/** Escape text for use inside HTML attribute double-quotes. */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export type ResolveOgMetaOptions = {
  /** Optional display name for ?member= (resolved server-side from filers).
   *  SEOSOCIAL-06: a falsy value here means the id did NOT resolve to a real
   *  filer, so the politician card is skipped entirely — the raw query text
   *  is never echoed into og:title/og:description. */
  memberDisplayName?: string | null;
  /**
   * Optional seat descriptor for ?member=, already formatted by the caller —
   * a congressional seat (`D-CA-11`, `R-TX-Sen`) or an executive-branch
   * position (`President`, `Treasury Secretary`). Rendered in parentheses
   * after the name so a shared politician link identifies the office, not
   * just the person.
   */
  memberDistrict?: string | null;
  /**
   * Whether ?ticker= resolves to a real, traded security (SEOSOCIAL-06),
   * checked server-side against the securities/transactions tables before
   * this is called. An unresolved ticker falls back to the default card
   * instead of upper-casing and echoing arbitrary query text as a branded
   * company card — the same content-spoofing concern as memberDisplayName.
   */
  tickerResolved?: boolean;
  /**
   * Pre-formatted summary for ?trade=<id> (SEOSOCIAL-05), resolved and
   * formatted server-side from the transaction + its filer — null/absent
   * when the id doesn't resolve to a real disclosed trade, in which case
   * the permalink falls back through to member/ticker/view/default like any
   * other unresolved entity (SEOSOCIAL-06's same rule).
   */
  tradeSummary?: TradeShareSummary | null;
};

/** Everything a trade share card needs, already resolved + formatted by the
 *  caller (routes.ts) — this module stays DB-free. */
export type TradeShareSummary = {
  /** "Nancy Pelosi (D-CA-11)", or null when the filer didn't resolve — the
   *  card still renders, just without a name up front. */
  filerLabel: string | null;
  /** Past-tense verb — mirrors delivery/rest.ts's RSS feed wording. */
  verb: 'bought' | 'sold' | 'traded';
  /** Ticker if resolved, else a trimmed asset name, else "an asset". */
  assetLabel: string;
  /** Formatted STOCK Act disclosure bracket, e.g. "$1,001 - $15,000". */
  amountBracket: string;
  /** Formatted trade date, e.g. "Aug 5, 2026". */
  txDateLabel: string;
};

/** <title>/tab/history text needs the site name — nothing else on those
 *  surfaces shows it — while og:title/twitter:title deliberately omit it
 *  (see the priority comment below). Equal to `title` only for the bare
 *  default card, so the tab never reads "Congress.Trade — Congress.Trade". */
function pageTitleFor(title: string, isDefault: boolean): string {
  return isDefault ? title : `${title} — Congress.Trade`;
}

/**
 * Trim a caller-supplied seat descriptor down to something safe to render.
 *
 * The cap has to clear a real executive-branch position, not just a compact
 * congressional seat code: the longest curated title is 'Social Security
 * Commissioner' at 28 characters, and a 24-char limit silently truncated five
 * of them mid-word. 40 leaves headroom for the next cabinet title while still
 * refusing an unbounded string.
 */
function normalizeDistrict(raw: string | null | undefined): string {
  let s = (raw || '').trim();
  if (!s) return '';

  // Order matters. Unwrap a fully-parenthesised descriptor FIRST — "(R-TX-02)"
  // -> "R-TX-02" — but only when the parens wrap the whole string. A blanket
  // /^\(+|\)+$/ strip would eat the closing paren of 'U.S. Senator (PA)' and
  // leave an unbalanced 'U.S. Senator (PA' for the next step to miss.
  while (/^\([^()]*\)$/.test(s)) s = s.slice(1, -1).trim();

  // The descriptor is itself rendered inside parentheses, so a remaining
  // interior pair would nest: the curated title 'U.S. Senator (PA)' would
  // print as "David McCormick (U.S. Senator (PA))". Flatten it to a comma.
  s = s.replace(/\s*\(([^)]*)\)\s*/g, ', $1');

  // Anything left unbalanced is caller junk, not structure.
  s = s.replace(/^[(),\s]+|[(),\s]+$/g, '').trim();
  if (!s) return '';

  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}

/**
 * Resolve OG meta from a request URL (path + query). `origin` defaults to the
 * production site so crawlers always get absolute congress.trade image URLs.
 */
export function resolveOgMeta(
  requestUrl: string | URL,
  origin: string = SITE,
  opts: ResolveOgMetaOptions = {},
): OgMeta {
  const u = typeof requestUrl === 'string' ? new URL(requestUrl, origin) : new URL(requestUrl.toString());
  // Canonical share URLs always use the public production host (not localhost).
  const path = u.pathname === '/admin' ? '/' : u.pathname;
  const search = u.search || '';
  const pageUrl = `${SITE}${path === '/' ? '/' : path}${search}`;

  const member = (u.searchParams.get('member') || '').trim();
  const ticker = (u.searchParams.get('ticker') || '').trim().toUpperCase();
  const trade = (u.searchParams.get('trade') || '').trim();
  const view = (u.searchParams.get('view') || '').trim().toLowerCase();

  // Titles deliberately omit a `· Congress.Trade` suffix: every unfurl already
  // shows the site name above the title and the URL below it, so repeating it
  // spends the one line crawlers give us on something the reader can see twice.
  //
  // SEOSOCIAL-06: `member` and `ticker` are ARBITRARY, attacker-controlled
  // query text. Only a caller-confirmed DB match (memberDisplayName /
  // tickerResolved, both resolved server-side against filers/transactions
  // before this function runs) earns the branded politician/company card;
  // anything else falls straight through to the default card below rather
  // than echoing the raw text as this site's own og:title/og:description.
  if (member && opts.memberDisplayName) {
    const label = opts.memberDisplayName.trim();
    const district = normalizeDistrict(opts.memberDistrict);
    const heading = district ? `${label} (${district})` : label;
    return {
      context: 'politician',
      title: heading,
      pageTitle: pageTitleFor(heading, false),
      description: withOgShareDisclaimer(`Trading activity for ${heading} on Congress.Trade.`),
      url: pageUrl,
      imageUrl: absImage('politician'),
      imageAlt:
        'Congress.Trade lockup (CONGRESS eagle TRADE) above a "Politician profile" label ' +
        'and a stylised profile page showing disclosed buys and sells',
    };
  }

  if (ticker && opts.tickerResolved) {
    return {
      context: 'company',
      title: ticker,
      pageTitle: pageTitleFor(ticker, false),
      description: withOgShareDisclaimer(`Disclosed trades in ${ticker} on Congress.Trade.`),
      url: pageUrl,
      imageUrl: absImage('company'),
      imageAlt:
        'Congress.Trade lockup (CONGRESS eagle TRADE) above a "Company profile" label ' +
        'and a stylised company page showing buy versus sell volume',
    };
  }

  // SEOSOCIAL-05: the single most shareable object in the product — an
  // individual disclosed trade — previously fell through to the generic
  // home card. tradeSummary is null both when there's no ?trade= AND when
  // one was present but didn't resolve to a real transaction (same
  // SEOSOCIAL-06 fallback rule as member/ticker above).
  if (trade && opts.tradeSummary) {
    const s = opts.tradeSummary;
    const who = s.filerLabel ? `${s.filerLabel} ` : '';
    const verbCased = who ? s.verb : s.verb.charAt(0).toUpperCase() + s.verb.slice(1);
    const heading = `${who}${verbCased} ${s.assetLabel} (${s.amountBracket}) · ${s.txDateLabel}`;
    return {
      context: 'trade',
      title: heading,
      pageTitle: pageTitleFor(heading, false),
      description: withOgShareDisclaimer(
        `${who}${verbCased} ${s.assetLabel} for ${s.amountBracket}, disclosed ${s.txDateLabel} ` +
          'under the STOCK Act — Congress.Trade.',
      ),
      url: pageUrl,
      imageUrl: absImage('trade'),
      imageAlt:
        'Congress.Trade lockup (CONGRESS eagle TRADE) above a "Disclosed trade" label ' +
        'and a stylised buy/sell summary card',
    };
  }

  if (view === 'trends') {
    return {
      context: 'trends',
      title: 'Trends',
      pageTitle: pageTitleFor('Trends', false),
      description: withOgShareDisclaimer(
        'Trading trends — volume, consensus moves, sectors, and disclosure lag on Congress.Trade.',
      ),
      url: pageUrl,
      imageUrl: absImage('trends'),
      imageAlt:
        'Congress.Trade lockup (CONGRESS eagle TRADE) above a "Trends" label ' +
        'and a stylised buy/sell volume chart',
    };
  }

  // SEOSOCIAL-04: give the other public tabs their own <title>/description
  // too — previously only Trends (above) and the member/ticker deep links
  // had anything but the generic homepage copy. These reuse the default
  // lockup image (no dedicated per-view art exists yet); only the text
  // differs from the plain default card below.
  if (view === 'trades' || view === 'people' || view === 'subs') {
    const byView = {
      trades: {
        title: 'Trades',
        description:
          'Every disclosed House, Senate, and Executive Branch stock trade — filterable by member, ticker, and amount — on the Congress.Trade Trades tab.',
      },
      people: {
        title: 'Directory',
        description:
          'Every U.S. House, Senate, and Executive Branch filer disclosing stock trades, with trade counts — the Congress.Trade Directory.',
      },
      subs: {
        title: 'Delivery',
        description:
          'Email, push, and webhook alerts the moment a new congressional stock trade is disclosed — Congress.Trade Delivery.',
      },
    } as const;
    const { title, description } = byView[view];
    return {
      context: 'default',
      title,
      pageTitle: pageTitleFor(title, false),
      description: withOgShareDisclaimer(description),
      url: pageUrl,
      imageUrl: absImage('default'),
      imageAlt:
        'Congress.Trade lockup (CONGRESS, eagle mark, TRADE) on a white background above a ' +
        '"Congressional STOCK Act disclosures" label and a stylised dashboard of summary ' +
        'tiles and disclosed trades',
    };
  }

  return {
    context: 'default',
    title: 'Congress.Trade',
    pageTitle: pageTitleFor('Congress.Trade', true),
    description: DEFAULT_DESC,
    url: pageUrl.endsWith('?') ? SITE + '/' : pageUrl || `${SITE}/`,
    imageUrl: absImage('default'),
    imageAlt:
      'Congress.Trade lockup (CONGRESS, eagle mark, TRADE) on a white background above a ' +
      '"Congressional STOCK Act disclosures" label and a stylised dashboard of summary ' +
      'tiles and disclosed trades',
  };
}

/** Apply OG placeholders in the dashboard HTML template. */
export function applyOgMeta(html: string, meta: OgMeta): string {
  return html
    // SEOSOCIAL-04: the real <title>/meta description search engines, browser
    // tabs, history, and bookmarks show — previously a hardcoded literal
    // identical on every view/entity. escapeAttr is also safe as text-node
    // content (it only adds entity escapes HTML already tolerates verbatim).
    .split('%TITLE%').join(escapeAttr(meta.pageTitle))
    .split('%META_DESCRIPTION%').join(escapeAttr(meta.description))
    .split('%OG_TITLE%').join(escapeAttr(meta.title))
    .split('%OG_DESCRIPTION%').join(escapeAttr(meta.description))
    .split('%OG_URL%').join(escapeAttr(meta.url))
    .split('%OG_IMAGE%').join(escapeAttr(meta.imageUrl))
    .split('%OG_IMAGE_ALT%').join(escapeAttr(meta.imageAlt))
    .split('%TWITTER_TITLE%').join(escapeAttr(meta.title))
    .split('%TWITTER_DESCRIPTION%').join(escapeAttr(meta.description))
    .split('%TWITTER_IMAGE%').join(escapeAttr(meta.imageUrl))
    .split('%CANONICAL_URL%').join(escapeAttr(meta.url));
}
