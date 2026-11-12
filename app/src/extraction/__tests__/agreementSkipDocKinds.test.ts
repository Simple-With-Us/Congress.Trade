/**
 * src/extraction/__tests__/agreementSkipDocKinds.test.ts
 *
 * The agreement cascade corroborates a MODEL's reading of a document by having
 * other models read the same bytes. That is only meaningful where the primary
 * read was probabilistic. `senate_html` is parsed by a deterministic HTML
 * extractor, so there is nothing to corroborate — and the cascade's vision
 * models receive HTML bytes they cannot parse at all.
 *
 * Measured in production before this gate existed (2026-08-11):
 *   senate_html / agreement : 2,086 runs, 48 ok, ZERO rows
 *   scanned_pdf / agreement : 2,590 runs, 1,345 ok, 11,710 rows
 *   text_pdf    / agreement :   617 runs,   249 ok,  9,727 rows
 *
 * 25% of every model call the system had ever made went to a format that
 * cannot yield a row.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGREEMENT_SKIP_DOC_KINDS,
  agreementSkipDocKinds,
  agreementSkipDocKindSql,
} from '../autopilot.ts';

describe('agreementSkipDocKinds', () => {
  it('skips senate_html by default', () => {
    expect(agreementSkipDocKinds()).toEqual(['senate_html']);
    expect(DEFAULT_AGREEMENT_SKIP_DOC_KINDS).toBe('senate_html');
  });

  it('accepts a comma-separated override and normalises it', () => {
    expect(agreementSkipDocKinds(' Senate_HTML , text_pdf ')).toEqual([
      'senate_html',
      'text_pdf',
    ]);
  });

  it('can be disabled entirely with an empty value', () => {
    expect(agreementSkipDocKinds('')).toEqual([]);
    expect(agreementSkipDocKindSql([])).toBe('');
  });
});

describe('agreementSkipDocKindSql', () => {
  it('produces a doc_kind exclusion the selectors can concatenate', () => {
    const sql = agreementSkipDocKindSql(['senate_html']);
    expect(sql).toContain("COALESCE(f.doc_kind, '') NOT IN ('senate_html')");
    // Must be a bare AND-fragment so it appends to an existing WHERE clause.
    expect(sql.trim().startsWith('AND')).toBe(true);
  });

  it('escapes quotes so a malformed knob cannot break out of the literal', () => {
    const sql = agreementSkipDocKindSql(["it's"]);
    expect(sql).toContain("'it''s'");
  });

  it('handles multiple kinds', () => {
    expect(agreementSkipDocKindSql(['senate_html', 'text_pdf'])).toContain(
      "NOT IN ('senate_html', 'text_pdf')",
    );
  });
});
