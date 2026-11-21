// Lint configuration: @cloudflare/oxlint-config 0.1.0 (which extends @nkzw/oxlint-config 3.0.0),
// with the project's globals, environments and ignores carried forward from .oxlintrc.json.
// Type-aware rules run through tsrs (see package.json); `oxlint .` is the lint command.
import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

// Every file under test/ is test code: the preset's test relaxations apply to all of it, and to nothing else.
const testFiles = ['test/**/*.{ts,tsx,mts,cts}'];
const testRelaxations = {
  'typescript/no-explicit-any': 'off',
  'typescript/no-non-null-assertion': 'off',
  'typescript/no-unsafe-argument': 'off',
  'typescript/no-unsafe-assignment': 'off',
  'typescript/no-unsafe-member-access': 'off',
  'typescript/only-throw-error': 'off',
  'typescript/unbound-method': 'off',
} as const;

export default defineConfig({
  ...cloudflare,
  env: {
    builtin: true,
    es2024: true,
    browser: true,
    node: true,
  },
  globals: {
    Bun: 'readonly',
    HTMLRewriter: 'readonly',
  },
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    'assets/admin/js/**',
    'src/server/asset-manifest.ts',
    'assets/public/static/**',
  ],
  overrides: [
    ...cloudflare.overrides,
    {
      files: testFiles,
      rules: testRelaxations,
    },
  ],
  rules: {
    ...cloudflare.rules,
    'no-undef': 'error',

    // The admin and public pages render HTML strings through the in-house JSX runtime (AGENTS.md: no
    // client framework). `class`, Alpine's `x-*`, `@*` and `:*` attributes and other HTML attributes are
    // correct there, and nothing is reconciled, so keys, hooks and checked/onChange pairs do not apply.
    'react/no-unknown-property': 'off', // HTML attributes and Alpine directives, not React DOM props
    'react/jsx-key': 'off', // no list reconciliation: the runtime renders strings
    'react/checked-requires-onchange-or-readonly': 'off', // HTML `checked` on a static form control
    'react/rules-of-hooks': 'off', // no hooks in the in-house runtime
    'react/exhaustive-deps': 'off', // no hooks in the in-house runtime
  },
});
