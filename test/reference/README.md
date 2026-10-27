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
The test command has a ten-minute deadline; set `REFERENCE_COMMAND_TIMEOUT_MS`
to an integer from 1000 to 3600000 to choose a different deadline. A timeout
stops the command's process group and exits 124.
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
| `REFERENCE_API_USER`, `REFERENCE_API_TOKEN` | synthetic API username and per-run generated API token; use Basic authentication |
| `MAILPIT_URL` | Mailpit HTTP origin, including `/api/v1/messages` |
| `MAILPIT_SMTP_HOST`, `MAILPIT_SMTP_PORT` | loopback SMTP listener |
| `WEBHOOK_URL` | webhook delivery endpoint (`POST /deliver`) |
| `WEBHOOK_RECEIVER_URL` | receiver HTTP origin for capture and controls |
| `REFERENCE_RUN_ID` | unique ID used to label owned Docker resources |

The token is captured privately from the installer, and the harness does not
print it. The child command is responsible for not printing it. See
[fixtures.md](fixtures.md) for the synthetic admin, database, and mail data.
Fresh listmonk installation also adds its own sample data.

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
cleanup of a signal-resistant child and grandchild. It creates an unrelated sentinel process
and Docker volume and checks that they survive. These integration checks are
explicit: `bun test` and `bun run check` do not need Docker or downloads.
