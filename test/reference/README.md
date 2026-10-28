# Development reference and test services

This harness is for development and contract tests. It is not included in the
iglo.email executable. It requires Bun 1.4+, Git, network access to GitHub and
its release assets, and, for the runner/smoke, the Docker CLI and a running
Docker daemon with access to the `postgres:17-alpine` image. No Go toolchain,
Mailpit container, fixed host port, or application container is needed.

```sh
bun install --frozen-lockfile
bun run reference:prepare
bun run reference:smoke
bun run contract:reference
bun run reference:run -- bun -e 'if (!process.env.REFERENCE_URL) process.exit(1)'
bun run check
```

`reference:prepare` fetches listmonk source at
`6fcd95f32bb633d3a62a06c383c0b3322eecc898` and the native published listmonk
`v7.0.0-beta.1` and Mailpit `v1.32.0` archives. Each archive's pinned SHA-256 is
checked before extracting its executable; cached archives, executables, and the
source checkout are checked on every invocation. A wrong or modified cache fails
without overwriting it. To repair one, inspect and remove only the offending
entry in the ignored `upstream/reference/` directory, then prepare again.
The source lives in `.listmonk-source` so Bun's ordinary test discovery does not
run the upstream Playwright specs.
Preparation and native binaries support Linux and macOS on x64 and arm64.
The Linux Docker lifecycle is exercised locally and in CI; CI also runs native
macOS preparation and version checks on x64 and arm64. Full macOS Docker
lifecycle is supported by the same portable commands but has not been verified
on this Linux host.

`reference:run` prepares as needed, creates one labelled Postgres container and
volume, and launches native listmonk, Mailpit, and a loopback webhook receiver.
It waits for readiness, runs the exact command and argument vector supplied
without shell interpolation, then stops its processes and removes its own
container, volume, and run directory even on errors, SIGTERM, or SIGINT. The
command's exit status is returned. Each invocation has an independent random
run ID and ports. The Postgres container has a 256 MiB memory limit and one CPU.
Readiness requires the container's `pg_isready` to accept connections over
`127.0.0.1:5432` and the published loopback port to complete a protocol handshake.
The explicit TCP probe excludes the image's temporary Unix-socket initialization
server; SSL negotiation alone can succeed while database startup is still rejected.
The existing bounded readiness loop waits before installation; the installer is
run once, with no automatic install retry.
The test command has a ten-minute deadline; set `REFERENCE_COMMAND_TIMEOUT_MS`
to an integer from 1000 to 3600000 to choose a different deadline. A timeout
stops the command's process group and exits 124.
When a child exits, its remaining descendants are stopped immediately and its
process-group identity is retired. Later cleanup and timeout callbacks do not
send signals using that exited child's saved group ID.
The Docker daemon and image cache are not changed beyond ordinary image pulls;
verified downloads remain cached. Services do not inherit `LISTMONK_*`,
Mailpit relay/forwarding, or `POSTGRES_*` settings from the caller. All service
ports bind to loopback. The initial listmonk server starts in passive mode to
configure local SMTP and disable update checks through its settings API, then
restarts normally before the command is run.

The child inherits its caller's environment and receives these additional values:

| Variable | Meaning |
|---|---|
| `REFERENCE_URL` | listmonk HTTP origin |
| `REFERENCE_API_USER`, `REFERENCE_API_TOKEN` | synthetic API username and per-run generated API token; Basic and token authentication are exercised |
| `MAILPIT_URL` | Mailpit HTTP origin, including `/api/v1/messages` |
| `MAILPIT_SMTP_HOST`, `MAILPIT_SMTP_PORT` | loopback SMTP listener |
| `WEBHOOK_URL` | webhook delivery endpoint (`POST /deliver`) |
| `WEBHOOK_RECEIVER_URL` | receiver HTTP origin for capture and controls |
| `REFERENCE_RUN_ID` | unique ID used to label owned Docker resources |

The token is captured privately from the installer, and the harness does not
print it. The child command is responsible for not printing it. See
[fixtures.md](fixtures.md) for the synthetic admin, database, and mail data.
Fresh listmonk installation also adds its own sample data.

## HTTP contract corpus

The shared, explicit case definitions are in `test/contract/cases.ts`; the
reference-first protected-read observations and synthetic fixture credentials
are in [`test/contract/fixtures.md`](../contract/fixtures.md). Its M0.5 coverage
table is historical; the current public-page coverage is described below.

