# External source tests (B150, D169, D170)

The tests here run against the real PocketBase 0.40.5 binary, never a mock of its protocol
([15-external-sources section 8](../../docs/design/15-external-sources.md#8-tests)).

## The binary

`pocketbase-binary.ts` downloads the official release archive for this machine (`linux_amd64` or
`linux_arm64`) from GitHub, checks its SHA-256 against the value pinned in the file (from the
release's `checksums.txt`), extracts `pocketbase` and caches it at
`node_modules/.cache/pocketbase-0.40.5/pocketbase`. The cache is outside Bun's test discovery and
is reused by every later run. Parallel workers each write a temporary file and rename it into
place, so none runs a half-written binary.

- `bun run pocketbase:download` fetches it ahead of the tests. CI gets it from the first test that
  needs it; a `ci.yml` step running the script before `bun run check` is still to be added (B150a
  could not push workflow changes).
- A test calls `startPocketBase()`, which downloads it on first use.
- A new PocketBase version means a new version constant and both checksums, from the release's
  `checksums.txt`.

## The harness

`pocketbase.ts`:

- `startPocketBase()` creates a superuser with the CLI, starts `pocketbase serve` on a free
  loopback port in its own temporary directory (data, public, hooks and migrations directories
  all inside it), waits for `/api/health`, and creates the fixture schema:
  - `services`: the auth collection iglo.email signs in to, with the service account
    `SERVICE_IDENTITY` / `SERVICE_PASSWORD` (`pb.service`);
  - `users`: PocketBase's own auth collection plus `deletedAt` (date) and `marketingOptOut` (bool);
  - `events`: `user` (relation to users), `name`, `data` (JSON), `occurredAt` (date), `key`
    (unique when set), `created` and `updated`;
  - `recipients`: a view over the users without `deletedAt`: `id`, `email`, `name`, `optOut`.

  Every fixture collection lets the service account list and view, and nobody else.
- `pb.create(collection, record)`, `pb.update(...)`, `pb.remove(...)` and `pb.api(method, path, body)`
  write as the superuser; `pb.user(fields?)` creates a user (and so a recipients row) and
  `pb.event(userId, name, data?, fields?)` an events record (`occurredAt` defaults to now).
- `pb.renameField(collection, from, to)` changes the schema (a permanent error for the adapter).
- `pb.stop()` and `pb.start()` stop and restart the process on the same port and data;
  `pb.pause()` and `pb.resume()` send SIGSTOP and SIGCONT (a server that accepts and never
  answers); `pb.close()` stops it and removes its directory.
- `sourceConfig(pb.url, pb.service)` is the adapter's configuration for the fixture schema.

Start one instance per test file (`beforeAll`) and give each test its own users, so tests do not
see each other's records; start a second instance for a test that changes the schema or stops the
server.

## Files

- `adapter.test.ts`: every adapter operation, paging, escaping, token renewal and revocation,
  error classes, the response limit and the private-address guard.
- `settings.test.ts`: the `source.*` settings, `sources.private_hosts` and Test connection through
  the compiled executable.
- `first-name.test.ts`: the `first_name` Liquid filter through `POST /api/tx` and the SMTP sink.
