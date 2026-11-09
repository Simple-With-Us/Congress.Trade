import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.wrangler/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs['flat/recommended'].rules,

      // Pragmatic overrides — catch real issues without requiring massive refactors.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Disable rules that are covered by TypeScript's strict mode.
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },

  // CT-1500: the dashboard's ~545 KB of browser JavaScript used to live only
  // inside a TypeScript template literal, so `tsc` saw a string and eslint saw
  // nothing at all — an undefined global shipped without anything failing.
  // `src/ui/client/dashboard.js` is that same code as a real source file, and
  // `scripts/build-dashboard-client.ts` generates the served string from it.
  //
  // `no-undef` is the rule that matters here and it is NOT part of
  // js.configs.recommended's TypeScript story, so it is enabled explicitly.
  // Browser globals are declared rather than guessed: the script runs in a
  // browser window, not in Node and not in a Worker.
  {
    files: ['src/ui/client/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Module-load values substituted by scripts/build-dashboard-client.ts.
        // Declared read-only so a stray assignment is a lint error too.
        __CT_EXEC_TITLE_FORMS__: 'readonly',
        __CT_MAX_PUBLIC_TRADES_OFFSET__: 'readonly',
        __CT_BENCHMARK_CATALOG__: 'readonly',
        __CT_APP_STORE_URL__: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // The rule that motivated CT-1500. An undefined global in a browser
      // classic script is a ReferenceError at the call site, and the ~163
      // inline handlers plus the typeof guards used to hide every instance.
      'no-undef': 'error',
      // Every top-level `var`/`function` here is on `window` by design: the
      // inline onclick/onchange handlers resolve those names as globals at
      // dispatch time. So a top-level declaration eslint cannot see used is
      // usually a live export, not dead code, and 144 "unused" warnings would
      // train everyone to ignore the rule. Unused *parameters* are fine to warn
      // about (they are genuinely local) and are left on.
      'no-unused-vars': ['warn', { varsIgnorePattern: '^_', args: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
