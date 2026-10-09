/**
 * src/ui/legalHtml.ts
 * Static legal pages served at /terms-of-service and /privacy-policy.
 *
 * These satisfy Stripe's requirement that a publicly accessible Terms of Service
 * and Privacy Policy be linkable from Checkout (Public/Checkout settings). They
 * are good-faith templates tailored to Congress.Trade — have counsel review
 * before relying on them. Update EFFECTIVE_DATE when the text changes.
 */

const EFFECTIVE_DATE = 'October 9, 2026';
const ENTITY = 'Jay Wedgeworth, LLC d/b/a Congress.Trade';
const CONTACT = 'support@congress.trade';

/**
 * LEGALCOMPLIANCE-04: a product named "Congress.Trade" that carries a
 * bald-eagle mark needs an explicit, unmissable non-affiliation statement —
 * shown in the site footer, the legal-page footer, and ToS §1.  Keep this
 * string identical everywhere it appears so the disclaimer cannot drift.
 */
const NOT_AFFILIATED_SENTENCE =
  'Congress.Trade is an independent, privately operated service and is not affiliated with, endorsed by, or sponsored by the U.S. Congress, the U.S. House of Representatives, the U.S. Senate, the Office of Government Ethics, or any government agency.';

/** Site-footer combined line (owner 2026-08-20).  Two spaces around each · and no trailing period. */
const SITE_FOOTER_DISCLAIMER =
  'Congress.Trade  ·  educational tool for public STOCK Act (2012) disclosures  ·  not financial advice  ·  $ estimated from brackets  ·  independent/private service not affiliated with or endorsed/sponsored by any government agency';

/**
 * Shared legal chrome for /terms-of-service and /privacy-policy.
 *
 * Dark tokens are the Privacy Policy reference (navy, 26px title, dim
 * "Effective …" subtitle, numbered h2s, system sans).  Light tokens and
 * the Light / Dark / System control are the same path the dashboard uses
 * (`ui-theme` in localStorage, default light).  Do not give one page a
 * second shell.
 */
const LEGAL_THEME_BOOT = /* html */ `<script>
  (function () {
    var pref = 'light';
    try {
      var s = localStorage.getItem('ui-theme');
      if (s === 'sepia') {
        /* Sepia was removed (owner 2026-08-21) — migrate a returning
           visitor's stored Sepia preference to Light so it stops failing
           validation on every load. */
        try { localStorage.setItem('ui-theme', 'light'); } catch (e2) {}
        s = 'light';
      }
      if (s === 'light' || s === 'dark' || s === 'system') pref = s;
    } catch (e) {}
    var effective = pref;
    if (pref === 'system') {
      effective = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    var theme = effective === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-theme-pref', pref);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1120' : '#eff3f8');
  })();
</script>`;

const LEGAL_THEME_ICONS: Record<'light' | 'dark' | 'system', string> = {
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
};

function legalThemeSegHtml(): string {
  const opts = [
    { id: 'light' as const, label: 'Light' },
    { id: 'dark' as const, label: 'Dark' },
    { id: 'system' as const, label: 'System' },
  ];
  const btns = opts.map((o) =>
    `<button type="button" class="theme-seg-btn" data-theme-opt="${o.id}" aria-label="Set theme to ${o.label}" title="${o.label}" aria-pressed="false">${LEGAL_THEME_ICONS[o.id]}</button>`
  ).join('');
  return `<div class="theme-seg" role="group" aria-label="Theme">${btns}</div>`;
}

