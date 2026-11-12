# Adapted browser specs

`bun run e2e` builds the executable and runs `specs/*.e2e.js` with Playwright in the Chromium
under `~/.cache/ms-playwright`. It starts `E2E_WORKERS` independent stacks (default 2), each with
its own server on a generated data directory, loopback SMTP sink and a second, administrator-less
instance for the fresh-install case. Spec files are the unit of work: each stack takes the next
file from a queue, longest first, and runs it serially with one Playwright process, so tests inside
a file keep their order and their shared setup. Specs change settings every user of a server shares
(SMTP, captcha, tracking, trusted URLs, and `reset` in the subscribers files empties every list), so
two files never share a server. Everything stops when the run ends. It needs no Docker and is not
part of `bun run check`. The release workflow runs it on two stacks before it publishes or pushes an image (`release.yml`, D96). If Playwright cannot find its browser, `node_modules/.bin/playwright
install chromium` fetches the revision it pins. Failures leave a screenshot and trace in
`dist/e2e-results/<spec file>`; the trace has DOM snapshots, network and console but no screencast
frames, which cost a quarter of the CPU of a run. The run ends with the slowest spec files, and
`dist/e2e-results/timings.json` lists every file and test with its duration.

`E2E_WORKERS=1 bun run e2e` runs every file on one stack, longest first, one Playwright process per
file. `E2E_WORKERS` must be a whole number, 1 or more; anything else stops the run before it starts.
Each stack takes about 1.1 GiB and one to one and a half cores while it works (the Playwright
process, two servers and a Chromium). The default is 2 because the 6-core, 16 GiB VM is shared with
other agents: 2 stacks keep the run at about 3 cores and 2.2 GiB. On an idle host `E2E_WORKERS=3` or
`E2E_WORKERS=4` is faster (see `docs/perf/e2e-speed.md`); more than 4 does not help, since the
longest files then bound the time. A spec that is too long to balance is split along its describe
blocks (`subscribers*.e2e.js`, with the shared steps in `subscribers-helpers.js`).

One file: `bun run e2e test/e2e/specs/login.e2e.js`. Arguments go to Playwright and run on one
stack, in order.

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

`operations.e2e.js` covers the admin notification mail, the restore hold and the privacy page. Its
restore test starts a third instance with `test/e2e/instance.js`: the production `backup` command
writes a snapshot of the stack's data directory, which is copied into a temporary directory and
served by the same executable. The instance is stopped and its directory removed when the test
ends, and the restored instance shares the stack's mail sink, since its copied settings point at
it. The release runs through `backup --release-hold --consent-reconciled` on the stopped instance,
as the operations guide describes.

A test fails on any Content-Security-Policy violation or Alpine expression error
on its page. One that provokes them on purpose sets `violations: "expected"`, and
one that needs a handler to run sets `bypassCSP`. `csp.e2e.js` walks every screen;
`editor-containment.e2e.js` runs the corpus in `hostile-html.js` through the editor.

## Adapting an upstream spec

1. Copy `tests/specs/<name>.spec.js` from the pinned upstream to
   `specs/<name>.e2e.js`, with a header naming the source. The name matters:
   `bun test` would run a `.spec.js` file.
2. Import `test` from `../helpers.js`, not from `@playwright/test`. It makes each
   test its own client, so a run stays inside the login limit. Start a session with `signIn(page)`,
   which posts the login form's request without drawing any page (about 0.3 s, against 0.7 s and
   a dashboard render for the form), then `page.goto` the screen. Use `login(page)`, the form itself,
   only where logging in is what is tested (login, two-factor, password reset, a role's first
   screen). `logout` opens `/admin` when the page is not on an admin screen.
3. Replace `resetDB` with data of your own: `createUser`, `api` and `unique`
   instead of a clean database. Upstream's `psql` has no equivalent; assert
   through the API or the screen.
4. Replace `getMail` with `mailFor(address)`, and keep upstream's locators and
   `data-testid` values in the ported view so the rest of the spec applies as it is.
5. Note a deliberate difference in a comment beside the changed case, with its
   row in `docs/design/07-api-and-ui.md`.

Waits in specs: after an update the admin screens reload themselves and show a toast, and after a
create they navigate to the list. Wait for that toast or URL before the next `goto`, since a
navigation started during the move is aborted.
