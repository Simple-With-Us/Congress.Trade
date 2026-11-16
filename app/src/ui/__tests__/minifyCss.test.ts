import { describe, expect, it } from 'vitest';
import { minifyCss } from '../minifyCss.ts';
import { DASHBOARD_CSS, DASHBOARD_CSS_SERVED } from '../dashboardStyles.ts';
import { DASHBOARD_APP_JS_SERVED } from '../dashboardClient.ts';

describe('minifyCss (CT-2459)', () => {
  it('strips comments and tightens punctuation', () => {
    expect(minifyCss('/* hi */ a { color: red; margin: 0 ; }')).toBe('a{color:red;margin:0}');
  });

  it('never alters string contents', () => {
    expect(minifyCss('a::before { content: " { ; } /* x */ "; }')).toBe(
      'a::before{content:" { ; } /* x */ "}',
    );
  });

  it('keeps the descendant-pseudo space (a :hover is not a:hover)', () => {
    expect(minifyCss('a :hover { color: blue; }')).toBe('a :hover{color:blue}');
  });

  it('keeps calc() spacing intact', () => {
    expect(minifyCss('a { width: calc(100% - 10px); }')).toBe('a{width:calc(100% - 10px)}');
  });

  it('real stylesheet: balances braces, keeps key selectors, shrinks >15%', () => {
    const count = (s: string, ch: string) => s.split(ch).length - 1;
    expect(count(DASHBOARD_CSS_SERVED, '{')).toBe(count(DASHBOARD_CSS_SERVED, '}'));
    // One source '{' lives inside a comment (stripped by design).
    expect(Math.abs(count(DASHBOARD_CSS_SERVED, '{') - count(DASHBOARD_CSS, '{'))).toBeLessThanOrEqual(2);
    expect(DASHBOARD_CSS_SERVED).toContain(':root{');
    expect(DASHBOARD_CSS_SERVED).toContain('nav.tabs');
    expect(DASHBOARD_CSS_SERVED).not.toContain('/* ---- THEME ---- */');
    expect(DASHBOARD_CSS_SERVED.length).toBeLessThan(DASHBOARD_CSS.length * 0.85);
  });

  it('minified dashboard JS parses and keeps handler globals', () => {
    expect(() => new Function(DASHBOARD_APP_JS_SERVED)).not.toThrow();
    for (const name of ['showView', 'renderTrades', 'toggleFeedOptions']) {
      expect(DASHBOARD_APP_JS_SERVED).toContain(`function ${name}`);
    }
  });
});
