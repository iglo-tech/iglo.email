# B117d send-log scope: the list-scoped page at a million sends

D139 limits a list-scoped reader's send log to the sends to subscribers on its lists. The page's membership
predicate runs on every page view and every count. This note measures the page at a million sends with 2 KB
payloads kept, before and after the predicate moved to the subscribers module, and the shapes that were
considered for it.

## Method

`test/sends/measure-scope.ts 1000000 3`, serial, on this macOS arm64 host (shared with other agents' work; the
load was 10 to 30 during the runs). The database is migrated to the production schema, then seeded with
1,000,000 subscribers, three lists (list 1 holds every subscriber, list 2 the first hundred, list 3 nobody) and
1,000,000 sent sends, each to a different subscriber, each with a 2 KB payload kept. The script runs no
`ANALYZE`: the server never runs it, and the planner's choice depends on the statistics it would store (an
earlier run with `ANALYZE` chose a different plan for the sparse lists and is not reported here).

Each page is the journal's own `list()`, as `GET /api/sends` calls it: page 1, 20 rows, the count and the
page. Medians of three runs, in milliseconds.

## The page, before and after

| Reader | Before (the branch at `0ba9ae0a`) | After (this change) |
|---|---|---|
| Unscoped (every send) | 10.9 (8.5–11.5) | 7.8 (6.4–11.0) |
| List of every subscriber | 1,649 (1,509–1,964) | 1,844 (1,823–2,254) |
| List of a hundred subscribers | 0.6 (0.5–0.6) | 0.5 (0.3–0.6) |
| List of nobody | 0.1 (0.1–0.1) | 0.1 (0.1–0.1) |

"Before" is the branch before this change, with the membership SQL inside the journal. "After" is the same SQL
moved to `inListScopeSQL` in the subscribers module, as the lead asked (AGENTS: a module owns its tables and
SQL). The planner sees the same statement, so the two sides measure the same plan; the differences are the
host's spread. The unscoped page reads the same statement as before.

## Predicate shapes considered

Each shape is the page's count and first page over the same database, with the journal's `ORDER BY id DESC
LIMIT 20`. The correlated form runs once on the two sparse lists, where it takes minutes.

| Shape | List | Count | Page |
|---|---|---|---|
| IN over the membership (the journal's predicate) | every subscriber | 857.9 | 985.7 |
| IN over the membership | a hundred | 0.1 | 0.4 |
| IN over the membership | nobody | 0 | 0 |
| `EXISTS` correlated on the membership key (the reviewer's form) | every subscriber | 383.4 | 0.1 |
| `EXISTS` correlated | a hundred | 410.3 | 8,542.4 |
| `EXISTS` correlated | nobody | 1,885.2 | 31,882.8 |
| IN over the membership, plus a covering index `(list_id, subscriber_id)` | every subscriber | 593.3 | 1,170.1 |
| IN over the membership, plus the covering index | a hundred | 0.2 | 1.0 |
| IN over the membership, plus the covering index | nobody | 0 | 0.1 |

(Milliseconds, medians of three; the correlated form's sparse lists are single runs.)

Reading the table:

- **`EXISTS` correlated** is faster only for a list holding everyone: its count is about half, and its page
  reads the newest 20 without sorting. For the sparse lists the planner scans the sends in id order and probes
  the membership for each row. A hundred members match about one send in ten thousand, so the first page reads
  about 200,000 rows (8.5 s); an empty list reads all million (31.9 s). Refused: the sparse lists are the common
  case, and a staff reader on a small list must not wait seconds.
- **The covering index** `(list_id, subscriber_id)` lets the membership subquery read a list's members from the
  index alone. It gives no gain on any list here: the sparse lists were already 0.1 ms without it, and the
  everyone list stays within the spread. Refused: a new index on a million-row table costs an upgrade build and
  storage for no gain.
- **The IN form** is kept. It is 0.1 ms for a hundred members and for nobody. Of the shapes here, only it is fast
  on the sparse lists without a new index.

## What remains

A list holding every subscriber at a million sends costs about 1.8 s a page (the count 0.86 s, the page 0.99 s),
against 8 to 11 ms unscoped. The count must visit each of the matching sends, and the page must order them
before taking 20, so the cost grows with the sends a reader may see, not with the list's size. No shape here
removes that: the count and the sort are over the matches. The target that the page be within a small factor of
the unscoped page holds for the lists that hold a small share of the sends (0.1 to 0.5 ms here), not for a list
that holds nearly all of them.

Options for the lead, not taken here: accept the cost (a staff reader with a list of everyone sees a
two-second page at a million sends); or keep a count per list, updated on each membership and send write, which
puts a write on the send path (measure before choosing it).

## Decision

The journal's list keeps the IN form over the membership, in the subscribers module's `inListScopeSQL`. No
index is added and no `EXISTS` form is used. The residual cost of a list that holds nearly every send is recorded
above and in D139.
