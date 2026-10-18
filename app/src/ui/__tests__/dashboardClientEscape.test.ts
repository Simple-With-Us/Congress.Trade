/**
 * src/ui/__tests__/dashboardClientEscape.test.ts
 *
 * CT-1500: unit coverage for the generator's escaping.
 *
 * The golden-file `check:client` step cannot cover this. It compares generated
 * output against a committed file, so if the escaper itself regressed it would
 * regenerate a golden file that agrees with the broken escaper and pass. The
 * corruption would only appear when a browser evaluated the served script.
 *
 * So these tests assert the actual invariant instead: whatever goes in must come
 * back out when the template literal is evaluated, which is precisely what a
 * browser does with it.
 */

import { describe, expect, it } from 'vitest';
import { escapeForTemplateLiteral, inject } from '../../../scripts/dashboard-client-escape.ts';

/** Evaluate a template literal the way a browser evaluating the asset would. */
function evalTemplate(literalBody: string): string {
  return new Function(`return \`${literalBody}\`;`)() as string;
}

/** Escape, then evaluate. Must be the identity for every input. */
function roundTrip(text: string): string {
  return evalTemplate(escapeForTemplateLiteral(text));
}

describe('escapeForTemplateLiteral — round trip', () => {
  const cases: Array<[string, string]> = [
    ['plain', 'var x = 1;'],
    ['the regex that motivated the escaper', String.raw`/\[([A-Z0-9]{2,3})\]/`],
    ['a lone backslash', '\\'],
    ['several backslashes', String.raw`a\\b\\\\c`],
    ['a raw backtick', 'var s = `hi`;'],
    ['an interpolation', 'var s = `${name}`;'],
    ['a backslash then a backtick', '\\`'],
    ['backslash, backtick, interpolation, backslash, backtick', 'a \\` b ${x} c \\` d'],
    ['a bare dollar with no brace', 'cost: $5'],
    ['JSON.stringify output with quotes', JSON.stringify({ a: 'b"c', d: 'e\\f' })],
    ['a template literal embedded whole', '`a${b}c`'],
    ['newline and tab', 'line1\n\tline2'],
  ];

  for (const [name, input] of cases) {
    it(`survives: ${name}`, () => {
      expect(roundTrip(input)).toBe(input);
    });
  }

  it('produces a regex that still compiles and matches after the round trip', () => {
    // The failure mode this whole layer exists for: unescaped, `\[` collapses to
    // `[`, the character class closes early, and evaluating throws "Unmatched
    // ')'". Assert the recovered regex both compiles AND matches.
    const src = String.raw`var re = /\[([A-Z0-9]{2,3})\]/; out = re.exec('x [SEC] y')[1];`;
    const recovered = roundTrip(src);
    expect(recovered).toBe(src);
    // eslint-disable-next-line no-new-func
    const out = new Function(`var out; ${recovered}; return out;`)() as string;
    expect(out).toBe('SEC');
  });

  it('escapes backslashes before backticks, so the inserted escapes are not doubled', () => {
    // Order dependency: if backticks were escaped first, `\` + backtick would
    // become `\\` + `\``, and the round trip would return `\` + backtick only
    // by accident. This pins the documented ordering.
    const input = '\\`';
    expect(escapeForTemplateLiteral(input)).toBe('\\\\\\`');
    expect(roundTrip(input)).toBe(input);
  });

  it('leaves no bare backtick or interpolation in the escaped output', () => {
    const escaped = escapeForTemplateLiteral('a `b ${c} d');
    expect(escaped).not.toMatch(/(?<!\\)`/);
    expect(escaped).not.toMatch(/(?<!\\)\$\{/);
  });
});

describe('inject — the four sentinels', () => {
  it('replaces every sentinel with a real value and leaves no sentinel behind', () => {
    const source = [
      '__CT_EXEC_TITLE_FORMS__',
      '__CT_MAX_PUBLIC_TRADES_OFFSET__',
      '__CT_BENCHMARK_CATALOG__',
      '__CT_APP_STORE_URL__',
    ].join('\n');
    const out = inject(source);
    for (const sentinel of [
      '__CT_EXEC_TITLE_FORMS__',
      '__CT_MAX_PUBLIC_TRADES_OFFSET__',
      '__CT_BENCHMARK_CATALOG__',
      '__CT_APP_STORE_URL__',
    ]) {
      expect(out).not.toContain(sentinel);
    }
    expect(out).not.toBe(source);
  });

  it('substitutes a JSON literal for the title forms, not a bare identifier', () => {
    const out = inject('__CT_EXEC_TITLE_FORMS__');
    expect(out.trim().startsWith('{')).toBe(true);
    expect(() => JSON.parse(out.trim())).not.toThrow();
  });

  it('substitutes the offset as a bare number', () => {
    expect(inject('__CT_MAX_PUBLIC_TRADES_OFFSET__').trim()).toMatch(/^\d+$/);
  });

  it('injects an https App Store url', () => {
    expect(inject('__CT_APP_STORE_URL__')).toMatch(/^https:\/\//);
  });

  it('is applied before escaping, so injected quotes survive', () => {
    const out = roundTrip(inject('var t = __CT_EXEC_TITLE_FORMS__;'));
    expect(out).toContain('var t = {');
    expect(() => new Function(out)).not.toThrow();
  });
});