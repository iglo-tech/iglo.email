# Adapted browser specs

`bun run e2e` builds the executable, starts it on a generated data directory
with the loopback SMTP sink, and runs `specs/*.e2e.js` serially with Playwright
in the Chromium under `~/.cache/ms-playwright`. A second instance has no
administrator, for the fresh-install case. Everything stops when the run ends.
It needs no Docker and is not part of `bun run check`. If Playwright cannot find
its browser, `node_modules/.bin/playwright install chromium` fetches the revision
it pins. Failures leave a screenshot and trace in `dist/e2e-results`.

One file: `bun run e2e test/e2e/specs/login.e2e.js`. Arguments go to Playwright.

`bun run e2e:browser` makes one `agent-browser` pass over login, 2FA enrolment,
password reset and the dashboard against the same servers and prints what each
page said. `bun run e2e:browser:lists` does the same for the subscribers and lists
screens, `bun run e2e:browser:campaigns` for the templates and campaigns screens, and
`bun run e2e:browser:settings` for the settings, users, roles and profile screens,
`bun run e2e:browser:media` for the bounces, media, import and forms screens,
`bun run e2e:browser:analytics` for the analytics, logs and maintenance screens, and
`bun run e2e:browser:sequences` for the sequence, enrollment and subscriber tab screens.
`E2E_SHOTS=<directory>` keeps screenshots.

Credentials are the synthetic ones in `test/worked-example/harness.ts`; each
test makes its own users and data through the public API.

A test fails on any Content-Security-Policy violation or Alpine expression error
on its page. One that provokes them on purpose sets `violations: "expected"`, and
one that needs a handler to run sets `bypassCSP`. `csp.e2e.js` walks every screen;
`editor-containment.e2e.js` runs the corpus in `hostile-html.js` through the editor.

## Adapting an upstream spec

1. Copy `tests/specs/<name>.spec.js` from the pinned upstream to
   `specs/<name>.e2e.js`, with a header naming the source. The name matters:
   `bun test` would run a `.spec.js` file.
2. Import `test` from `../helpers.js`, not from `@playwright/test`. It makes each
   test its own client, so a run stays inside the login limit.
3. Replace `resetDB` with data of your own: `createUser`, `api` and `unique`
   instead of a clean database. Upstream's `psql` has no equivalent; assert
   through the API or the screen.
4. Replace `getMail` with `mailFor(address)`, and keep upstream's locators and
   `data-testid` values in the ported view so the rest of the spec applies as it is.
5. Note a deliberate difference in a comment beside the changed case, with its
   row in `docs/design/07-api-and-ui.md`.