const LEGAL_THEME_RUNTIME = /* html */ `<script>
  function readThemePref() {
    try {
      var s = localStorage.getItem('ui-theme');
      if (s === 'sepia') {
        /* Sepia was removed (owner 2026-08-21) — migrate a returning
           visitor's stored Sepia preference to Light so it stops failing
           validation on every load. */
        try { localStorage.setItem('ui-theme', 'light'); } catch (e2) {}
        return 'light';
      }
      if (s === 'light' || s === 'dark' || s === 'system') return s;
    } catch (e) {}
    return 'light';
  }
  function resolveTheme(pref) {
    if (pref === 'dark' || pref === 'light') return pref;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) {}
    return 'light';
  }
  function applyTheme(effective) {
    var theme = effective === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1120' : '#eff3f8');
    syncThemeSegUI();
  }
  function syncThemeSegUI() {
    var pref = readThemePref();
    document.querySelectorAll('.theme-seg-btn[data-theme-opt]').forEach(function (btn) {
      var on = btn.getAttribute('data-theme-opt') === pref;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function setThemePref(pref) {
    if (pref !== 'light' && pref !== 'dark' && pref !== 'system') pref = 'light';
    try { localStorage.setItem('ui-theme', pref); } catch (e) {}
    document.documentElement.setAttribute('data-theme-pref', pref);
    applyTheme(resolveTheme(pref));
  }
  (function bindSystemThemeListener() {
    try {
      if (!window.matchMedia) return;
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        if (readThemePref() === 'system') applyTheme(resolveTheme('system'));
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch (e) {}
  })();
  document.addEventListener('click', function (e) {
    var t = e.target;
    var btn = t && t.closest ? t.closest('.theme-seg-btn[data-theme-opt]') : null;
    if (!btn) return;
    var pref = btn.getAttribute('data-theme-opt');
    if (pref) setThemePref(pref);
  });
  applyTheme(resolveTheme(readThemePref()));
</script>`;

function shell(title: string, body: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
%GA_SCRIPT%
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#eff3f8" />
<title>${title} · Congress.Trade</title>
${LEGAL_THEME_BOOT}
<style>
  :root {
    --bg:#0b1120;--bg2:#111a2e;--panel:#15203a;--border:#243154;--text:#e6edf6;--dim:#8da2c0;--body:#cdd8ea;--accent:#4f8cff;--warn:#f59e0b;
    --sans:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  }
  html[data-theme="dark"] { color-scheme: dark; }
  html[data-theme="light"] {
    color-scheme: light;
    --bg:#eff3f8;--bg2:#e4ebf4;--panel:#ffffff;--border:#c1cde2;--text:#09101c;--dim:#34435b;--body:#34435b;--accent:#2563eb;--warn:#b45309;
  }
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 70% -10%,var(--bg2),var(--bg));color:var(--text);
       font:15px/1.65 var(--sans);}
  header{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 35px;border-bottom:1px solid var(--border);
         background:rgba(10,16,30,.6);position:sticky;top:0;backdrop-filter:blur(8px)}
  html[data-theme="light"] header{background:#fff;-webkit-backdrop-filter:none;backdrop-filter:none}
  .brand{font-weight:700;font-size:16px;font-family:var(--sans)}.brand .dot{color:var(--accent)}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  main{max-width:820px;margin:0 auto;padding:32px 35px 64px}
  h1{font-size:26px;font-weight:700;margin:0 0 4px;font-family:var(--sans)}
  .eff{color:var(--dim);font-size:13px;margin:0 0 28px;font-family:var(--sans)}
  h2{font-size:17px;font-weight:700;margin:30px 0 8px;border-top:1px solid var(--border);padding-top:22px;font-family:var(--sans)}
  p,li{color:var(--body)}strong{color:var(--text)}
  ul{padding-left:20px;list-style:disc}li{margin:5px 0}
  .callout{border:1px solid color-mix(in srgb,var(--warn) 45%,transparent);
           background:color-mix(in srgb,var(--warn) 9%,transparent);border-radius:10px;padding:14px 16px;margin:18px 0}
  .callout strong{color:var(--warn)}
  footer{color:var(--dim);font-size:12px;border-top:1px solid var(--border);padding:22px 35px;text-align:center}
  footer .not-affiliated{display:block;margin-top:6px}
  code{background:var(--bg);padding:1px 6px;border-radius:5px;font-size:13px;color:var(--accent)}
  .theme-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--border);border-radius:9px;background:var(--panel)}
  .theme-seg-btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;background:transparent;
    color:var(--dim);padding:6px 8px;border-radius:7px;cursor:pointer;line-height:1}
  .theme-seg-btn:hover{color:var(--text)}
  .theme-seg-btn.active{color:var(--text);border-color:var(--border);background:var(--bg);box-shadow:0 1px 2px rgba(0,0,0,.12)}
  .theme-seg-btn svg{width:13px;height:13px;flex:0 0 auto}
  @media (max-width:720px){header{padding:16px 22px}main{padding:32px 22px 64px}footer{padding:22px}}
