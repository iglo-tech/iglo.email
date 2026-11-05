# B10: product defects

Measured on this host (Linux, Bun 1.4.4), in-process or through the compiled build, single runs.

## Session purge (storage; `src/users/queries.sql`)

200,000 sessions, half with a stored expiry and half without (created with milliseconds), all
expired; 100 rows a pass as in the retention loop, in-memory SQLite with the real migrations.

| | Passes | p50 | p95 |
|---|---:|---:|---:|
| Before (index expression only) | 2,001 | 0.398 ms | 0.557 ms |
| After (also the exact-millisecond check for rows with no expiry) | 2,001 | 0.466 ms | 0.615 ms |

The extra check runs on rows the index already selected, so a pass costs about 0.07 ms more and
still reads the same rows.

## Reschedule query (storage; `src/sequences/enrollments.sql`)

The `INDEXED BY` clause is gone. `EXPLAIN QUERY PLAN` of the query without it:
`SEARCH e USING INDEX idx_enrollments_step_active (step_id=? AND id>?)`, the plan B5 recorded
with the clause. With the index dropped the query now runs (200) instead of failing (500), so
B5's no-index "before" run can be repeated (`MEASURE_NO_INDEX=1`).

## Attachment budget (sending; `src/tx/gate.ts`, `src/tx/routes.ts`)

Counted bytes and the 64 MiB budget are unchanged. Two outcomes change, shown by
`test/tx/tx.test.ts` (both fail on the previous code):

| Request while the budget is full | Before | After |
|---|---|---|
| A JSON send with a 400-byte embedded image, while a 5 MiB upload waits | 429 at once | journaled, 200 |
| A multipart body declaring 6 MiB (over the 5 MiB cap) | waited 2 s, 429 | 413 at once |

## Provider webhooks (sending; `src/main.ts`)

`test/contract/bounces.ts` posts 400 requests from one client to the Mailgun route in under a
minute against the compiled build: all answer 406 (refused signature) after the change; the 301st
answered 429 before it. The budget is 6,000 a minute per client, in memory, 10,000 clients at most.
