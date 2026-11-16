import { describe, it, expect } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  buildExtractionPrompt,
  loadExtractionPromptContext,
  EXTRACTION_PROMPT_VERSION,
  SYSTEM_PROMPT,
  EXECUTIVE_SYSTEM_PROMPT,
} from '../visionLlm.ts';

describe('metadata-grounded extraction prompts', () => {
  it('bumped the prompt version for the grounding change', () => {
    expect(EXTRACTION_PROMPT_VERSION).toBe('stock-act-ptr-v5-grounded');
    expect(EXTRACTION_PROMPT_VERSION).not.toBe('stock-act-ptr-v2');
  });

  it('offers an illegibility escape for the checkbox-band amount', () => {
    // CT-2415 Guard 2: the amount column is a checkbox band, and the prompt
    // used to name it without ever offering a null, so an unreadable legend
    // forced the model to emit *some* band. It must be allowed to say null.
    for (const prompt of [SYSTEM_PROMPT, EXECUTIVE_SYSTEM_PROMPT]) {
      expect(prompt).toContain('CHECKBOX BANDS');
      expect(prompt).toMatch(/return null/);
      expect(prompt).toMatch(/never fall back to the first or most common band/i);
    }
  });

  it('returns the base prompt unchanged when no metadata is available', () => {
    expect(buildExtractionPrompt({})).toBe(SYSTEM_PROMPT);
    expect(buildExtractionPrompt()).toBe(SYSTEM_PROMPT);
  });

  it('selects the executive base prompt for OGE filings', () => {
    const prompt = buildExtractionPrompt({ chamber: 'executive' });
    expect(prompt).toContain(EXECUTIVE_SYSTEM_PROMPT);
    expect(prompt).toContain('OGE Form 278-T');
  });

  it('injects every known fact into the grounding block', () => {
    const prompt = buildExtractionPrompt({
      chamber: 'house',
      filingType: 'P',
      filedDate: '2026-07-01',
      pageCount: 7,
      filerName: 'Jane Q. Representative',
    });
    expect(prompt).toContain(SYSTEM_PROMPT);
    expect(prompt).toContain('KNOWN DOCUMENT FACTS');
    expect(prompt).toContain('U.S. House of Representatives');
    expect(prompt).toContain('Filing-type code: P');
    expect(prompt).toContain('Document page count: 7');
    expect(prompt).toContain('Filer name (as registered): Jane Q. Representative');
    // Grounding is orienting context only — the guardrail must ship with it.
    expect(prompt).toContain('NEVER invent transactions from them');
  });

  it('omits unusable facts instead of injecting junk', () => {
    const prompt = buildExtractionPrompt({
      chamber: 'senate',
      filedDate: 'not-a-date',
      pageCount: 0,
      filerName: '   ',
    });
    expect(prompt).toContain('U.S. Senate');
    expect(prompt).not.toContain('page count');
    expect(prompt).not.toContain('Filer name');
  });
});

describe('loadExtractionPromptContext', () => {
  const filingsRow = {
    chamber: 'house',
    filing_type: 'P',
    filed_date: '2026-06-20',
    page_count: 4,
    filer_id: 'B000123',
  };

  function dbEnv(): Env {
    return {
      DB: {
        prepare(sql: string) {
          return {
            params: [] as unknown[],
            bind(...p: unknown[]) { this.params = p; return this; },
            async first<T>(): Promise<T | null> {
              if (/FROM filings WHERE doc_id = \?/i.test(sql)) return filingsRow as T;
              if (/SELECT full_name FROM filers WHERE bioguide_id = \?/i.test(sql)) {
                return (this.params[0] === 'B000123' ? { full_name: 'Jane Q. Representative' } : null) as T | null;
              }
              return null;
            },
          };
        },
      },
    } as unknown as Env;
  }

  it('fills missing facts from D1 (filings + filers) for a synthetic filing', async () => {
    // The bake-off harness passes only { docId, docKind, chamber }.
    const context = await loadExtractionPromptContext(
      dbEnv(),
      { docId: 'H-1', chamber: 'house' },
    );
    expect(context).toMatchObject({
      chamber: 'house',
      filingType: 'P',
      filedDate: '2026-06-20',
      pageCount: 4,
      filerName: 'Jane Q. Representative',
    });
    const prompt = buildExtractionPrompt(context);
    expect(prompt).toContain('KNOWN DOCUMENT FACTS');
    expect(prompt).toContain('Jane Q. Representative');
  });

  it('prefers the caller-supplied page-count hint over the DB value', async () => {
    const context = await loadExtractionPromptContext(dbEnv(), { docId: 'H-1' }, 12);
    expect(context.pageCount).toBe(12);
  });

  it('degrades to filing-object facts without a DB and never throws', async () => {
    const context = await loadExtractionPromptContext(
      undefined,
      { chamber: 'senate', filingType: 'A', filedDate: '2025-02-03' },
    );
    expect(context).toMatchObject({ chamber: 'senate', filingType: 'A', filedDate: '2025-02-03' });
    expect(context.filerName).toBeUndefined();
  });

  it('survives a throwing DB (pre-migration) with the facts it already has', async () => {
    const env = {
      DB: {
        prepare() { throw new Error('no such column: page_count'); },
      },
    } as unknown as Env;
    const context = await loadExtractionPromptContext(env, { docId: 'H-1', chamber: 'house' });
    expect(context.chamber).toBe('house');
    expect(context.filerName).toBeUndefined();
  });
});
