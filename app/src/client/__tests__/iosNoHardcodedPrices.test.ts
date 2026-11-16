import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../..');
const iosRoot = join(repoRoot, 'clients/ios');

// Guideline 3.1.1 / App Review pricing: subscription prices must come from
// StoreKit (`product.displayPrice`), never from a hardcoded literal in copy.
// Without these guards, an App Store Connect price change silently desyncs
// from what the iOS paywall says — and Apple rejects copy that quotes a
// price different from the live IAP product.
const FORBIDDEN_PRICE_PATTERNS: RegExp[] = [
  // $X/mo, $X.99/month, $X per year, $X a year, $10 / month
  /\$\s?\d+(?:\.\d{1,2})?\s*(?:\/|per\s+|a\s+)\s*(?:mo|month|yr|year)\b/i,
  // Bare US price pair: $4.99 / $49.99, "$9.99 / $99.99"
  /\$\d+(?:\.\d{2})?\s*\/\s*\$\d+(?:\.\d{2})?/,
  // Charm price: $4.99, $9.99, $99.99
  /\$\d+\.99\b/,
  // Non-1-week free trial: "2-week free trial", "two week free trial", "3 weeks free trial"
  /\b(?:[2-9]|two|three|four)[-\s]week(?:s)?\s+free\s+trial\b/i,
];

function listSwiftFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSwiftFiles(path));
      continue;
    }
    if (!entry.name.endsWith('.swift')) continue;
    if (path.includes(`${iosRoot}/CongressTradeTests`)) continue;
    out.push(path);
  }
  return out;
}

describe('iOS no hardcoded subscription prices (Guideline 3.1.1)', () => {
  const swiftFiles = listSwiftFiles(iosRoot);

  it('has no hardcoded subscription price, charm price, or non-1-week free trial', () => {
    const hits: string[] = [];
    for (const file of swiftFiles) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
          continue;
        }
        for (const pattern of FORBIDDEN_PRICE_PATTERNS) {
          if (pattern.test(line)) {
            hits.push(`${relative(repoRoot, file)}:${i + 1}`);
            break;
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('renders StoreKit displayPrice and only advertises a 1-week free trial', () => {
    const premium = readFileSync(
      join(iosRoot, 'CongressTrade/Views/Status/PremiumSheet.swift'),
      'utf8',
    );
    expect(premium).toContain('product.displayPrice');
    expect(premium).toMatch(/static func headline\(for quotes: \[PremiumPlanQuote\]\)/);
    expect(premium).toContain('static let fallbackHeadline');
    expect(premium).not.toMatch(/static let headline\s*=/);
  });
});
