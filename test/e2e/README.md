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
page said. `E2E_SHOTS=<directory>` keeps screenshots.

Credentials are the synthetic ones in `test/worked-example/harness.ts`; each
test makes its own users and data through the public API.

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
