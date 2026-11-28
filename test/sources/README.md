# External source tests (B150, D169, D170)

The tests here run against the real PocketBase 0.40.5 binary (and, for iglo.base, the real
iglo.base 1.3.0 binary), never a mock of its protocol
([15-external-sources section 8](../../docs/design/15-external-sources.md#8-tests)).

## The binary

`pocketbase-binary.ts` downloads the official release archive for this machine (`linux_amd64` or
`linux_arm64`) from GitHub, checks its SHA-256 against the value pinned in the file (from the
release's `checksums.txt`), extracts `pocketbase` and caches it at
`node_modules/.cache/pocketbase-0.40.5/pocketbase`. The cache is outside Bun's test discovery and
is reused by every later run. Parallel workers each write a temporary file and rename it into
place, so none runs a half-written binary. The download, check, extraction and rename are
`releaseBinary` in `harness.ts` (B162c), shared with `iglo-base-binary.ts`.

- `bun run pocketbase:download` fetches it ahead of the tests. CI gets it from the first test that
  needs it; a `ci.yml` step running the script before `bun run check` is still to be added (B150a
  could not push workflow changes).
- A test calls `startPocketBase()`, which downloads it on first use.
- A new PocketBase version means a new version constant and both checksums, from the release's
  `checksums.txt`.

## The harness

`pocketbase.ts` (with `harness.ts`, B162c: the shared start-up, fixture schema, `stopped()` and
download, used by both binaries' harnesses):

- `startPocketBase()` creates a superuser with the CLI, starts `pocketbase serve` on a free
  loopback port in its own temporary directory (data, public, hooks and migrations directories
  all inside it), waits until `/api/health` answers and the started process itself listens on the
  port (`listensOn` in `test/serve-port.ts`, so a parallel test's server on a reused port is never
  taken for it), and creates the fixture schema:
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
  answers); await `pb.pause()`: it settles only once every thread of the process is stopped,
  since `kill` returns while some threads can still answer. `pb.close()` stops it and removes its
  directory.
- A stream fixture (`stream-fixture.ts`) moves its test clock only while no source request is in
  flight and the stream is not connecting (`until`, `advance`, `retryAfter`): each request's time
  limit is on that clock. Read attention lines by what they say, not by position. Its
  `beforeRequest` option runs before each source request is sent, so a test can write to the
  source between two of the stream's reads (a race the binary does not produce on demand).
- Records created one after another can share a millisecond `created` (or `updated`), and a
  catch-up reads in `(stamp, id)` order. A test that relies on which of two records a catch-up
  reaches first gives them IDs in that order (B158), or explicit stamps in `manual_events`.
- `sourceConfig(pb.url, pb.service)` is the adapter's configuration for the fixture schema.

Start one instance per test file (`beforeAll`) and give each test its own users, so tests do not
see each other's records; start a second instance for a test that changes the schema or stops the
server.

## iglo.base (B162b, D189)

iglo.base is the second connector's source (D187): an API-compatible Bun port of PocketBase
0.42.3. Its harness mirrors PocketBase's, so a test written against the `PocketBase` harness
interface runs on either binary.

- `iglo-base-binary.ts` downloads the official iglo.base 1.3.0 release archive for this machine
  (`iglo-base_1.3.0_linux_amd64.zip` or `_linux_arm64.zip`) from the `iglo-tech/iglo.base` GitHub
  release, checks its SHA-256 against the value pinned in the file (from the release's
  `SHA256SUMS`), extracts `iglo-base` and caches it at
  `node_modules/.cache/iglo-base-1.3.0/iglo-base`, with the same rename-into-place as PocketBase's.
  `bun run iglo-base:download` fetches it ahead of the tests; a `ci.yml` step running it next to
  `pocketbase:download` is an owner item (agents lack the `workflow` scope). A new version means a
  new version constant and both checksums, from the release's `SHA256SUMS`.
- `iglo-base.ts`: `startIgloBase()` is `startHarness` (`harness.ts`) with the iglo.base binary:
  the same superuser, start-up and readiness check, fixture schema, service account and helpers as
  `startPocketBase()`. It returns the `PocketBase` interface from `pocketbase.ts`, so
  `sourceConfig(url, service)` applies unchanged. The one difference in the command line: no
  `--hooksDir` (iglo.base refuses it and exits with status 1). `igloBaseCommand(args)` runs one CLI
  command and returns its output.
- `iglo-base.test.ts`: the smoke test (the version line, the fixture schema, records written by
  the helpers and read through the PocketBase adapter, a restart on the same data) and the facts
  of 15-external-sources section 9, each run on both binaries; where the two differ, the test names
  the value per binary (D189).

## The connector contract suite (B162c, D190)

`connector-contract.ts` is the suite every connector passes (15-external-sources section 10):
`connectorContract(target)` registers its tests for one connector name, its display name and
example URL, and its harness, and reaches the connector only through `connectors[name]`. It asserts
results, not request counts. What a binary does differently (D189) is named in the target per
binary (`revokedToken`: `"guest"` or `401`; `closesWhenBehind`), and the test of that difference
checks it was met. `connector-contract-pocketbase.test.ts` and `connector-contract-iglo-base.test.ts`
run it against PocketBase 0.40.5 and iglo.base 1.3.0. `connector-contract-proxy.ts` runs
`stream-proxy.ts`'s byte-forwarding proxy as a child process and stops it (SIGSTOP), so the
binary's unsent realtime messages pile up as behind a reader that has fallen behind (Bun's
`node:net` `pause()` does not stop reads, so an in-process proxy cannot do this).

## Files

- `adapter.test.ts`: every adapter operation, paging, escaping, token renewal and revocation,
  error classes, the response limit and the private-address guard.
- `settings.test.ts`: the `source.*` settings, `sources.private_hosts` and Test connection through
  the compiled executable.
- `first-name.test.ts`: the `first_name` Liquid filter through `POST /api/tx` and the SMTP sink.
- `stream.test.ts` (B150b): the realtime stream: live delivery, catch-up after a reset mid-stream
  and mid-catch-up, the lookback, the forced and idle closes on the injected clock, refused
  connects and a permanent refusal, topic split and re-subscribe, the retry queue, restart and a
  new source. `stream-fixture.ts` runs a stream on a fresh database with a recording handler;
  `stream-proxy.ts` is a byte-forwarding TCP proxy that cuts connections on demand (the one
  transport fault the binary cannot produce when asked). `stream-measure.ts` is the catch-up
  measurement of `docs/perf/B150b-stream.md`, not a test; it and `send-time-measure.ts` take a
  connector name (`pocketbase` by default, or `iglo.base`) for `docs/perf/B162c-connectors.md`.
