# B130 public defaults: before and after

B130 (D128) touches three paths the repository measures: the transactional data a send renders (`POST /api/tx`
and the sequence steps, with their previews), the sequence exit of the public "all lists" option, and migration
0028 on the sample transactional template. Measured on macOS arm64 under `bun` 1.4.5, in one process per script,
with the scripts in `test/perf/`.

## Transactional data (per request and per recipient)

`bun test/perf/b130-brand-data.ts`. "before" is the data text a recipient's template renders with on main (the
same string without the brand members); "after" adds them. The brand members are built once per request, not per
recipient, and the route appends the same string to each recipient's data.

| Measurement | Result |
|---|---|
| Brand members, one request (`brandMembers`) | 3.96 µs each (median of five runs of 200,000) |
| Data text per recipient, before | 0.005 µs each (below the noise of the loop) |
| Data text per recipient, after | 0.004 µs each (below the noise of the loop) |

The brand members add 289 characters to each recipient's data. A transactional send's cost is dominated by SMTP and
the database, so one request's 4 µs is not measurable in the existing send benchmarks; per-recipient the change is
a longer string, below the noise of this loop.

## Migration 0028 (the sample template)

`bun test/perf/b130-migration.ts`. Each run starts from a fresh in-memory SQLite holding the sample as the pre-B129
release seeded it, and an unrelated row. Migration 0027 runs untimed, so the sample holds the B129 body that 0028
matches, then 0028 is timed. The script checks that exactly the sample row changed.

| Version | Median | p95 |
|---|---|---|
| No migration (the B129 state) | 0 ms | 0 ms |
| Migration 0028, one `UPDATE` on the sample row | 0.012 ms | 0.021 ms |

The statement runs once per upgrade, on one row of a table of about twenty.

## The public "all lists" exit

The option's enrollment exit is one `UPDATE` by `subscriber_id`, which the existing `(subscriber_id, sequence_id)`
index serves, and it runs once per click on the public page. It was not timed separately: a click is a person's
request, not a loop, and the statement reads only the subscriber's enrollments. The suppression it writes is one
`suppressed` read and at most one insert, as a self-wipe writes.
