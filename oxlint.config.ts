// Lint configuration: @cloudflare/oxlint-config 0.1.0 (which extends @nkzw/oxlint-config 3.0.0),
// with the project's globals, environments and ignores carried forward from .oxlintrc.json.
// Type-aware rules run through tsrs (see package.json); `oxlint .` is the lint command.
import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

// Every file under test/ is test code: the preset's test relaxations apply to all of it, and to nothing else.
const testFiles = ["test/**/*.{ts,tsx,mts,cts}"];
const testRelaxations = {
  "typescript/no-explicit-any": "off",
  "typescript/no-non-null-assertion": "off",
  "typescript/no-unsafe-argument": "off",
  "typescript/no-unsafe-assignment": "off",
  "typescript/no-unsafe-member-access": "off",
  "typescript/only-throw-error": "off",
  "typescript/unbound-method": "off",
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
    Bun: "readonly",
    HTMLRewriter: "readonly",
  },
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    "assets/admin/js/**",
    "src/server/asset-manifest.ts",
    "assets/public/static/**",
  ],
  overrides: [
    ...cloudflare.overrides,
    {
      files: testFiles,
      rules: testRelaxations,
    },
    // Application code logs errors and attention lines through the error logger in src/app.ts (AGENTS.md).
    // CLI command modules and the scripts print their own command output.
    {
      files: ["src/app.ts", "src/main.ts", "src/**/cli.ts", "scripts/**/*.ts"],
      rules: { "no-console": "off" },
    },
    // B134b: src/messaging/notify.ts falls back to console when no logger is injected; inject the logger instead.
    { files: ["src/messaging/notify.ts"], rules: { "no-console": "off" } },
    // B134c: test/ still prints from its measure, runner and reference scripts.
    { files: testFiles, rules: { "no-console": "off" } },
    // The preset's TypeScript override re-enables this rule under its alias, so the root `off` below needs
    // this override after it. B134b: src and B134c: test still have unawaited promises.
    {
      files: ["**/*.{ts,tsx,mts,cts}"],
      rules: { "@typescript-eslint/no-floating-promises": "off" },
    },
  ],
  rules: {
    ...cloudflare.rules,
    "no-undef": "error",

    // The admin and public pages render HTML strings through the in-house JSX runtime (AGENTS.md: no
    // client framework). `class`, Alpine's `x-*`, `@*` and `:*` attributes and other HTML attributes are
    // correct there, and nothing is reconciled, so keys, hooks and checked/onChange pairs do not apply.
    "react/no-unknown-property": "off", // HTML attributes and Alpine directives, not React DOM props
    "react/jsx-key": "off", // no list reconciliation: the runtime renders strings
    "react/checked-requires-onchange-or-readonly": "off", // HTML `checked` on a static form control
    "react/rules-of-hooks": "off", // no hooks in the in-house runtime
    "react/exhaustive-deps": "off", // no hooks in the in-house runtime

    // B134b: findings remain in src/ or scripts/. Each rule returns to the preset when its findings are fixed.
    curly: "off", // B134b
    eqeqeq: "off", // B134b
    "no-empty": "off", // B134b
    "no-promise-executor-return": "off", // B134b
    "no-useless-assignment": "off", // B134b
    "preserve-caught-error": "off", // B134b
    "prefer-const": "off", // B134b
    "object-shorthand": "off", // B134b
    "typescript/array-type": "off", // B134b
    "typescript/consistent-type-imports": "off", // B134b
    "typescript/no-explicit-any": "off", // B134b
    "typescript/no-floating-promises": "off", // B134b
    "typescript/no-misused-promises": "off", // B134b
    "typescript/no-misused-spread": "off", // B134b
    "typescript/no-non-null-assertion": "off", // B134b
    "typescript/no-unnecessary-type-assertion": "off", // B134b
    "typescript/no-unsafe-argument": "off", // B134b
    "typescript/no-unsafe-assignment": "off", // B134b
    "typescript/no-unsafe-call": "off", // B134b
    "typescript/no-unsafe-member-access": "off", // B134b
    "typescript/no-unsafe-return": "off", // B134b
    "typescript/no-unsafe-type-assertion": "off", // B134b
    "typescript/require-array-sort-compare": "off", // B134b
    "typescript/unbound-method": "off", // B134b
    "typescript/use-unknown-in-catch-callback-variable": "off", // B134b
    "@nkzw/no-instanceof": "off", // B134b
    "quality/no-array-filter-map": "off", // B134b
    "quality/no-chained-type-assertions": "off", // B134b
    "quality/no-conditional-empty-object-spread": "off", // B134b
    "quality/no-known-value-widening": "off", // B134b
    "quality/no-object-parameters": "off", // B134b
    "quality/no-unknown-returns": "off", // B134b
    "quality/no-unsafe-dictionary-type": "off", // B134b
    "unicorn/consistent-function-scoping": "off", // B134b
    "unicorn/no-hex-escape": "off", // B134b
    "unicorn/numeric-separators-style": "off", // B134b
    "unicorn/prefer-at": "off", // B134b
    "unicorn/prefer-number-properties": "off", // B134b
    "unicorn/prefer-set-has": "off", // B134b
    "unicorn/prefer-string-replace-all": "off", // B134b
    "unicorn/prefer-top-level-await": "off", // B134b

    // B134c: findings remain only in test/.
    "typescript/await-thenable": "off", // B134c
    "typescript/no-require-imports": "off", // B134c
    "typescript/no-import-type-side-effects": "off", // B134c
    "typescript/no-unsafe-function-type": "off", // B134c
    "import/consistent-type-specifier-style": "off", // B134c
    "no-unexpected-multiline": "off", // B134c
    "quality/no-reflect-get": "off", // B134c
    "quality/no-unknown-type-aliases": "off", // B134c
    "unicorn/no-array-fill-with-reference-type": "off", // B134c
    "unicorn/prefer-native-coercion-functions": "off", // B134c
    "unicorn/prefer-single-call": "off", // B134c
  },
});