</style>
</head>
<body>
<header><a class="brand" href="/">Congress<span class="dot">.</span>Trade</a>${legalThemeSegHtml()}</header>
<main>
${body}
<p style="margin-top:36px"><a href="/">&larr; Back to Congress.Trade</a></p>
</main>
<footer>${SITE_FOOTER_DISCLAIMER}</footer>
${LEGAL_THEME_RUNTIME}
</body>
</html>`;
}

export const TOS_HTML = shell(
  'Terms of Service',
  /* html */ `
<h1>Terms of Service</h1>
<p class="eff">Effective ${EFFECTIVE_DATE}</p>

<p>These Terms of Service ("Terms") are a binding agreement between you and ${ENTITY} ("Congress.Trade," "we," "us"), governing your access to and use of the Congress.Trade website, API, data feeds, and related services (the "Service").&nbsp; By creating an account, subscribing, or otherwise using the Service, you agree to these Terms.&nbsp; If you do not agree, do not use the Service.</p>

<h2>1. What the Service is</h2>
<p>Congress.Trade aggregates and presents <strong>public financial-disclosure data</strong> filed by (a) Members and staff of the U.S. House of Representatives and U.S. Senate under the STOCK Act (2012), and (b) certain U.S. Executive Branch officials under the Ethics in Government Act of 1978, as amended — including Periodic Transaction Reports (OGE Form 278-T) published by the U.S. Office of Government Ethics and individual federal agencies.&nbsp; The Service provides tools to explore, analyze, and receive that data (including webhook and SSE delivery).&nbsp; It is an <strong>informational and educational</strong> product, and the underlying filings remain public records of their respective source agencies (the U.S. House Clerk, the U.S. Senate, and the Office of Government Ethics).</p>

<p>Executive Branch financial disclosure reports are additionally subject to use restrictions under 5 U.S.C. &sect;13107(c) (formerly Ethics in Government Act &sect;105(c)), which limits use of those reports for certain commercial, credit, and solicitation purposes.&nbsp; Congress.Trade's posture toward those restrictions for Executive Branch rows is under ongoing review and may result in changes to how those rows are delivered, gated, or labeled; this Section will be updated when that review concludes.</p>

<div class="callout">
<strong>Not affiliated with, or endorsed by, any government body.</strong>&nbsp; ${NOT_AFFILIATED_SENTENCE}
</div>

<div class="callout">
<strong>Not financial advice.</strong>&nbsp; The Service is for informational and educational purposes only.&nbsp; Nothing on Congress.Trade is investment, financial, legal, or tax advice, a recommendation, an offer or solicitation to buy or sell any security, or a "trading signal."&nbsp; We are not a broker-dealer, investment adviser, or fiduciary, and no advisory relationship is created by your use of the Service.&nbsp; Disclosure data is sourced from third parties and public filings, may be delayed, incomplete, or inaccurate, and <strong>dollar amounts are estimates derived from the disclosure brackets the filings themselves use, not exact amounts</strong>.&nbsp; Always do your own research and consult a licensed professional before making any financial decision.&nbsp; You are solely responsible for your decisions and any resulting gains or losses.
</div>

<h2>2. Eligibility &amp; accounts</h2>
<ul>
<li>You must be at least 18 years old and able to form a binding contract.</li>
<li>You are responsible for the accuracy of your account information and for safeguarding your sign-in.&nbsp; Notify us promptly at <a href="mailto:${CONTACT}">${CONTACT}</a> of any unauthorized use.</li>
<li>You are responsible for all activity under your account.</li>
</ul>

<h2>3. Subscriptions, billing &amp; trials</h2>
<ul>
<li>Premium is offered as an auto-renewing subscription: <strong>$8.99 / month</strong> or <strong>$79.99 / year</strong> (USD), plus any applicable taxes.&nbsp; The same Premium entitlement is available through the Congress.Trade website (billed by Stripe) or through the Congress.Trade iOS app (billed by Apple as an In-App Purchase); whichever you purchase through, the entitlement applies across both the website and the iOS app on your account.</li>
<li>New subscriptions may include a free trial (currently 7 days / 1 week).&nbsp; If you do not cancel before the trial ends, the subscription renews and your payment method is charged.</li>
<li>Subscriptions <strong>automatically renew</strong> at the end of each billing period until canceled.&nbsp; You authorize recurring charges to your payment method.</li>
<li>We may change prices or plan features; changes apply to the next billing period after reasonable notice.&nbsp; Continued use after a price change constitutes acceptance.</li>
</ul>

