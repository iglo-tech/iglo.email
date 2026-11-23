# B117d send names: the send path's write cost and the upgrade, before and after

D139 writes a send's template and sequence names when it is queued, so a deleted template or sequence keeps
them. The queue write reads each distinct template and step it names (one primary-key lookup each, inside the
queueing transaction) and writes two more columns. A send queued before the upgrade stores no name, so the
upgrade rewrites no row. This note measures the queue write (transactional and sequence paths) and the upgrade
at a million sends with their payloads kept, before and after the change.

## Method

All runs are on this macOS arm64 host, serial, `synchronous = FULL`, with the production statements and
schema. The host was shared with other agents' work during the runs (load averages 10 to 30), so the spread
within each run is the noise to read the numbers against.

- "Before" is the branch's parent, `b06261a9` (schema 30), exported with `git archive` into
  `node_modules/.cache/b117d-base` and run from there. "After" is this branch (schema 31), run from the
  repository. The scripts are the same files; the base copy is a copy of each script.
- Every run seeds one million sent sends with a 2 KB HTML payload each (the journal keeps every payload; D70).
- Each repetition uses 20,000 sends. Medians of three repetitions are reported, with the min and max.

Scripts: `test/sends/measure-names.ts` (the transactional path), `test/sends/measure-sequence-names.ts`
(the sequence commit), `test/sends/measure-migration.ts` (the upgrade and the rejected backfill).

## Transactional path

`enqueueRequest` (1,000 recipients a request, one transaction each), `claimBatch` (one claim per transaction)
and `finishAll` (one transaction each). Every queued send names a template. Milliseconds per 20,000 sends.

| Code | Insert, median (min–max) | Claim, median (min–max) | Settle, median (min–max) |
|---|---|---|---|
| before (`b06261a9`) | 2,462 (2,104–3,038) | 10,572 (6,092–15,643) | 7,090 (4,984–7,369) |
| after | 1,375 (1,262–1,763) | 6,582 (6,514–7,359) | 6,108 (5,222–6,609) |

The after medians lie inside the before runs' ranges for claim and settle, and below them for insert, which
is the host's spread rather than a gain. The write path carries two more columns and one lookup per distinct
template per request. No slowdown is measured.

## Sequence path

`recordSequence` for each send, in its own write transaction, as the scheduler's commit does (the render and
the payload are prepared outside the timing). One enrollment per send, one step, the templates and sequences
modules' lookups (`template-names`, `step-labels`) run per send. Milliseconds per 20,000 sends.

| Code | Record, median (min–max) | Per send |
|---|---|---|
| before (`b06261a9`) | 8,141 (6,963–8,143) | 407 µs |
| after | 8,315 (6,353–8,870) | 416 µs |

The two primary-key lookups add about 9 µs a send, 2 per cent, inside the spread of both sides. The commit
(an fsync) costs about 400 µs a send. The lookups stay per send, as the lead asked: a per-batch read would
change the sequence commit for a gain below the noise.

## The upgrade at a million sends

The database before the upgrade is 4,322 MB: a million sends, each with its 2 KB payload, plus the templates
and sequences the measurement names.

| Step | Time | Database after | WAL after |
|---|---|---|---|
| Production upgrade, `runMigrations` (snapshot, then 0031) | 105.7 s | 4,322 MB, schema 31 | 0 MB |
| Pre-migration snapshot alone (`VACUUM INTO`, same database) | 49.1 s | — | — |
| 0031's statements in their transaction (the two `ALTER`s) | 14 ms | 4,322 MB, schema 31 | 0 MB |
| Control: the rejected backfill (`ALTER`s and two `UPDATE`s, one transaction, no snapshot) | 136.0 s | 4,322 MB, schema 30 | 4,120 MB |

The two `ALTER TABLE … ADD COLUMN` statements rewrite no row and leave the file the same size. The runner's
total is the cost every upgrade of a non-empty database pays: `VACUUM INTO` copies the database, then
`PRAGMA integrity_check` checks the copy before the hard link is made. Separately measured, the copy alone
took 49 s, so the check and the link account for the rest of the 106 s. The runner writes the copy beside the
database, so an upgrade needs free disk for it, as before this change.

The rejected backfill rewrites each existing send's record to hold its names. It filled 1,000,000 template
names and 500,000 sequence names and grew the WAL to the size of the table. The review measured 132 s and a
4.1 GB WAL for the same statements. D139 keeps the names of the sends that exist before the upgrade live,
until their template or sequence is deleted, and does not backfill them.

## Read cost

A page of the send log reads each row's stored names. A row that stores no template name (a send queued before
the upgrade) gets one lookup per page in the templates module, for that page's rows only; a row with a name
costs nothing extra. The sequence label of a row that stores no sequence name is the step label the page already
reads, so it adds nothing. The list-scoped page's membership cost is in
[`B117d-send-scope.md`](B117d-send-scope.md).

## Decision

The queue write's extra cost is two columns per row and one primary-key lookup per distinct template and step per
request; the sequence commit's is two lookups per send. Both are inside the host's spread at a million sends with
payloads kept, so D139 keeps queue-time names. The upgrade adds two columns and no row, and costs 14 ms on top of
the snapshot every upgrade takes. Backfilling the existing sends would cost 136 s and a 4.1 GB WAL at this size,
so it is not done.
