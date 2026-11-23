# B117d send names: the send path's write cost, before and after

D139 writes a send's template and sequence names when it is queued, so a deleted template or sequence
keeps them. The queue write now reads each distinct template and step it names (one primary-key lookup each,
inside the queueing transaction), writes two more columns, and the claim and settle statements read two
more columns in their row. This note measures that write path at a million sends, before and after.

## Method

- `test/sends/measure-names.ts`, run as `bun test/sends/measure-names.ts 1000000 20000 3`: one database
  migrated to the production schema, seeded with 1,000,000 sent transactional sends (no payload kept), then
  three repetitions. Each repetition queues 20,000 sends through `enqueueRequest` (1,000 recipients per request,
  one transaction each, every send naming a template), claims each one with `claimBatch` (one claim per
  transaction, the outbox's batch of one) and settles it with `finishAll` (one transaction each, outcome
  accepted). Medians of the three repetitions are reported, with the min and max.
- The script calls only the journal's own functions. The names callbacks are the statements the templates
  module runs (`template-names`), so the lookup costs what the production lookup costs.
- Serial, on this macOS arm64 host, `synchronous = FULL`. The host was busy (load averages 11 to 27 during
  the runs; other agents' containers ran at the same time), so the spread between runs is the noise.
- "Before" is the base commit (`070d4d0c`, schema 29), run from the repository and from an export of that
  commit. "After" is this change (schema 31). The base runs and the after runs were interleaved in time, so
  both sides saw the same load where possible.

## Results (milliseconds, 20,000 sends per repetition)

| Run | Code | Insert, median (min–max) | Claim, median (min–max) | Settle, median (min–max) |
|---|---|---|---|---|
| 1 | base | 2,508 (1,579–4,299) | 11,287 (7,646–16,901) | 9,626 (6,473–13,937) |
| 2 | base | 4,002 (3,099–4,678) | 15,815 (14,813–41,048) | 12,969 (7,546–34,158) |
| 3 | after | 3,474 (3,001–3,544) | 20,160 (13,898–20,792) | 12,361 (6,086–15,421) |
| 4 | after | 2,103 (1,502–3,850) | 8,431 (6,670–10,808) | 7,054 (6,853–13,974) |
| 5 | base (export) | 2,023 (1,188–4,686) | 6,976 (6,004–10,289) | 9,041 (6,905–11,508) |
| 6 | after | 1,763 (1,252–1,843) | 7,572 (7,052–7,673) | 6,572 (5,912–6,672) |
| 7 | base (export) | 2,028 (2,009–2,079) | 8,020 (7,004–9,588) | 6,052 (5,054–6,937) |

Across the runs, the median of the four base runs is 2,268 ms insert, 9,653 ms claim and 9,333 ms settle; the
median of the three after runs is 2,103 ms, 8,431 ms and 7,054 ms. Every after median lies inside the range of
the base runs, so the change is within the host's noise at this scale. The statements that changed are the
insert (two more columns, and one template lookup per request) and the row read by each claim (two more
columns, from `SELECT *`); the claim and settle `UPDATE`s are the same statements as before.

## Migration 0031 at a million named sends

`migrations/0031_send_names.sql` adds `template_name` and `sequence_name` with no default (no row is
rewritten by the `ALTER`s), then names the existing sends from their template and step. One run on a
database of 1,000,000 sends that all name a template took 11,357 ms in total, including the runner's
pre-migration `VACUUM INTO` snapshot, which every upgrade of a non-empty database takes. All 1,000,000 rows
got their name. A send with no template or step is not written.

## Read cost

A send-log page now reads its template names from its own rows, so the per-page template lookup is gone. A
list-scoped reader's list and count add one membership subquery on `subscriber_lists`; an unscoped reader's
query is the same statement as before.

## Decision

The queue write's extra cost is one primary-key lookup per distinct template and step per request, and two
columns per row. The measurement shows no slowdown beyond the host's spread, so D139 keeps queue-time names.
