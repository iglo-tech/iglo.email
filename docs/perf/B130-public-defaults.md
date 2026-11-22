# B130 public defaults: before and after

B130 (D128) touches three paths the repository measures: the render of a transactional template (`POST /api/tx`,
sequence steps, and their previews), the sequence exit of the public "all lists" option, and migration 0028 on the
sample transactional template. The render comparison is the one that matters per message, and the first version of
this doc measured only a constant string; this version renders the real sample template.

## Render of the sample template, per recipient (base and head interleaved)

`bun test/perf/b130-brand-data.ts <checkout root> none|once|each`, run from the head tree with the base tree as the
other root. Both trees ran in one container (`oven/bun:1.4.5`, Linux arm64, `seccomp=unconfined` and
`apparmor=unconfined`), seven rounds, each round running base `none`, head `none`, head `once` and head `each` in turn.

Each run compiles the checkout's own `src/templates/builtins/sample-tx.tpl.txt`, then for each recipient builds the
data text as the route does and calls `renderSync` with one message budget, as `src/tx/routes.ts` does. Modes:

- `none`: the data a send carried before B130 (no brand members), with the sample as main has it (base) or as B130
  has it (head, the sample reads the brand values).
- `once`: the brand members built once per request and appended to each recipient's data. This is the tx route
  (`src/tx/routes.ts`).
- `each`: the brand members built for every render. This is the scheduler's step data (`src/sequences/step-data.ts`),
  which calls `brandMembers` once per step render.

Each run warms up with 500 renders, then takes 15 samples of 2000 renders. The fastest sample is the estimate,
because other load on the machine only slows a sample down; the median is printed beside it. Other agents were
running containers on the same host, which is why the medians vary more than the fastest samples.

| Variant | Fastest sample, median of 7 rounds | Added against base, paired per round (median of 7) |
|---|---|---|
| Base (main), data without brand | 9.2 µs | — |
| Head, sample reads the brand, data without brand | 13.3 µs | +4.2 µs, the new sample body |
| Head, brand once per request (tx route) | 17.4 µs | +4.0 µs over the line above; data 447 → 737 bytes |
| Head, brand per render (scheduler step data) | 23.9 µs | +6.8 µs over the tx route's figure |

In total, a transactional render costs about 8 µs more per recipient than on main, and a scheduler step render about
15 µs more. The brand members add 290 bytes to each recipient's data text. Against one SMTP send, which takes
milliseconds, both are small. The scheduler could build the brand members once per pass rather than per render;
that is not done, because the saving is a few microseconds per step.

## Migration 0028 (the sample template)

`bun test/perf/b130-migration.ts`. Each run starts from a fresh in-memory SQLite holding the sample as the pre-B129
release seeded it, and an unrelated row. Migration 0027 runs untimed, so the sample holds the B129 body that 0028
matches, then 0028 is timed. The script checks that exactly the sample row changed.

| Version | Median | p95 |
|---|---|---|
| No migration (the B129 state) | 0 ms | 0 ms |
| Migration 0028, one `UPDATE` on the sample row | 0.012 ms | 0.021 ms |

The statement runs once per upgrade, on one row of a table of about twenty.

## Enrollment exits: the index choice (B130 r2, blocker 1)

The all-lists option ends a subscriber's marketing enrollments (`exit-marketing-by-subscriber`), and the single-list
unsubscribe ends a list's (`exit-by-lists`). Both, and the block-list exit (`exit-by-subscribers`), are one `UPDATE`
per click. Without `ANALYZE` (the schema has no statistics), SQLite chose by its heuristics: with `status = 'active'`
beside the subscriber predicate, it searched the status-only claim index `idx_enrollments_claim (status=?)`, which
reads every active enrollment in the install for one subscriber. `+status = 'active'` (the `+` keeps the status
predicate from using an index) makes SQLite choose the subscriber index, `idx_enrollments_subscriber_sequence`.

`bun test/perf/b130-enrollment-exits.ts`: the production schema (every migration in the catalog), 200k subscribers,
603k active enrollments. The scoped list has three sequences (transactional, mixed, marketing) with 1,000 active
enrollments each; the other list has three sequences with 200k each. Each row is the median of 9 single-subscriber
runs, each in a transaction that is rolled back, after one warm-up run.

| Statement | Host | Before (e8985a93 SQL): plan, median | After `+status`: plan, median |
|---|---|---|---|
| `exit-by-lists` | macOS arm64, Bun 1.4.5, SQLite 3.54.0 | `idx_enrollments_claim (status=?)`, 44.8 ms | `idx_enrollments_subscriber_sequence (subscriber_id=? AND sequence_id=?)`, 0.044 ms |
| `exit-marketing-by-subscriber` | macOS | `idx_enrollments_claim (status=?)`, 38.3 ms | `idx_enrollments_subscriber_sequence (subscriber_id=?)`, 0.033 ms |
| `exit-by-subscribers` | macOS | `idx_enrollments_claim (status=?)`, 44.6 ms | `idx_enrollments_subscriber_sequence (subscriber_id=?)`, 0.058 ms |
| `exit-by-lists` | Linux (`oven/bun:1.4.5` container on the same host, aarch64, SQLite 3.54.1) | `idx_enrollments_sequence_status (sequence_id=? AND status=?)`, 0.218 ms | `idx_enrollments_subscriber_sequence (subscriber_id=? AND sequence_id=?)`, 0.021 ms |
| `exit-marketing-by-subscriber` | Linux | `idx_enrollments_claim (status=?)`, 34.5 ms | `idx_enrollments_subscriber_sequence (subscriber_id=?)`, 0.020 ms |
| `exit-by-subscribers` | Linux | `idx_enrollments_claim (status=?)`, 42.8 ms | `idx_enrollments_subscriber_sequence (subscriber_id=?)`, 0.041 ms |

The Linux `exit-by-lists` before-plan is the list's sequence index, `(sequence_id, status)`. Its cost grows with the
list's active enrollments, not one subscriber's; the scoped list is small here, so its number is low. The all-lists
and block-list exits, without the change, read every active enrollment in the install (the status-only index), which
is the 35–45 ms in both hosts' before rows. The `+status` predicate matches the same rows: every enrollment state
(waiting, due, deferred, retrying, claimed, paused sequence) keeps `status = 'active'`.

A click is a person's request, not a loop. The suppression the all-lists option writes is one `suppressed` read and at
most one insert, as a self-wipe writes.
