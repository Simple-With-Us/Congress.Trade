import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guard for board f6ec22d0 / docs/rollouts/2026-08-01-prod-vars-secret-purge.md.
 *
 * `app/.prod.vars` is a TRACKED, PUBLIC file in a PUBLIC repo.  It is a
 * non-secret runtime-config template: real production values live only in the
 * Coolify encrypted env store.  On 2026-07-29 it was committed with live
 * values, purged, and then RE-committed with live values on 2026-07-30 (PR
 * #1178) — a second leak of the same file two days after the first cleanup.
 * Ten GitHub secret-scanning alerts are still open from that window.
 *
 * Rotation and history are owner-side work.  What a test CAN do is make the
 * third occurrence impossible: any key the template marks as a secret must
 * carry an empty value, and no value anywhere in the file may look like a live
 * credential.  A failure here means someone is about to publish a secret —
 * empty the value and rotate the key, do not edit this test.
 *
 * This file only ever reports KEY NAMES.  It must never put a value in an
 * assertion message, because that message would be printed into a CI log.
 */

const PROD_VARS = fileURLToPath(new URL('../../../.prod.vars', import.meta.url));

/** Prefixes that identify a live credential regardless of which key holds it. */
const LIVE_CREDENTIAL_PATTERNS: Array<[label: string, pattern: RegExp]> = [
  ['Stripe live secret key', /^(sk|rk)_live_/],
  ['Stripe webhook signing secret', /^whsec_/],
  ['AWS access key id', /^A(KIA|SIA)[0-9A-Z]{16}/],
  ['GitHub token', /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/],
  ['GitHub fine-grained PAT', /^github_pat_/],
  ['OpenRouter key', /^sk-or-v1-/],
  ['OpenAI-style key', /^sk-[A-Za-z0-9]{20,}/],
  ['Google API key', /^AIza[0-9A-Za-z_-]{30,}/],
  ['Resend key', /^re_[A-Za-z0-9]{16,}/],
  ['Slack token', /^xox[abposr]-/],
  ['JWT', /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
];

type Entry = { key: string; value: string; markedSecret: boolean; line: number };

function parseProdVars(): Entry[] {
  const raw = readFileSync(PROD_VARS, 'utf8');
  const entries: Entry[] = [];

  raw.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;

    const eq = line.indexOf('=');
    if (eq <= 0) return;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;

    // Split the trailing comment off before unquoting, so `KEY=''  # secret`
    // yields an empty value rather than the comment text.
    let rest = line.slice(eq + 1).trim();
    const markedSecret = /#\s*secret\b/i.test(rest);
    const commentAt = rest.indexOf('#');
    if (commentAt >= 0) rest = rest.slice(0, commentAt).trim();

    const quoted = /^(['"])(.*)\1$/.exec(rest);
    const value = quoted ? quoted[2] : rest;

    entries.push({ key, value, markedSecret, line: index + 1 });
  });

  return entries;
}

describe('app/.prod.vars is a template, never a secret store', () => {
  const entries = parseProdVars();

  it('parses as a non-trivial env template', () => {
    expect(entries.length).toBeGreaterThan(50);
  });

  it('leaves every key marked "# secret" empty', () => {
    const populated = entries.filter((e) => e.markedSecret && e.value !== '');
    // Key names only.  Never interpolate e.value into this message.
    expect(
      populated.map((e) => `${e.key} (line ${e.line})`),
      'these keys are marked as secrets but carry a value; empty them and rotate the key',
    ).toEqual([]);
  });

  it('contains no value shaped like a live credential', () => {
    const offenders: string[] = [];
    for (const entry of entries) {
      for (const [label, pattern] of LIVE_CREDENTIAL_PATTERNS) {
        if (pattern.test(entry.value)) offenders.push(`${entry.key} (line ${entry.line}): ${label}`);
      }
    }
    expect(offenders, 'a live credential is about to be published; rotate it immediately').toEqual(
      [],
    );
  });

  it('keeps the purge notice that explains why the file is empty', () => {
    const header = readFileSync(PROD_VARS, 'utf8').slice(0, 1200);
    expect(header).toContain('NEVER commit real values');
    expect(header).toContain('2026-08-01-prod-vars-secret-purge.md');
  });
});