<h2>4. Cancellation &amp; refunds</h2>
<ul>
<li><strong>Web (Stripe) purchases</strong> — you may cancel at any time from your account / billing portal.&nbsp; Cancellation stops future renewals; you retain access through the end of the current paid period.</li>
<li><strong>iOS App Store (Apple) purchases</strong> — your subscription is billed to your Apple ID, and you manage or cancel it in iOS Settings &rsaquo; [your name] &rsaquo; Subscriptions, not from the Congress.Trade website.&nbsp; Cancel at least 24 hours before the end of the current period to avoid renewal.</li>
<li>Because the Service is a <strong>digital product delivered immediately</strong>, payments are generally <strong>non-refundable</strong> except where required by law or as expressly granted by us or the payment processor.</li>
<li>Where Stripe acts as merchant of record (see §5), Stripe may issue refunds within its own policy windows (e.g., to resolve disputes).&nbsp; For App Store purchases, refunds are granted solely by Apple under Apple's own policy — request one at <a href="https://reportaproblem.apple.com" target="_blank" rel="noopener noreferrer">reportaproblem.apple.com</a> or via Apple Support; Congress.Trade cannot issue or override an Apple refund.</li>
</ul>

<h2>5. Payments &amp; merchant of record</h2>
<p><strong>Web purchases.</strong>&nbsp; Payments made on the Congress.Trade website are processed by <strong>Stripe</strong>.&nbsp; We do not collect or store full payment-card details.&nbsp; Where <strong>Stripe Managed Payments</strong> is enabled, Stripe (via its Link entity) acts as the <strong>merchant of record</strong> for your purchase and is responsible for charging, billing receipts, applicable sales tax/VAT, and certain transaction support.&nbsp; Your purchase is also subject to Stripe's applicable terms.</p>
<p><strong>iOS App Store purchases.</strong>&nbsp; Premium purchased inside the Congress.Trade iOS app is billed through Apple's In-App Purchase system.&nbsp; <strong>Apple, not Congress.Trade, is the merchant of record</strong> for those purchases and handles billing, receipts, and applicable tax.&nbsp; Your purchase is also subject to Apple's Media Services Terms and Conditions and the App Store's own refund and subscription-management rules.</p>

<h2>6. Acceptable use</h2>
<p>You agree not to: (a) scrape, crawl, or bulk-extract the Service except through interfaces we provide; (b) resell, sublicense, or publicly redistribute the data or feeds except as expressly permitted; (c) exceed published rate limits or interfere with the Service's operation or security; (d) reverse engineer or attempt unauthorized access; or (e) use the Service unlawfully or to violate any third party's rights.</p>

<h2>7. Intellectual property</h2>
<p>The underlying public financial disclosures are public records.&nbsp; The Service's software, design, compilation, enrichment, and analytics are owned by us or our licensors.&nbsp; Subject to these Terms, we grant you a limited, non-exclusive, non-transferable right to use the Service for your personal or internal business purposes.</p>

<h2>8. Third-party data &amp; services</h2>
<p>The Service relies on third-party sources and providers (including U.S. House/Senate disclosure systems and market-data vendors).&nbsp; We do not control and are not responsible for the accuracy, availability, or content of third-party data or websites.</p>

<h2>9. Disclaimers</h2>
<p>THE SERVICE AND ALL DATA ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, AND NON-INFRINGEMENT.&nbsp; We do not warrant that the Service will be uninterrupted, available, timely, secure, or error-free, or that data is accurate or complete, to the maximum extent permitted by applicable law.</p>

<p><strong>No guarantee any filing is published, or published on any schedule.</strong>&nbsp; Congress.Trade ingests disclosures from third-party government sources — the U.S. House Clerk's office, the U.S. Senate's electronic financial disclosure (eFD) system, and the Office of Government Ethics (OGE) — that we do not control and do not operate.&nbsp; Those sources can be delayed, incomplete, malformed, taken offline, or changed without notice, and we are not responsible for their availability or accuracy.&nbsp; We do not guarantee that any particular filing will be published on the Service at all, on any schedule, or within any timeframe.</p>