```sh
bun test test/contract
bun test test/users
bun run contract:normal
bun run contract:auth
bun run reference:run -- bun test/contract/auth.ts reference
bun run contract:fixture
bun run contract:reference
bun run server:reference
```

`contract:reference` launches this runner once under `reference:run` and checks
the pinned upstream. `server:reference` is the compatibility alias, not a second
corpus or nested service stack. Ordinary tests and the normal/fixture commands
need no Docker or reference downloads.

The normal production profile builds and starts the compiled executable from an
unrelated temporary working directory, with an empty PATH and fresh data dir.
It bootstraps the synthetic human, logs in through the real form, and creates a
real API user through the protected user API. The generated credential remains
in memory and authenticates the promoted Basic, token and invalid-token health
cases against actual production. `contract:auth` uses the same provisioning and
the stateful `test/contract/auth.ts` corpus; the explicit `reference:run`
command above runs that corpus against pinned upstream with invocation-owned
users and role fixtures. The final sole-admin probe restores the invocation-owned
bootstrap user in a finally block; it is not for a persistent or real server.
Its D26-D28 differences are
documented in `test/contract/fixtures.md`. No generated secret is reported.

The separate fixture profile retains its synthetic auth gate and representative
list/helper routes; generated ID/timestamp probes verify normalization only.
The labelled `test/users` fixture composes production owners with fake-clock,
peer and minimal role controls for cases that cannot yet be provisioned through
production role APIs. Neither fixture is evidence of a production list or role
management endpoint. Domain owners promote helper cases as their routes land.
Public HTML 404 semantics and embedded static responses are covered in both
upstream and compiled production, with explicit per-target site names and
attribution. Repeat the reference-first observations with
`bun run reference:run -- bun test/ui/reference-observe.ts`. Static HEAD requests
on the pinned upstream return 405 with no content type. The normal implementation
supports metadata-only HEAD under D21 and advertises `OPTIONS, GET, HEAD` on
OPTIONS/405, versus upstream's `OPTIONS, GET`. Declared Allow headers are checked
by the corpus. Encoded static dot segments have an explicit D18 case against
real compiled production as well as upstream; both refuse the resource with
their documented plain-text versus HTML 404 bodies.

For an already running owned loopback target, the CLI also accepts an explicit
base URL and profile. For example, inside a `reference:run` child:

```sh
bun test/contract/cli.ts run --mode reference --target upstream --profile all
```

The reference URL and synthetic credentials come from `REFERENCE_URL`,
`REFERENCE_API_USER` and `REFERENCE_API_TOKEN`; `--base-url` can override the
origin. Normal direct runs specify the production/core or fixture/staged mode,
target and profile, plus `--base-url`. Set both
`CONTRACT_API_USER` and `CONTRACT_API_TOKEN` for authenticated fixture cases.
Only numeric HTTP loopback origins with an explicit port are accepted. `--case`
selects a known supported case; requesting an unported production case fails
before an HTTP request. Credentials must never appear in a URL or command line.

## Webhook receiver

- `POST $WEBHOOK_URL` captures request headers and the original body and returns
  the selected status (200 by default).
- `GET $WEBHOOK_RECEIVER_URL/deliveries` returns an array of objects containing
  `method`, lowercase `headers`, `body` decoded as UTF-8, and `bodyBase64`, which
  preserves the exact bytes for non-UTF-8 bodies.
- `DELETE $WEBHOOK_RECEIVER_URL/deliveries` clears captures and returns 204.
- `PUT $WEBHOOK_RECEIVER_URL/status` with JSON `{"status": 503}` changes the
  delivery response; accepted statuses are integers from 200 to 599.

This receiver only records requests and chooses a response; testing delivery
retries is a later task. Its state is private to one runner instance.

`reference:smoke` invokes the public runner and checks the pinned source and
binary versions, health and authenticated settings, an upstream transactional
email received in Mailpit, webhook bytes/headers/reset/status, argument
preservation, concurrent isolation, command failure and deadline, partial
startup failure, termination during startup, both termination signals, and
cleanup of a signal-resistant child and grandchild, including a parent that exits
before its descendant. It creates an unrelated sentinel process
and Docker volume and checks that they survive. These integration checks are
explicit: `bun test` and `bun run check` do not need Docker or downloads.

The shared static corpus also covers equivalent escaped stylesheet filenames
and redundant separators. The source-first observation checks the escaped Geist
font name; compiled-production HTTP tests verify its MIME type and WOFF2 bytes.
The application decodes names once and cleans separators within the original
embedded namespace, without arbitrary filesystem lookup.
