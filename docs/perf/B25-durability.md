# B25: FULL against NORMAL `synchronous` under the mixed load

Host: the shared VM, Bun 1.4.4, compiled build, `origin/main` at 36bb4a2. Command for each run:
`M61_WINDOW_MS=120000 bun test/perf/m61/mixed.ts mixed` (the body of `bun run perf:mixed` after its
build step; the build was done once per variant, see below). Each run started from a fresh data
directory (the harness makes one per run). Alternating F N F N F N, with `measurement.lock` and
`verify.lock` held for the whole series by one `flock … flock … series.sh` process. Raw result
lines: [`B25-results.jsonl`](B25-results.jsonl). Not CI thresholds.

**This series is not a quiet-host series.** The brief's rule is a 1-minute load below 2 at the
start of each run. The load was 2.97 at the first start and 4.1 to 7.1 at the others, because
other projects ran suites on this host. No run qualifies, so there are **0 clean pairs**. Per the
brief nothing waited or looped for quiet. The decision in D86 does not rest on these numbers (section 3), so no quiet-host re-run is queued:
no result could change it (lead, #77). The load average also counts processes waiting on disk
syncs, so part of the FULL-run load may be self-caused; the size of the FULL penalty is not
established either way.

## 1. Variants

| Variant | Source hash (`src/`, `migrations/`) | Executable hash    | Change                                                                                  |
| ------- | ----------------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| FULL    | `f0a566e557f4b247`                  | `a38181710ad279a8` | none: `origin/main`                                                                     |
| NORMAL  | `17130e2dd54eca82`                  | `8d394923b0338281` | `src/db/connection.ts` only: `synchronous = NORMAL` and the guard's expected value `1n` |

Both were built once, copied aside, and copied over `dist/iglo.email` before their runs. The NORMAL
edit was reverted after building and is not in the PR. The `executable` field in each result line
shows the order F N F N F N. (The harness's per-run console output files were overwritten by a
scripting slip; the JSONL, which the harness appends to, is complete and is the record.)

## 2. Results

Event, tx and campaign figures are the harness's. Load is `/proc/loadavg` 1-minute before and
after the run. "Outbox sent" is the outbox `sent` count at window end (transactional plus
sequence messages; the same 1,438 to 1,440 in every run, so the outbox kept up in all). Seed is the
subscriber-create phase before the window.

| Run | Variant | Load before → after | Seed (s) | Event p50 / p95 / max (ms) | Tx accept p95 (ms) | Tx delivery p50 / p95 (ms) | Campaign/s | Outbox sent | In-flight peak | MemAvail min (MiB) |
| --- | ------- | ------------------- | -------- | -------------------------- | ------------------ | -------------------------- | ---------- | ----------- | -------------- | ------------------ |
| 1   | FULL    | 2.97 → 4.60         | 47.6     | 10.4 / 52.5 / 122.8        | 38.4               | 40.4 / 190.3               | 78.70      | 1439        | 13             | 9743               |
| 2   | NORMAL  | 4.60 → 4.08         | 29.2     | 3.5 / 24.4 / 126.7         | 28.4               | 18.3 / 67.7                | 79.78      | 1440        | 13             | 9367               |
| 3   | FULL    | 4.08 → 5.48         | 64.9     | 19.9 / 52.5 / 120.3        | 41.1               | 104.9 / 186.7              | 78.88      | 1439        | 13             | 9219               |
| 4   | NORMAL  | 5.48 → 4.61         | 28.6     | 3.3 / 23.1 / 79.4          | 30.2               | 20.4 / 69.3                | 79.87      | 1440        | 8              | 9474               |
| 5   | FULL    | 4.61 → 7.11         | 73.8     | 32.7 / 70.8 / 272.4        | 63.4               | 138.9 / 253.7              | 75.87      | 1438        | 28             | 7990               |
| 6   | NORMAL  | 7.11 → 2.76         | 31.3     | 3.6 / 28.0 / 107.2         | 32.2               | 20.0 / 74.0                | 79.87      | 1440        | 11             | 10239              |

All six runs had zero failed events, zero shed requests and zero server error lines.

Reading, with the caveat that every run was disturbed:

- NORMAL was better in all three adjacent pairs on every latency column, and its three runs agree
  with each other (event p95 23.1 to 28.0 ms, seed 28.6 to 31.3 s). The three FULL runs do not
  agree (event p50 10.4, 19.9, 32.7 ms; seed 47.6 to 73.8 s) and are far worse than B11's quiet FULL
  runs (event p50 5.7 to 6.1 ms, p95 23.0 to 25.3 ms, seed 44 s).
- The likely reason is that FULL does one WAL `fsync` per commit and the other projects on this
  host share the disk, so a FULL run's latency follows the host's I/O load (it rose with the load
  in runs 1, 3, 5). NORMAL does no `fsync` per commit and was insensitive to it. So the size of the
  FULL penalty here (event p95 −55 % to −61 %) is inflated by the disturbance. B11's one disturbed
  NORMAL sample against two quiet FULL runs was close to FULL at p95 (21.9 against 23.0 to 25.3 ms),
  which is the quiet-host difference this series could not reproduce.
- Campaign throughput was at the 50/s target in every run, with and without the change.
- The max column does not separate the variants (79 to 272 ms for both).

## 3. Safety analysis

The facts used, from the SQLite documents ([`PRAGMA synchronous`](https://www.sqlite.org/pragma.html#pragma_synchronous),
[WAL](https://www.sqlite.org/wal.html)):

- WAL with FULL: "an additional sync operation of the WAL file happens after each transaction
  commit"; FULL is ACID in WAL mode.
- WAL with NORMAL: "no sync operations occur during most transactions". The WAL is synced before a
  checkpoint and the database file after one. The database "is always consistent" but "a transaction
  committed in WAL mode with synchronous=NORMAL might roll back following a power loss or system
  crash". It is durable across an application crash whatever the setting.
- Consequence for ordering (our reading, from the above and the WAL being one append-only file):
  loss after a power cut is a suffix of the commit sequence, not a hole. A later FULL commit syncs
  the WAL file, which holds every earlier frame, so everything committed before it, at NORMAL or
  FULL, is then durable.
- Not claimed: that `bun:sqlite` exposes anything more than the pragma, or that a second connection
  at another setting has been tested here. A power cut was not simulated.

What a lost commit means for each writer (each is one `BEGIN IMMEDIATE` on one connection):

| Writer                                                           | A lost commit means                                                                                                                                                                                                                                                                                                                         | Safe at NORMAL?                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Outbox claim (`sends` `queued` → `sending`)                      | After a power cut the row is `queued` again with `attempts` back, while the SMTP server may have accepted the message. The outbox claims it again: a **second send**. Marketing sends are at-most-once (D12) and never retried; a transactional retry only follows a proven non-acceptance (D24), which a rolled-back claim does not prove. | No                                                                    |
| Campaign batch claim and cursor advance                          | The cursor goes back, the batch is sent again to people who already got it: a **second send** (D12, `04-sending.md`: "the cursor is advanced for a batch before the batch is sent").                                                                                                                                                        | No                                                                    |
| Send outcome (`finishAll`, campaign progress)                    | A sent message is recorded as still `sending`. Today expiry moves it to `unknown`/`interrupted` (D80), never back to `queued`, so no second send, but the log and counters are wrong and `sent` webhooks (`ended`) that already fired are contradicted.                                                                                     | Not without losing recorded facts                                     |
| Event accept (`POST /api/subscriber-events`)                     | The client got 2xx; after a power cut the event is gone, with its sequence enrollment, exit and queued send. A **lost acknowledged write**. The client believes it is delivered and does not retry.                                                                                                                                         | No (acknowledged write)                                               |
| Tx accept (`POST /api/tx`, async journal)                        | 2xx returned, the journaled message is gone after a power cut: a **lost acknowledged write**.                                                                                                                                                                                                                                               | No (acknowledged write)                                               |
| Webhook delivery rows, subscriber/list/settings writes, sessions | Lost after a 2xx or a UI "saved"; a webhook delivery lost is an unsubscribe the app never learns of (D13).                                                                                                                                                                                                                                  | No                                                                    |
| Lease renew, maintenance purge, summary refresh                  | Redone by the next pass; nothing external depends on them.                                                                                                                                                                                                                                                                                  | Yes, but they hold the lock ~0.02 s per run and no gain is measurable |

The per-connection question. The idea: an events/tx-accept connection at NORMAL, claims at FULL.
By the WAL ordering above this would keep the **claim** guarantees: a claim commit at FULL syncs the
WAL and so also the earlier NORMAL frames, and a claim lost without a later FULL commit cannot
have been followed by an external send, since the send happens after the claim commit returns. The
risk of a NORMAL commit before the next FULL commit is only that it rolls back with the unsynced
tail. So duplicates stay impossible, and a later FULL commit hardens the earlier acknowledged
writes. But it does not fix the two rows that matter for the other criterion: an event or tx
accept that is acknowledged with 2xx is exactly the commit that may be the tail when power fails,
and nothing after it syncs. That is a lost acknowledged write by construction, and every one of the
latency gains the numbers show (event p50/p95, tx accept, tx delivery) comes from those two
writers. It would also need a second connection in `events` and `tx` (the writers share
transactions with sequence evaluation and the outbox queueing, which would then commit at NORMAL
too), `holdDataDirectory`, backup and migration handling for two handles on one WAL, and a
`synchronous` guard per connection. That is a storage change with no variant that meets both
criteria.

## 4. Outcome

D86 keeps FULL everywhere. No code changes, so no test and no before/after pair beyond this
series. The series is partial evidence only (disturbed, 0 clean pairs): it shows a consistent but
inflated gain and it needs a quiet-host series before any figure for the gain is quoted.