<p><strong>No guarantee of being faster than any other source.</strong>&nbsp; The Service may show latency or speed comparisons against other sources (for example, a scorecard measuring how quickly a filing appeared on Congress.Trade relative to other sources).&nbsp; Any such comparison is a <strong>historical measurement of past filings under the conditions observed at that time</strong> — it is not a representation, promise, or guarantee about the timing of any future filing, and past speed is not a guarantee of future speed for any particular filing or source.</p>

<p><strong>Alerts &amp; notifications may be delayed, duplicated, or fail.</strong>&nbsp; Email, push, webhook, and SSE (real-time) delivery all depend on third-party systems and networks outside our control — including email providers, Apple's push notification service, your webhook endpoint, and your own browser or network connection — and may be delayed, duplicated, or fail to arrive.&nbsp; A paid subscription does not guarantee the delivery, timing, or accuracy of any particular alert.</p>

<p><strong>We may change the Service.</strong>&nbsp; We may add, change, suspend, or discontinue any part of the Service — including features, data sources, and data coverage — at any time, with or without notice.</p>

<h2>10. Limitation of liability</h2>
<p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, ${ENTITY} AND ITS OWNERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY DAMAGES, OR FOR ANY LOST PROFITS OR TRADING/INVESTMENT LOSSES, ARISING FROM OR RELATED TO THE SERVICE.&nbsp; OUR TOTAL LIABILITY FOR ANY CLAIM WILL NOT EXCEED THE GREATER OF (a) THE AMOUNTS YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM, OR (b) USD $100.</p>
<p>Some jurisdictions do not allow the exclusion of certain warranties or the limitation or exclusion of liability for incidental or consequential damages, so some of the limitations in this Section and in Section 9 (Disclaimers) may not apply to you.&nbsp; In that case, our warranties and liability are limited to the maximum extent permitted by applicable law.</p>

<h2>11. Indemnification</h2>
<p>You agree to indemnify and hold harmless ${ENTITY} from claims and expenses arising out of your use of the Service or violation of these Terms.</p>

<h2>12. Termination</h2>
<p>We may suspend or terminate your access for violation of these Terms or to protect the Service.&nbsp; You may stop using the Service at any time.&nbsp; Sections that by their nature should survive (e.g., disclaimers, limitation of liability) survive termination.</p>

<h2>13. Changes to these Terms</h2>
<p>We may update these Terms from time to time.&nbsp; Material changes will be reflected by an updated effective date and, where appropriate, additional notice.&nbsp; Continued use after changes take effect constitutes acceptance.</p>

<h2>14. Governing law</h2>
<p>These Terms are governed by the laws of the State of Texas, USA, without regard to conflict-of-laws rules.&nbsp; The exclusive venue for disputes is the state and federal courts located in Harris County, Texas, and you consent to their jurisdiction.</p>

<h2>15. Contact</h2>
<p>Questions about these Terms: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
`,
);

export const PRIVACY_HTML = shell(
  'Privacy Policy',
  /* html */ `
<h1>Privacy Policy</h1>
<p class="eff">Effective ${EFFECTIVE_DATE}</p>

<p>This Privacy Policy explains how ${ENTITY} ("Congress.Trade," "we," "us") collects, uses, and shares personal information when you use the Congress.Trade website and services (the "Service").</p>

<h2>1. Information we collect</h2>
<ul>
<li><strong>Account information</strong> — your email address, and, depending on how you sign in: (Google) your name, profile picture, and Google account identifier; (Apple, "Sign in with Apple") your Apple-assigned user identifier and the name/email you choose to share, which may be an Apple private-relay email address.</li>
<li><strong>Billing information</strong> — handled by our payment processors.&nbsp; For web purchases, Stripe gives us subscription status and limited metadata (e.g., plan, period end; card last 4 / brand are stored by Stripe, not us).&nbsp; For iOS App Store purchases, Apple gives us subscription/transaction status and an Apple transaction identifier. <strong>We do not collect or store full payment-card numbers, and we never see your Apple ID password or App Store payment method.</strong></li>
<li><strong>Push notification tokens</strong> — if you enable push alerts in the iOS app, we store the device's Apple Push Notification service (APNs) token so we can deliver alerts to that device.</li>
<li><strong>Delivery preferences</strong> — watchlist and alert preferences you configure, and, if you set up webhook delivery, the destination URL you provide (we send filing data to that URL; we do not control what the receiving server does with it).</li>
<li><strong>Usage &amp; technical data</strong> — IP address, device/browser type, pages viewed, and similar log data, used for security, debugging, and reliability, including error and performance reports generated when the Service encounters a problem.</li>
<li><strong>Communications</strong> — messages you send us (e.g., support email).</li>
</ul>

