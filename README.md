# iglo.email

**iglo.email is a self-hosted newsletter, transactional email and lifecycle email server, built on Bun and SQLite.**

Canonical repository: [iglo-tech/iglo.email](https://github.com/iglo-tech/iglo.email). The default branch is `main`.

It is an independently maintained rewrite derived from [listmonk](https://github.com/knadh/listmonk) v7. It keeps listmonk's product model (subscribers, lists, campaigns, templates, transactional email) and adds what listmonk does not plan to have: event-triggered email sequences, unsubscribe-aware transactional email, a per-subscriber frequency cap, a send log and outbound webhooks.

> **Status: early skeleton.** The executable starts an HTTP server and exposes `/health`; the planned product features and database are not implemented yet. Start with the [design docs](docs/design/README.md).

## Run the skeleton

For development, install Bun 1.4 or newer, then build the executable:

```sh
bun install --frozen-lockfile
bun run build
./dist/iglo.email serve
```

The compiled executable includes the Bun runtime and can run independently of the checkout. `serve` is also the default when the command is omitted; use `--help` for the CLI options. `GET /health` returns `200`, `Content-Type: application/json`, and `{"data":true}`.

Bootstrap options can be passed as `--name value` or `--name=value`. Flags take precedence over environment variables. These are bootstrap defaults, not stored settings.

| Flag | Environment variable | Default |
|---|---|---|
| `--port` | `IGLO_EMAIL_PORT` | `9000` |
| `--host` | `IGLO_EMAIL_HOST` | `127.0.0.1` |
| `--data-dir` | `IGLO_EMAIL_DATA_DIR` | `./data`, relative to the working directory |
| `--root-url` | `IGLO_EMAIL_ROOT_URL` | `http://<host>:<port>` derived from the selected host and port |

The port must be an integer from 1 to 65535; the host must be a hostname or IP address without a port. The data directory must be a non-empty path, and the root URL must be an absolute HTTP or HTTPS URL without credentials, a query, or a fragment. If listening on a wildcard address or using a reverse proxy, set the public root URL explicitly. The data directory is not created or used by this skeleton.

`IGLO_EMAIL_ADMIN_USER` and `IGLO_EMAIL_ADMIN_PASSWORD` are recognized as initial-admin inputs but are not used yet. User creation is planned for M1.3; credentials are not required to start the skeleton. The listmonk flags `--install`, `--upgrade`, `--config` and `--new-config` are not supported: see the [scope](docs/design/01-scope.md).

## Local checks

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun run check
```

`bun run check` runs all of these checks except installation. The bootstrap tests build and copy the executable into a temporary directory, exercise its CLI and HTTP boundary there, and stop their own server processes. The `/health` response is based on direct inspection of the pinned listmonk handler; the dual-server contract harness is planned for M0.5.

To enable the repository-local pre-commit formatting check, run `bun run hooks:install` once in this repository.

## Development reference

The opt-in reference harness runs the pinned upstream listmonk release against disposable Postgres, Mailpit and a webhook receiver. It requires Git, Docker and network access; it is separate from the SQLite application and its compiled executable.

```sh
bun run reference:prepare
bun run reference:smoke
bun run reference:run -- bun -e 'if (!process.env.REFERENCE_URL) process.exit(1)'
```

See the [reference guide](test/reference/README.md) for supported platforms, credentials, exported endpoints, cleanup and validation. The normal checks above need neither Docker nor reference downloads.

## Planned

- subscribers, lists, single and double opt-in, segmentation queries
- campaigns with scheduling, throttling, tracking and bounces
- a transactional email API that respects unsubscribes and returns message IDs
- an events API and email sequences ("wait 3 days, then send X if Y did not happen")
- a server-rendered admin UI
- SQLite storage, no external database, Redis or queue
- one executable for deployment

## Why iglo.email?

Read [Why iglo.email exists](docs/why-iglo-email.md).

## License

AGPL-3.0, the same license as listmonk, from which this project is derived. See [LICENSE](LICENSE).
