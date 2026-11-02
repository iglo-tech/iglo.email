# B5 reschedule: time and write-lock hold on a large waiting set

Measured on 2026-11-02 on the shared t3-code VM (6 vCPU, Linux 6.12, Bun 1.4.4), serially, with
nothing else running. `bun run sequences:measure:reschedule 100000 3` (`test/sequences/measure-reschedule.ts`)
runs in-process on a real file under `upstream/measurements` (never tmpfs): 100,000 active
enrollments wait on one step whose wait changes from PT1H to PT3H. A scheduler-like loop does one
short `BEGIN IMMEDIATE` write per event-loop turn the whole time; the longest gap between its turns
is the longest it waited for the write lock. These are synthetic numbers for this host, not capacity
guarantees.

Main has no reschedule, so "before" is the obvious one-statement alternative (the whole set in one
write transaction), the thing the bounded batches replace. "After" is the endpoint's batches of 500,
each its own write transaction, with a turn of the event loop between them. Neither sends or advances
anything. Three runs each.

| | Writes | Total | Longest lock hold (p50 / max per write) | Scheduler's longest wait |
|---|---|---|---|---|
| Before: one transaction | 1 | 503, 542, 558 ms | 503, 542, 558 ms | 503, 543, 558 ms |
| After: batches of 500 | 201 | 5.60, 5.78, 5.88 s | 27–29 ms p50; max 53, 99, 153 ms | 53, 99, 153 ms |

Rescheduling costs about ten times the wall time of one statement (the rows are read, recomputed in
code and written one at a time, since a step's start depends on the trigger event and a test's cap),
but no writer, including the scheduler's claim, waits more than a batch. The occasional 50–150 ms
maximum is a batch that overlapped a WAL checkpoint, not a longer batch. Enrollments whose recomputed
time is already due are paced by the scheduler's normal claim limit afterwards, not by this endpoint.

## Round 1: bounded batches with an index (migration 15)

Review found that each batch scanned and sorted every active enrollment of the sequence
(`idx_enrollments_sequence_status`, then a temp B-tree for `ORDER BY id`). Migration 15 adds
`idx_enrollments_step_active(step_id, id) WHERE status = 'active'`; the plan is now
`SEARCH e USING INDEX idx_enrollments_step_active (step_id=? AND id>?)` with no sort. Same host and
method, two-step sequences, batches of 500, three runs each. "Before" drops the index and keeps the
first version's query (`MEASURE_NO_INDEX=1`); the table is per-write lock hold and total time.

| Waiting set | Before: p50 / max hold, total | After: p50 / max hold, total |
|---|---|---|
| 100,000 on step 1, none elsewhere | 28.5–33.6 ms / 59–187 ms, 5.8–7.2 s | 5.2–5.7 ms / 18–23 ms, 1.27–1.36 s |
| 20,000 on step 1, 100,000 on step 2 | 26.8–28.9 ms / 41–47 ms, 1.15–1.23 s | 9.7–10.3 ms / 30–49 ms, 0.45–0.52 s |

A batch no longer pays for rows of other steps or for the rest of its own step, and the 100,000-row
reschedule is about five times faster than first measured. The new numbers carry the round-1
changes too (recomputed times are clamped to now; a row in retry backoff is rewritten and not
counted), which add no query. The earlier tables above are the first version and are kept for the
record.
