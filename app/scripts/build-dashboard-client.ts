/**
 * scripts/build-dashboard-client.ts
 *
 * CT-1500: generates `src/ui/dashboardClient.ts` from `src/ui/client/dashboard.js`.
 *
 * Why this exists. The dashboard's ~545 KB of browser JavaScript used to live
 * only inside a TypeScript template literal, so `tsc` saw a string and eslint
 * saw nothing at all. An undefined global — the review finding that motivated
 * this cites `updateTrWindowLabels` — shipped without anything failing. This
 * script makes the browser code a real `.js` file that eslint can parse, and
 * regenerates the served string from it so the two cannot drift.
 *
 * Direction of truth: `dashboard.js` is the source; `dashboardClient.ts` is
 * generated. The four module-load values are injected here rather than being
 * interpolated in the template literal, which is what forced the code to be a
 * template literal in the first place. They are written as `__CT_*__`
 * sentinels in the source file and substituted verbatim here.
 *
 *   deno run -A scripts/build-dashboard-client.ts          # write
 *   deno run -A scripts/build-dashboard-client.ts --check  # verify only
 *
 * `--check` is what CI runs. It exits non-zero and prints a diff hint if the
 * committed file does not match, so a hand-edit to `dashboardClient.ts` fails
 * the build instead of being silently overwritten by the next generation.
 */

import { assetVersion } from '../src/ui/assets.ts';
import { escapeForTemplateLiteral, inject } from './dashboard-client-escape.ts';

const SOURCE_PATH = new URL('../src/ui/client/dashboard.js', import.meta.url);
const TARGET_PATH = new URL('../src/ui/dashboardClient.ts', import.meta.url);

const HEADER = `/**
 * src/ui/dashboardClient.ts
 * OWNER: dashboard agent
 *
 * The dashboard application script, served as /assets/dashboard.js.
 *
 * CT-2418: this used to be a ~545 KB inline <script> in the dashboard document,
 * so it was re-downloaded on every navigation and re-invalidated on every
 * deploy. Extracted verbatim and served \`immutable\`, which turns the repeat-visit
 * cost of the app's JavaScript into a cache hit.
 *
 * CT-1500: GENERATED FILE, DO NOT EDIT. The source of truth is
 * \`src/ui/client/dashboard.js\`, which is real JavaScript that eslint parses
 * with browser globals and \`no-undef\` enabled. Regenerate with
 * \`deno run -A scripts/build-dashboard-client.ts\`; \`--check\` is wired into CI
 * and fails if this file and the source have drifted apart.
 *
 * It is loaded as a CLASSIC script at the exact position the inline block used
 * to occupy (after the boot markup it queries, before the trailing dialogs),
 * never \`type="module"\` and never \`async\`:
 *
 *   - \`type="module"\` would scope the ~775 top-level \`var\`/\`function\`
 *     declarations off \`window\`, and the ~163 inline \`onclick\`/\`onchange\`
 *     handlers in the body markup resolve those names as globals at dispatch
 *     time. Every handler would die silently.
 *   - \`async\` could execute the block before the markup it queries exists.
 */

import { assetVersion } from './assets.ts';

export const DASHBOARD_APP_JS = /* js */ \``;

/** Builds the full generated file content. */
function build(source: string): string {
  const injected = escapeForTemplateLiteral(inject(source));
  // Belt and braces: after escaping, no bare backtick or ${ may survive. A
  // silent corruption here is exactly the failure mode CT-1500 is about — the
  // old template literal could swallow one and only a browser would find out.
  for (const [needle, what] of [['`', 'backtick'], ['${', 'interpolation']] as const) {
    if (injected.includes(needle)) {
      const line = injected.slice(0, injected.indexOf(needle)).split('\n').length;
      throw new Error(`dashboard.js still contains a bare ${what} at line ${line} after escaping`);
    }
  }
  // DASHBOARD_APP_JS_VERSION must come after the literal: assetVersion() reads
  // the string, so referencing it earlier would be a temporal-dead-zone error.
  // No separator before the body: dashboard.js already opens with the same two
  // newlines the old template literal had, and adding one more would change the
  // served bytes for no reason.
  return `${HEADER}${injected}\n\`;\n\n/** \`?v=\` cache-busting fingerprint; see assetVersion(). */\nexport const DASHBOARD_APP_JS_VERSION = assetVersion(DASHBOARD_APP_JS);\n`;
}

const source = await Deno.readTextFile(SOURCE_PATH);
const next = build(source);

if (Deno.args.includes('--check')) {
  const current = await Deno.readTextFile(TARGET_PATH);
  if (current === next) {
    console.log('dashboardClient.ts is in sync with client/dashboard.js');
    Deno.exit(0);
  }
  console.error(
    'dashboardClient.ts is OUT OF SYNC with src/ui/client/dashboard.js.\n' +
      'Run: deno run -A scripts/build-dashboard-client.ts',
  );
  Deno.exit(1);
}

await Deno.writeTextFile(TARGET_PATH, next);
console.log(
  `wrote dashboardClient.ts (${next.length} chars) from client/dashboard.js (${source.length} chars)`,
);