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
    // Exception, for the lead to decide at review (no-unknown-returns). Each file returns a value that is `unknown`
    // until a boundary check: parsed JSON (request bodies, stored JSON, the reviver, the OpenAPI document), form
    // fields, a stored summary, a method chosen by name at runtime, a Liquid operator, another module's JSON response,
    // and the writeTransaction callback, whose type argument test/db pins. A named type would be `any` at JSON.parse.
    {
      files: [
        "src/analytics/reader.ts", // runtime method dispatch, serialized as JSON
        "src/analytics/summaries.ts", // stored summary JSON
        "src/db/transaction.ts", // F extends () => unknown; test/db/typecheck.ts pins the explicit type argument
        "src/events/input.ts", // parsed request JSON
        "src/mcp/generated.ts", // OpenAPI schema JSON walk
        "src/public/form.ts", // form or JSON field values
        "src/sequences/routes.ts", // write callback result, passed to writeTransaction's F
        "src/server/validation.ts", // parsed request JSON
        "src/settings/json.ts", // ordered settings JSON
        "src/settings/xml.ts", // settings values from XML
        "src/subscribers/routes.ts", // activity and export JSON from other modules
        "src/templates/renderer.ts", // Liquid operator signature
        "src/users/handlers.ts", // JSON.parse reviver
      ],
      rules: { "quality/no-unknown-returns": "off" },
    },
    // Exceptions, for the lead to decide at review (no-known-value-widening). A value that is `unknown` until a
    // boundary check (parsed JSON or form bodies, ordered settings JSON, an OpenAPI schema walk, an XML value, a cast
    // that writes known keys from a string list, the Nodemailer envelope) cannot take a literal type without a lie.
    // The `Record<string, unknown>` dictionaries among them are no-unsafe-dictionary-type exceptions below.
    {
      files: [
        "src/campaigns/input.ts", // cast that writes known keys from a string list
        "src/mcp/generated.ts", // OpenAPI schema JSON walk
        "src/messaging/email.ts", // Nodemailer envelope boundary cast
        "src/roles/routes.ts", // parsed request JSON
        "src/settings/json.ts", // ordered settings JSON
        "src/settings/routes.ts", // parsed request body
        "src/settings/xml.ts", // settings values from XML
        "src/users/handlers.ts", // parsed request JSON
        "src/mcp/tools.ts", // dictionary of tool arguments (see the dictionary exceptions below)
        "src/settings/validate.ts", // dictionary of settings shapes (see the dictionary exceptions below)
        "src/subscribers/input.ts", // dictionary cast (see the dictionary exceptions below)
        "src/subscribers/query-routes.ts", // dictionary binding (see the dictionary exceptions below)
        "src/subscribers/store.ts", // dictionary binding (see the dictionary exceptions below)
        "src/templates/sample.ts", // dictionary of template data (see the dictionary exceptions below)
      ],
      rules: { "quality/no-known-value-widening": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-dictionary-type). Each dictionary below holds a value
    // whose type comes from a payload that is parsed at runtime: a request body, a stored JSON column, an SNS or
    // captcha response, MCP arguments, a settings record keyed by name, SQL rows, or template data. A value type for
    // these needs a schema per payload, a design change (D132: per-key settings schema, typed component props), not a
    // lint fix. The entries are removed when their schema lands.
    {
      files: [
        "src/analytics/summaries.ts", // stored summary data by name
        "src/bounces/routes.ts", // parsed bounce metadata and request body
        "src/bounces/ses.ts", // SNS message JSON
        "src/campaigns/input.ts", // request body JSON
        "src/campaigns/render.ts", // archive metadata JSON
        "src/campaigns/routes.ts", // request body JSON
        "src/campaigns/runner/runner.ts", // stored subscriber attributes JSON
        "src/campaigns/store.ts", // stored campaign JSON columns
        "src/captcha/captcha.ts", // captcha provider response
        "src/conditions/validate.ts", // stored condition JSON
        "src/events/input.ts", // event request body JSON
        "src/jsx/jsx-runtime.ts", // component props (HTML attributes)
        "src/jsx/render.ts", // component props (HTML attributes)
        "src/lists/input.ts", // parsed form body JSON
        "src/mcp/generated.ts", // MCP tool schema JSON
        "src/mcp/routes.ts", // MCP JSON-RPC message
        "src/mcp/tools.ts", // MCP tool arguments
        "src/media/routes.ts", // settings record (any value per key)
        "src/messaging/test.ts", // SMTP test request JSON
        "src/openapi/schemas.ts", // OpenAPI schema objects
        "src/public/form.ts", // form and JSON field values
        "src/public/settings.ts", // settings record (any value per key)
        "src/roles/routes.ts", // request body JSON
        "src/sequences/enrollments.ts", // stored trigger JSON
        "src/sequences/input.ts", // stored step definition JSON
        "src/sequences/routes.ts", // request body JSON
        "src/sequences/step-preview.ts", // stored step and trigger JSON
        "src/server/response.ts", // response body and extra body members
        "src/settings/store.ts", // settings record (any value per key)
        "src/settings/validate.ts", // settings record and shapes
        "src/settings/xml.ts", // settings record and shapes
        "src/subscribers/export.ts", // subscriber attributes JSON
        "src/subscribers/input.ts", // subscriber attributes JSON
        "src/subscribers/query-routes.ts", // SQL result rows
        "src/subscribers/query-runner.ts", // SQL result rows
        "src/subscribers/store.ts", // subscriber attributes JSON
        "src/templates/data.ts", // template data
        "src/templates/input.ts", // parsed form body JSON
        "src/templates/renderer.ts", // template data
        "src/templates/sample.ts", // sample data
        "src/tx/input.ts", // transactional request JSON
        "src/unsubscribe/policy.ts", // settings record (any value per key)
        "src/users/factor.ts", // parsed form fields
        "src/users/handlers.ts", // request body JSON
        "src/webhooks/routes.ts", // request body JSON
        "src/webhooks/store.ts", // stored webhook payload JSON
      ],
      rules: { "quality/no-unsafe-dictionary-type": "off" },
    },
    // Exceptions, for the lead to decide at review (no-conditional-empty-object-spread). Each object below reaches an
    // API response, a webhook payload, stored JSON, an email or a rendered page, where key order is observable, so the
    // spread stays. The objects that never reach one of those (SQL builder options, the session identity, the
    // navigation link, the Liquid options and the render snapshot) are built in separate statements, with the same keys.
    {
      files: [
        "src/admin/page.tsx", // rendered page config
        "src/admin/password-reset.tsx", // email message
        "src/admin/system.ts", // system JSON for the admin page and API
        "src/admin/views/user.tsx", // rendered page links
        "src/bounces/store.ts", // bounce JSON in the API response
        "src/campaigns/routes.ts", // email message and preview
        "src/campaigns/runner/runner.ts", // email message (wire format) and render context
        "src/mcp/generated.ts", // MCP tool JSON schema
        "src/media/attachments.ts", // email attachment (wire format)
        "src/messaging/email.ts", // SMTP transport and email message (wire format)
        "src/messaging/notify.ts", // admin notification email
        "src/messaging/payload.ts", // stored message payload JSON
        "src/messaging/test.ts", // test email
        "src/openapi/document.ts", // OpenAPI document (API output)
        "src/openapi/operations.ts", // OpenAPI operations (API output)
        "src/openapi/schemas.ts", // OpenAPI schemas (API output)
        "src/public/mail.ts", // email and public page output
        "src/scheduler/scheduler.ts", // email message (wire format)
        "src/sequences/enrollments.ts", // stored enrollment JSON
        "src/sequences/input.ts", // stored step definitions JSON
        "src/sequences/routes.ts", // API response
        "src/subscribers/query-routes.ts", // HTTP response headers
        "src/subscribers/store.ts", // stored subscriber attributes JSON
        "src/templates/routes.ts", // API response
        "src/tx/routes.ts", // API response and transactional email
        "src/users/models.ts", // user API response
        "src/webhooks/effects.ts", // webhook payload
      ],
      rules: { "quality/no-conditional-empty-object-spread": "off" },
    },
    // B134c: test/ still prints from its measure, runner and reference scripts, and still has the findings of the
    // rules that src/ has already fixed (B134b): test/ follows in B134c. Covers test/ JavaScript specs too.
    {
      files: ["test/**"],
      rules: {
        // Permanent: test runners, measure and reference scripts print their own command output, which AGENTS.md allows.
        "no-console": "off",
        curly: "off",
        "typescript/array-type": "off",
        "unicorn/numeric-separators-style": "off",
        "unicorn/prefer-number-properties": "off",
        "no-useless-assignment": "off",
        "typescript/require-array-sort-compare": "off",
        "unicorn/prefer-top-level-await": "off",
        "typescript/await-thenable": "off",
        "typescript/no-misused-promises": "off",
        "unicorn/prefer-string-replace-all": "off",
        "typescript/use-unknown-in-catch-callback-variable": "off",
        "no-empty": "off",
        "no-promise-executor-return": "off",
        "quality/no-array-filter-map": "off",
        "quality/no-chained-type-assertions": "off",
        "quality/no-object-parameters": "off",
        "typescript/no-misused-spread": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "@nkzw/no-instanceof": "off",
        "unicorn/text-encoding-identifier-case": "off", // B134c: test/ still spells "utf8" in its helpers and specs.
        "quality/no-unknown-returns": "off", // B134g: test/ still has the rule's findings.
        "quality/no-known-value-widening": "off", // B134g: test/ still has the rule's findings.
        "quality/no-conditional-empty-object-spread": "off", // B134g: test/ still has the rule's findings.
        "quality/no-unsafe-dictionary-type": "off", // B134g: test/ still has the rule's findings.
        "unicorn/consistent-function-scoping": "off", // B134c: test/ still has the rule's findings.
        "typescript/no-unsafe-call": "off", // B134g: test/ still calls values typed any.
        "typescript/no-unsafe-return": "off", // B134g: test/ still returns values typed any.
        "typescript/no-unsafe-type-assertion": "off", // B134g: test/ still asserts from any and unknown.
      },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-call). The settings record is `Record<string, any>`
    // (its values are typed per key, and a per-key schema is a separate design, D132), and the journal payload is
    // parsed JSON that check() validates field by field before the message is returned.
    {
      files: ["src/messaging/payload.ts", "src/public/settings.ts", "src/settings/validate.ts"],
      rules: { "typescript/no-unsafe-call": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-argument). Settings values are `any` per key, and
    // a per-key schema is a separate design (D132): these files pass single settings values, or the settings
    // record, to typed parameters.
    {
      files: [
        "src/main.ts",
        "src/media/routes.ts",
        "src/public/settings.ts",
        "src/settings/routes.ts",
        "src/settings/validate.ts",
        "src/settings/xml.ts",
      ],
      rules: { "typescript/no-unsafe-argument": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-argument). These pass parsed JSON that is `any` until a
    // boundary check: a stored journal payload (checked field by field by check()), a stored archive's metadata,
    // stored aggregate definitions, stored subscriber attributes, and the SMTP test request body.
    {
      files: [
        "src/messaging/payload.ts",
        "src/messaging/test.ts",
        "src/public/archive.tsx",
        "src/scheduler/scheduler.ts",
        "src/subscribers/store.ts",
      ],
      rules: { "typescript/no-unsafe-argument": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-member-access). The settings record is `any` per key
    // (D132), and the settings validator reads it field by field. The journal payload is parsed JSON that check()
    // validates before the message is returned, and the SMTP test body is checked where it is read.
    {
      files: [
        "src/main.ts",
        "src/messaging/payload.ts",
        "src/messaging/test.ts",
        "src/public/settings.ts",
        "src/settings/validate.ts",
      ],
      rules: { "typescript/no-unsafe-member-access": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-assignment). Settings values are `any` per key (D132:
    // a per-key schema is a separate design); these files assign single settings values or the settings record.
    {
      files: [
        "src/main.ts",
        "src/public/settings.ts",
        "src/settings/routes.ts",
        "src/settings/validate.ts",
        "src/settings/xml.ts",
        "src/unsubscribe/policy.ts",
      ],
      rules: { "typescript/no-unsafe-assignment": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-assignment). These parse stored JSON columns, request
    // bodies, a journal payload or SQL rows, which are `any` until the handler or check that owns them validates
    // them. A per-payload schema is a separate design, and a new guard would change how stored data that the writer
    // already accepted is read.
    {
      files: [
        "src/analytics/store.ts",
        "src/bounces/routes.ts",
        "src/campaigns/routes.ts",
        "src/campaigns/runner/runner.ts",
        "src/lists/store.ts",
        "src/messaging/payload.ts",
        "src/messaging/test.ts",
        "src/public/archive.tsx",
        "src/public/mail.ts",
        "src/subscribers/store.ts",
        "src/tx/routes.ts",
      ],
      rules: { "typescript/no-unsafe-assignment": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-assignment). `Object.create` is typed as returning `any`,
    // so a null-prototype dictionary (the one that keeps lookups such as `constructor` from resolving) takes its type
    // from the declaration, and the object is built with the same keys in the same order.
    {
      files: [
        "src/i18n/i18n.ts",
        "src/server/router.ts",
        "src/templates/data.ts",
        "src/templates/renderer.ts",
        "src/tx/input.ts",
      ],
      rules: { "typescript/no-unsafe-assignment": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-type-assertion). Each file below asserts SQL result rows
    // (`get()` and `all()` return unknown, and the row type is the query's column list: a per-query row check is a
    // design change), request or stored JSON that its handler or validator checks, or one boundary named beside it.
    {
      files: [
        "src/analytics/purge.ts", // SQL rows
        "src/analytics/store.ts", // SQL rows
        "src/analytics/subscriber.ts", // SQL rows
        "src/analytics/summaries.ts", // stored summary JSON and SQL rows
        "src/bounces/store.ts", // SQL rows
        "src/campaigns/runner/store.ts", // SQL rows
        "src/campaigns/store.ts", // SQL rows
        "src/events/store.ts", // SQL rows
        "src/lists/references.ts", // SQL rows
        "src/lists/store.ts", // SQL rows and stored tags JSON
        "src/media/store.ts", // SQL rows
        "src/roles/roles.ts", // SQL rows
        "src/sequences/enrollments.ts", // SQL rows
        "src/sequences/store.ts", // SQL rows
        "src/settings/store.ts", // SQL rows
        "src/settings/stored.ts", // SQL row
        "src/subscribers/campaign-recipients.ts", // SQL rows
        "src/subscribers/condition-sql.ts", // SQL rows
        "src/subscribers/list-counts.ts", // SQL rows
        "src/subscribers/query-filter.ts", // SQL rows (EXPLAIN and schema rows)
        "src/subscribers/query-runner.ts", // SQL rows
        "src/subscribers/query.ts", // SQL rows
        "src/subscribers/store.ts", // SQL rows and stored attributes JSON
        "src/templates/store.ts", // SQL rows
        "src/unsubscribe/tracking.ts", // SQL rows
        "src/users/store.ts", // SQL rows
        "src/webhooks/store.ts", // SQL rows
      ],
      rules: { "typescript/no-unsafe-type-assertion": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-type-assertion). Each file below asserts a request body,
    // a stored column or a parsed payload, whose handler, validator or check reads the value before its type is used.
    {
      files: [
        "src/bounces/routes.ts", // request body and bounce metadata JSON
        "src/bounces/ses.ts", // SNS message JSON
        "src/campaigns/input.ts", // request body JSON
        "src/campaigns/render.ts", // stored archive metadata JSON
        "src/campaigns/routes.ts", // request body JSON and stored JSON columns
        "src/events/aggregate.ts", // aggregate result from a row
        "src/events/input.ts", // event request body JSON
        "src/events/routes.ts", // the result of an event, a union whose 200 member has no literal discriminant here
        "src/lists/input.ts", // parsed form body JSON
        "src/mcp/generated.ts", // MCP tool schema JSON
        "src/mcp/tools.ts", // MCP tool arguments
        "src/media/routes.ts", // upload body bytes and stored media meta JSON
        "src/messaging/test.ts", // SMTP test request JSON
        "src/public/form.ts", // form and JSON field values
        "src/roles/routes.ts", // request body JSON
        "src/sequences/input.ts", // request and stored step definition JSON
        "src/sequences/routes.ts", // request body JSON
        "src/settings/hold.ts", // stored hold JSON
        "src/subscribers/export.ts", // subscriber attributes JSON
        "src/subscribers/input.ts", // subscriber request JSON
        "src/subscribers/routes.ts", // request body JSON
        "src/templates/data.ts", // template data JSON
        "src/templates/input.ts", // parsed form body JSON
        "src/templates/routes.ts", // request body JSON
        "src/templates/sample.ts", // sample data JSON
        "src/users/handlers.ts", // request fields checked above (type and status), and the request body
      ],
      rules: { "typescript/no-unsafe-type-assertion": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-type-assertion). One boundary per file, named beside it.
    {
      files: [
        "scripts/assets-build.ts", // a package manifest read by the build
        "scripts/release.ts", // the JSON response of the server the release script just started
        "src/analytics/reader.ts", // method dispatch by a name checked against a list, and a child request from the parent
        "src/backup/snapshot.ts", // a PRAGMA row and a backup manifest read from disk
        "src/campaigns/runner/runner.ts", // stored subscriber attributes JSON
        "src/captcha/captcha.ts", // captcha token parameters, checked field by field before the assertion
        "src/conditions/compile.ts", // condition values, validated before compile
        "src/db/instance-lock.ts", // the shape of a thrown SQLite error (code and message)
        "src/db/transaction.ts", // the callback's result type F, pinned by test/db/typecheck.ts
        "src/loops/loop.ts", // the claim callback's result, checked for length before use
        "src/main.ts", // a settings value (any per key, D132)
        "src/messaging/email.ts", // the Nodemailer envelope boundary (see the no-chained-type-assertions exception)
        "src/public/routes.tsx", // the layout's children, typed as never by the JSX runtime (D132)
        "src/settings/json.ts", // ordered settings JSON
        "src/settings/validate.ts", // settings record and shapes (D132)
        "src/templates/renderer.ts", // the Liquid context with the pinned patch's budget hooks, and a dictionary of options
      ],
      rules: { "typescript/no-unsafe-type-assertion": "off" },
    },
    // Exceptions, for the lead to decide at review (no-unsafe-return). `main.ts` returns single settings values
    // (`Record<string, any>`, one type per key: D132's per-key schema is a separate design). `validate.ts` binds a
    // settings value to its shape, which is `any` by design.
    {
      files: ["src/main.ts", "src/settings/validate.ts"],
      rules: { "typescript/no-unsafe-return": "off" },
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

    // B134c: findings remain only in test/.
    "quality/no-reflect-get": "off", // B134c
    "quality/no-unknown-type-aliases": "off", // B134c
    "unicorn/prefer-native-coercion-functions": "off", // B134c
  },
});