<h2>2. How we use information</h2>
<ul>
<li>To provide, maintain, and secure the Service and your account.</li>
<li>To process subscriptions, send transactional emails (e.g., sign-in links, receipts), and provide support.</li>
<li>To monitor, debug, and improve the Service and prevent abuse and fraud.</li>
<li>To comply with legal obligations and enforce our Terms.</li>
</ul>

<h2>3. Cookies &amp; similar technologies</h2>
<p>We use a small number of <strong>essential cookies</strong> (e.g., to keep you signed in).&nbsp; We do not use third-party advertising or cross-site tracking cookies.&nbsp; Our hosting provider, Cloudflare, also runs a cookieless page-view "Web Analytics" beacon on our domain that reports aggregate page-load metrics; it does not use cookies or cross-site identifiers.&nbsp; You can control cookies through your browser, but disabling essential cookies may break sign-in.</p>

<h2>4. How we share information (service providers)</h2>
<p>We do not sell your personal information.&nbsp; We share it only with providers that process it on our behalf to run the Service:</p>
<ul>
<li><strong>Stripe</strong> — web payment processing and, where enabled, merchant-of-record billing.</li>
<li><strong>Apple</strong> — "Sign in with Apple" authentication, In-App Purchase billing/merchant-of-record for the iOS app, and Apple Push Notification service (APNs) delivery for push alerts (each only if you use that Apple feature).</li>
<li><strong>Cloudflare</strong> — hosting, content delivery, security, email routing for our domain, and the cookieless Web Analytics beacon described in §3.</li>
<li><strong>Google</strong> — "Sign in with Google" authentication (only if you choose it).</li>
<li><strong>Resend</strong> — delivery of transactional emails (e.g., magic sign-in links).</li>
<li><strong>Financial Modeling Prep</strong> — market-data enrichment (we send ticker symbols, <em>not</em> your personal information).</li>
<li><strong>Sentry (Functional Software, Inc.)</strong> — error and performance monitoring; reports may include IP address and request metadata for the request that triggered the error.</li>
<li><strong>OpenRouter, Mistral, and LlamaParse</strong> — large-language-model and OCR providers we use to extract structured data from public filing PDFs (House/Senate/Executive Branch disclosure documents); we send filing-document content and images to these providers, <em>not</em> your account or personal information.</li>
</ul>
<p>We may also disclose information to comply with law, respond to lawful requests, or protect our rights, users, and the public.</p>

<h2>5. Data retention</h2>
<p>We retain account and billing records for as long as your account is active and as needed for legal, accounting, and dispute-resolution purposes.&nbsp; You can request deletion as described below.</p>

<h2>6. Your rights</h2>
<p>Depending on where you live (e.g., under GDPR or the CCPA/CPRA), you may have rights to access, correct, delete, or port your personal information, and to object to or restrict certain processing.&nbsp; Signed-in users can delete their account in the iOS Account sheet or the website account menu (Delete Account).&nbsp; You may also email <a href="mailto:${CONTACT}">${CONTACT}</a>.&nbsp; We will not discriminate against you for exercising them.&nbsp; Note that some payment records held by Stripe or Apple are retained by those processors under their own policies and legal obligations.&nbsp; Apple In-App Purchase subscriptions must also be cancelled in the App Store.</p>

<h2>7. Security</h2>
<p>We use reasonable technical and organizational measures to protect personal information.&nbsp; No method of transmission or storage is 100% secure, and we cannot guarantee absolute security.</p>

<h2>8. International users</h2>
<p>We operate from the United States, and our providers may process data in the U.S. and other countries.&nbsp; By using the Service, you understand your information may be transferred to and processed in the United States.</p>

<h2>9. Children</h2>
<p>The Service is not directed to, and may not be used by, anyone under 18.&nbsp; We do not knowingly collect personal information from children.</p>

<h2>10. Changes to this Policy</h2>
<p>We may update this Policy from time to time.&nbsp; Material changes will be reflected by an updated effective date and, where appropriate, additional notice.</p>

<h2>11. Contact</h2>
<p>Questions about privacy or to exercise your rights: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
`,
);
