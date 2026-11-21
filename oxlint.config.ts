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
    // Exception, for the lead to decide at review: these files test `instanceof` for their own error classes and
    // for the values it is the only exact check for (Promise, Response, Uint8Array, liquidjs Output and Drop). A
    // brand or duck-type check would also accept thenables and objects from other realms, which changes behaviour.
    {
      files: [
        "src/admin/page.tsx",
        "src/conditions/validate.ts",
        "src/db/transaction.ts",
        "src/events/store.ts",
        "src/loops/loop.ts",
        "src/messaging/payload.ts",
        "src/public/routes.tsx",
        "src/sequences/routes.ts",
        "src/settings/validate.ts",
        "src/subscribers/import/routes.ts",
        "src/templates/renderer.ts",
        "src/webhooks/delivery.ts",
      ],
      rules: { "@nkzw/no-instanceof": "off" },
    },
    // Exception, for the lead to decide at review: the JSX runtime types a component's props by the component, so its
    // props type cannot be unknown (typing it so gives 479 type errors across the admin and public pages), and the
    // settings store is a record keyed by setting name, one value type per key (unknown gives 128 errors across the
    // settings code; a per-key schema is a separate design).
    {
      files: [
        "src/jsx/jsx-runtime.ts",
        "src/jsx/render.ts",
        "src/media/routes.ts",
        "src/public/settings.ts",
        "src/settings/validate.ts",
        "src/settings/xml.ts",
        "src/unsubscribe/policy.ts",
      ],
      rules: { "typescript/no-explicit-any": "off" },
    },
    // Exception, for the lead to decide at review: the Nodemailer envelope in messaging/email.ts carries address
    // objects that @types/nodemailer 8 omits, so its SDK boundary cast can only be a chained one, never a checked type.
    { files: ["src/messaging/email.ts"], rules: { "quality/no-chained-type-assertions": "off" } },
    // B134c: test/ still prints from its measure, runner and reference scripts, and still has the findings of the
    // rules that src/ has already fixed (B134b): test/ follows in B134c. Covers test/ JavaScript specs too.
    {
      files: ["test/**"],
      rules: {
        "no-console": "off",
        "prefer-const": "off",
        curly: "off",
        "typescript/array-type": "off",
        "unicorn/numeric-separators-style": "off",
        "unicorn/prefer-number-properties": "off",
        "typescript/consistent-type-imports": "off",
        "no-useless-assignment": "off",
        "typescript/require-array-sort-compare": "off",
        "unicorn/prefer-top-level-await": "off",
        "typescript/await-thenable": "off",
        "typescript/no-misused-promises": "off",
        "unicorn/prefer-string-replace-all": "off",
        "typescript/use-unknown-in-catch-callback-variable": "off",
        "no-empty": "off",
        "preserve-caught-error": "off",
        "no-promise-executor-return": "off",
        "quality/no-array-filter-map": "off",
        "quality/no-chained-type-assertions": "off",
        "quality/no-object-parameters": "off",
        "typescript/no-misused-spread": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "@nkzw/no-instanceof": "off",
        "unicorn/text-encoding-identifier-case": "off", // B134c: test/ still spells "utf8" in its helpers and specs.
      },
    },
    // The preset's TypeScript override re-enables this rule under its alias in every TypeScript file. B134c:
    // test/ still has unawaited promises; src/ and scripts/ are fixed (B134b).
    {
      files: ["test/**"],
      rules: { "@typescript-eslint/no-floating-promises": "off" },
    },
  ],
  rules: {
    ...cloudflare.rules,
    "no-undef": "error",
    // Labels are spelled as the standards write them ("utf-8"), which is what the XML declaration and charset checks accept.
    "unicorn/text-encoding-identifier-case": ["error", { withDash: true }],

    // The admin and public pages render HTML strings through the in-house JSX runtime (AGENTS.md: no
    // client framework). `class`, Alpine's `x-*`, `@*` and `:*` attributes and other HTML attributes are
    // correct there, and nothing is reconciled, so keys, hooks and checked/onChange pairs do not apply.
    "react/no-unknown-property": "off", // HTML attributes and Alpine directives, not React DOM props
    "react/jsx-key": "off", // no list reconciliation: the runtime renders strings
    "react/checked-requires-onchange-or-readonly": "off", // HTML `checked` on a static form control
    "react/rules-of-hooks": "off", // no hooks in the in-house runtime
    "react/exhaustive-deps": "off", // no hooks in the in-house runtime

    // B134d/B134e: findings remain in src/ or scripts/. Each rule returns to the preset when its findings are fixed:
    // B134e takes the typescript/no-unsafe-* rules, B134d takes the rest.
    "typescript/no-non-null-assertion": "off", // B134d
    "typescript/no-unsafe-argument": "off", // B134e
    "typescript/no-unsafe-assignment": "off", // B134e
    "typescript/no-unsafe-call": "off", // B134e
    "typescript/no-unsafe-member-access": "off", // B134e
    "typescript/no-unsafe-return": "off", // B134e
    "typescript/no-unsafe-type-assertion": "off", // B134e
    "typescript/unbound-method": "off", // B134d
    "quality/no-conditional-empty-object-spread": "off", // B134d
    "quality/no-known-value-widening": "off", // B134d
    "quality/no-unknown-returns": "off", // B134d
    "quality/no-unsafe-dictionary-type": "off", // B134d
    "unicorn/consistent-function-scoping": "off", // B134d

    // B134c: findings remain only in test/.
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
