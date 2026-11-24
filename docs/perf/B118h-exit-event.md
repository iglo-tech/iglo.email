# B118h: one exit per event, one read per page

Round 1 review (PR #211, comment 7127828585, blocker 2): `eventLinks` ran one lookup per exited enrollment
on the page, and each lookup read every event of the subscriber with the exit's name, then sorted them.
Round 2 chooses every exit of a page in one read (`createExitShown().shownOn`, `event-exits-shown` in
`src/events/store.sql`). No index and no migration are added.

## Setup

- macOS arm64 host, `bun` 1.4.5, one file database (`openDatabase`, WAL), the production migrations.
- One subscriber with 200,000 events of one name (`page_view`), received one second apart, so each
  receive time is held by one event. One sequence, triggered and exited by `page_view`, `reentry: always`.
- Every event on page 1 (the newest 100 at `per_page=100`) carries one exited enrollment whose
  `finished_at` is that event's receive time and whose trigger is the event before it. So each of the
  page's 100 events shows one exit.
- A tab load is the events store's page (`events-page` and `events-count`) and the enrollments' event
  links for that page (`eventLinks`), through the production functions. Five loads per repetition, the
  median is reported; three repetitions.
- The script is `test/events/measure-exit-shown.ts`, run as
  `bun test/events/measure-exit-shown.ts 200000 100 3 5`.

## Before and after

"Before" is the head before this round (one lookup per exit, `event-exit-shown`). "After" is this round.

| Read | Before (per-exit lookups) | After (one read per page) |
| --- | --- | --- |
| Page and count, `per_page=100` | 29.7, 29.6, 29.6 ms | 29.5, 29.6, 29.6 ms |
| Events tab (page, count and links), 100 exits | 2,386.7, 2,390.1, 2,387.5 ms | 62.2, 62.6, 62.4 ms |

Median of the three repetitions: Events tab **2,387.5 ms before, 62.4 ms after**; page and count 29.6 ms.
The Events tab is now 2.1 times the page and count, against the target of about 2 times (the round-1
target was within about 2 times of 28.6 ms, which is the page and count alone).

The last 32 ms are one pass over the subscriber's events with the exits' names. `EXPLAIN QUERY PLAN` of the
new statement at this seed:

```
SCAN j VIRTUAL TABLE INDEX 1:                       -- the exits, from json_each
CORRELATED SCALAR SUBQUERY 6
MATERIALIZE cand
SEARCH events USING INDEX idx_events_subscriber_name_time (subscriber_id=? AND name=?)
LIST SUBQUERY 2 / SCAN j VIRTUAL TABLE INDEX 1:      -- the name list
LIST SUBQUERY 3 / SCAN j VIRTUAL TABLE INDEX 1:      -- the receive-time list
CREATE BLOOM FILTER
SEARCH c USING AUTOMATIC COVERING INDEX (name=? AND created_at=?)
CORRELATED SCALAR SUBQUERY 5
SEARCH t USING INTEGER PRIMARY KEY (rowid=?)
USE TEMP B-TREE FOR ORDER BY                         -- the exits, 100 rows
```

The page and count plans are unchanged:

```
events-page:  SEARCH events USING COVERING INDEX sqlite_autoindex_events_1 (subscriber_id=?)
              USE TEMP B-TREE FOR ORDER BY (the page's IDs)
events-count: SEARCH events USING COVERING INDEX sqlite_autoindex_events_1 (subscriber_id=?)
```

The cost of the new read is the `MATERIALIZE cand` step: it visits the subscriber's events of the name
through `idx_events_subscriber_name_time` and reads each row's `created_at`, which is not in that index.
That is one row read per event of the name, about the cost of the count. Only an index on
`(subscriber_id, name, created_at)` would remove it. That would be a migration and needs a decision, so
it is not added here (round-1 lead decision).

## Mutants

Tests are numbered in file order in `test/scheduler/exit-one-event.test.ts`: 1 two events of one name
in one batch, 2 an enrollment started by the batch's first event, 3 a trigger of another name at the
same time, 4 the page-only case, 5 two exits of one name an hour apart, 6 another subscriber's event
in the same batch.

Each mutant was applied to a `git archive` export of the commit in the Linux arm64 container
(`oven/bun:1.4.5`), never to the repository. The export's file was restored from its copy and checked
with `cmp` after each run; no mutant was committed. The first four rows were re-run this round against
the test file at `ec8f4b2d`, each a one-line `sed` on `src/events/store.sql`:

| Mutant | Tests that failed |
| --- | --- |
| Drop `c.created_at = w.at` from the exit choice (round 3, backlog 1) | 5 (`two exits of one name an hour apart`) |
| Drop `subscriber_id = ?1` from the candidates (round 3, backlog 2) | 6 (`another subscriber's same-named event`) |
| Trigger check keeps `t.name = w.name` (round-1 blocker 1) | 3 (`whatever the trigger's name`) |
| The trigger never counts | 2, 3 |
| Every same-named event of the page gets the exit (old loop) | 1, 2, 3, 4 (all four; carried forward from round 2, not re-run) |
| The page-local lowest ID is shown, not the subscriber's | 2, 3, 4 (carried forward from round 2, not re-run) |

The last two rows were run in round 2 under the earlier numbering (where the trigger-name test was 4
and the other-page test was 3) and are carried forward with the renumbering. They are not one-line
`sed` edits, so they were not re-run this round; the product code they mutate has not changed since
`a33a3ab7`.

Test 1 (two same-named events in one batch) is caught by the old-loop mutant, test 4 (the other page)
by the page-local mutant and the old loop, and test 5 by dropping the receive-time match.
