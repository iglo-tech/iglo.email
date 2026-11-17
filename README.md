# iglo.email

**iglo.email is a self-hosted newsletter, transactional email and lifecycle email server, built on Bun and SQLite.**

Canonical repository: [iglo-tech/iglo.email](https://github.com/iglo-tech/iglo.email). The default branch is `main`.

It is an independently maintained rewrite derived from [listmonk](https://github.com/knadh/listmonk) v7 and keeps its product model: subscribers, lists, campaigns, templates and transactional email. It adds what listmonk does not have: event-triggered email sequences, consent-aware transactional mail, a per-subscriber frequency cap and signed outbound webhooks. It is feature complete for its scope and published as is, with no formal support process. Current state and the backlog are in [docs/status.md](docs/status.md); start with the [design docs](docs/design/README.md).

## What it does

- **Subscribers and lists:** single and double opt-in, consent per list, import and export, query-selected bulk actions. A subscriber can also be addressed by your own external ID.
- **Campaigns:** scheduled, rate-limited sends to lists, with open and click tracking, a public archive and test sends. Templates are written in Liquid, with the `number` filter for formatted numbers.
- **Transactional email:** `POST /api/tx` sends a template to a subscriber. A marketing send through it needs consent, as campaigns do.
- **Events and sequences:** `POST /api/subscriber-events` records what a subscriber did. An event starts or exits sequences: steps with waits, conditions over events and attributes, and step aggregates (counts, sums and distinct values of the subscriber's own events). Test mode runs a sequence for one subscriber with every wait shortened to at most a minute.
- **Consent and the frequency cap:** marketing mail needs consent on the sequence's or campaign's list, and a per-subscriber frequency cap limits how often marketing mail reaches one person. An event can grant consent on single opt-in lists with `subscriber.grant_lists`; the grant adds a confirmed membership where none exists and never undoes an unsubscribe.
- **Unsubscribe:** one-click unsubscribe headers and public preference pages.
- **Webhooks:** outbound events signed with `X-Iglo-Email-Signature`.
- **Bounces and sending:** Amazon SES is the only sending and bounce provider. Its bounce notifications arrive through SNS.
- **Media:** uploads kept in the data directory.
- **Admin UI and public pages:** a server-rendered admin UI at `/admin`, and public subscription, unsubscribe and archive pages.
- **API:** listmonk's HTTP API contract for the endpoints it ports, native endpoints for what listmonk lacks, the OpenAPI document at `/api/openapi.json`, and an MCP endpoint at `/api/mcp`. The differences from listmonk are listed in [docs/design/07-api-and-ui.md](docs/design/07-api-and-ui.md).
- **Backups:** `iglo.email backup` writes a consistent copy of a running server, and `backup --verify` checks one.

## If you are an AI agent

- **Applications** (code in the app or its deploy: events, transactional sends, subscriber sync, a provisioning script in the app's repository) use the HTTP API with an API user, as the [operations guide](docs/operations.md#api-user-for-an-app-integration) describes. The API is versioned and documented at `/api/openapi.json` on the instance.
- **An agent working on an instance for a person** uses the MCP endpoint at `/api/mcp`: content (templates, sequence steps, campaigns), media, subscribers, events, sends, bounces and settings.
- Both apply the same permissions. The MCP endpoint leaves out the operations that [D98](docs/design/09-decisions.md#d98-mcp-covers-every-operation-except-a-short-exclusion-list-lead-2026-11-13) excludes (users and roles, login, two-factor, bulk and irreversible deletes, replacing all settings at once) and caps uploads at 1 MiB, where REST media takes 25 MiB. Use MCP when it is connected and REST otherwise.
- The MCP server sends its own instructions on connect: the authoring loop, and `template_reference` for Liquid. The [MCP section of the operations guide](docs/operations.md#mcp-model-context-protocol) has the scope, the roles and the loop.

Connect Claude Code with a project `.mcp.json` (an HTTP server, with the token in a header):

```json
{
  "mcpServers": {
    "iglo-email": {
      "type": "http",
      "url": "https://<root>/api/mcp",
      "headers": {
        "Authorization": "token <api-user>:<token>"
      }
    }
  }
}
```

Or add it with the command line:

```sh
claude mcp add --transport http iglo-email https://<root>/api/mcp --header "Authorization: token <api-user>:<token>"
```

Do not commit a `.mcp.json` that holds a real token: Claude Code expands `${VAR}` references in `headers`, so the token can come from the environment. Create the API user for the agent with only the permissions it needs, as [operations](docs/operations.md#mcp-model-context-protocol) recommends; the bootstrap variables for the first API user are in [operations](docs/operations.md#environment-variables).

## Supported platforms

iglo.email ships for Linux only:

- one compiled executable for Linux x86-64 and Linux arm64;
- one multi-architecture Docker image, `ghcr.io/iglo-tech/iglo.email:<version>`, which wraps that executable and runs as a non-root user with its data in `/data`.

## Run it

For production, follow the [operations guide](docs/operations.md). It covers installation, the Docker example, the reverse proxy and TLS, Amazon SES setup, backups and restores, and upgrades.

To run a local build, install Bun 1.4 or newer, then:

```sh
bun install --frozen-lockfile
bun run build
./dist/iglo.email serve
```

The compiled executable includes the Bun runtime and can run independently of the checkout. `serve` is also the default when the command is omitted, and `--help` lists the options. `GET /health` returns `200` and `{"data":true}`.

Bootstrap options can be passed as `--name value` or `--name=value`. Flags take precedence over environment variables. These are bootstrap defaults, not stored settings.

| Flag | Environment variable | Default |
|---|---|---|
| `--port` | `IGLO_EMAIL_PORT` | `9000` |
| `--host` | `IGLO_EMAIL_HOST` | `127.0.0.1` |
| `--data-dir` | `IGLO_EMAIL_DATA_DIR` | `./data`, relative to the working directory |
| `--root-url` | `IGLO_EMAIL_ROOT_URL` | `http://<host>:<port>` derived from the selected host and port |

The port must be an integer from 1 to 65535; the host must be a hostname or IP address without a port. The data directory must be a non-empty path, and the root URL must be an absolute HTTP or HTTPS URL without credentials, a query, or a fragment. If listening on a wildcard address or using a reverse proxy, set the public root URL explicitly. Startup creates the data directory and `iglo-email.db` there.

`IGLO_EMAIL_ADMIN_USER` and `IGLO_EMAIL_ADMIN_PASSWORD` create the first admin, and only while no users exist. Without them, public health still answers but login is denied. `IGLO_EMAIL_API_USER` and `IGLO_EMAIL_API_TOKEN` create an API user with the Super Admin role on the same first start, with the token you give; set both or neither. Deploying behind a proxy: [operations](docs/operations.md#deploying-behind-a-reverse-proxy-or-paas). The listmonk flags `--install`, `--upgrade`, `--config` and `--new-config` are not supported: see the [scope](docs/design/01-scope.md).

## Develop

For development, install Bun 1.4 or newer, then run the local checks:

```sh
bun install --frozen-lockfile
bun run assets:build
bun test test/jsx test/ui
bun run ui:verify
bun run format:check
bun run lint
bun run typecheck
bun run check
bun test test/server test/contract
bun run contract:normal
bun run contract:fixture
```

`bun install` generates the asset manifest and browser bundles, and `bun run assets:build` reproduces them. `bun run check` runs formatting, lint, type checking, the behavior tests and the compiled build. Tests verify behavior through the HTTP API, rendered pages, the SMTP sink and webhook receivers, with an injected clock. The `contract:*` scripts that start the compiled production executable need Linux. `bun run hooks:install` enables the repository's pre-commit formatting check.

The development reference harness runs pinned upstream listmonk against Postgres in Docker, and needs Docker and network access. It is optional: see the [reference guide](test/reference/README.md). The end-to-end suite is `bun run e2e`, described in [test/e2e/README.md](test/e2e/README.md).

## Design and decisions

- [Design docs](docs/design/README.md): scope, architecture, data model, sending, sequences, templates, API and UI.
- [Decisions](docs/design/09-decisions.md): short records of what was decided and why.
- [Status](docs/status.md): what is merged and what is next.

## Why iglo.email?

Read [Why iglo.email exists](docs/why-iglo-email.md).

## License

AGPL-3.0, the same license as listmonk, from which this project is derived. See [LICENSE](LICENSE).
