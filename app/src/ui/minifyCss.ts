/**
 * src/ui/minifyCss.ts
 * OWNER: dashboard agent
 *
 * CT-2459: conservative CSS minifier applied at module load to the served
 * dashboard stylesheet (206 KB source). Deliberately small and boring:
 *
 *  - strips block comments (string-aware),
 *  - collapses whitespace runs to one space (string-aware),
 *  - drops spaces adjacent to `{`, `}`, `;` everywhere, and after `:` / `,`
 *    and before `!important` only inside declaration blocks at paren depth 0,
 *  - drops the final `;` before `}`.
 *
 * It never touches string contents, never removes a space BEFORE ':' (a
 * descendant pseudo-class `a :hover` differs from `a:hover`), and never
 * edits inside parentheses beyond whitespace collapse (calc()/url() safety).
 * If anything about the input looks unbalanced, the caller should treat the
 * output with suspicion — the unit tests pin brace balance on the real
 * stylesheet.
 */
export function minifyCss(css: string): string {
  // Pass 1: strip comments + collapse whitespace, tracking string state.
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < css.length) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < css.length) {
        out += css[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      // A removed comment between two tokens must not glue them together.
      if (out && !/\s$/.test(out)) out += ' ';
      continue;
    }
    if (/\s/.test(ch)) {
      if (out && !/\s$/.test(out)) out += ' ';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }

  // Pass 2: punctuation tightening with brace/paren context.
  let res = '';
  quote = null;
  let braceDepth = 0;
  let parenDepth = 0;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    if (quote) {
      res += ch;
      if (ch === '\\' && j + 1 < out.length) {
        res += out[j + 1];
        j += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      res += ch;
      continue;
    }
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (ch === ' ') {
      const prev = res[res.length - 1] ?? '';
      const next = out[j + 1] ?? '';
      const drop =
        prev === '' ||
        '{;'.includes(prev) ||
        '{};'.includes(next) ||
        (parenDepth === 0 && braceDepth > 0 && (prev === ':' || prev === ',')) ||
        (parenDepth === 0 && braceDepth > 0 && next === '!') ||
        (parenDepth === 0 && next === ')' ) ||
        (parenDepth === 0 && prev === '(');
      if (!drop) res += ch;
      continue;
    }
    if (ch === '{') braceDepth += 1;
    else if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      if (res.endsWith(';')) res = res.slice(0, -1);
    }
    res += ch;
  }
  return res.trim();
}
