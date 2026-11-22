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

## The public "all lists" exit and the single-list exit

The all-lists option's enrollment exit is one `UPDATE` by `subscriber_id`, which the existing `(subscriber_id,
sequence_id)` index serves, and it runs once per click on the public page. The single-list exit (`exit-by-lists`)
gains one filter on the step: it reads the same enrollments the statement already reads, and its step check is an
`IN` over the sequence steps' kinds. Neither was timed separately. A click is a person's request, not a loop, and
both statements touch only one subscriber's enrollments. The suppression the option writes is one `suppressed` read
and at most one insert, as a self-wipe writes.
