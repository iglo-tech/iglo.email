# B131: event claim and conflict decision, before and after

Event ingest writes inside `writeTransaction`, which holds SQLite's single write lock, so the
conflict decision that B131 adds (D129) is storage work under AGENTS. This records the events
harness on the merge base and on the head.

## Setup

- Harness: `bun test/events/measure.ts events` (open-loop events at 100 per second for a 60 s
  window, against the compiled executable; `test/events/measure.ts`, D22). Each event in the
  scenario names both an e-mail and an `external_id` of a known subscriber.
- Runner: `oven/bun:1.4.5` (linux/arm64) on the same Docker host, one container for every run,
  `git archive` exports of the two trees, each built with `bun install --frozen-lockfile` and
  `bun run build`. Runs back to back: base 1 to 3, then head 1 to 3, one minute each.
- Base: `7021988`, the merge base of PR #185. Executable SHA-256 `61ed463d…4904a4`.
- Head: `6729a17`, the code of this PR before its measurement doc. Executable SHA-256
  `bcc176c1…fc21a`. Both executables are built from the same tree layout; the only difference is
  this PR's change.
- The host is shared with other agents' containers, so the load is not constant. `uptime` is the
  kernel's uptime in seconds and the 1, 5 and 15 minute load averages, read from `/proc` in the
  container.

## Results

| run       | uptime (s) | load 1/5/15 min | offered | ok  | shed | accept p50 | accept p99 | accept max | commit p99 | client-late p99 | in-flight peak | RSS peak MiB |
| --------- | ---------- | --------------- | ------- | --- | ---- | ---------- | ---------- | ---------- | ---------- | --------------- | -------------- | ------------ |
| base 1    | 693763     | 0.79 0.88 3.62  | 6000    | 6000 | 0   | 7.54 ms    | 35.06 ms   | 157.02 ms  | 30.24 ms   | 4.44 ms         | 16             | 99           |
| base 2    | 693826     | 0.90 0.89 3.43  | 6000    | 6000 | 0   | 7.20 ms    | 26.38 ms   | 57.04 ms   | 23.86 ms   | 4.61 ms         | 6              | 97           |
| base 3    | 693887     | 0.99 0.91 3.28  | 6000    | 6000 | 0   | 21.89 ms   | 164.77 ms  | 273.25 ms  | 161.78 ms  | 4.60 ms         | 28             | 99           |
| head 1    | 693950     | 1.50 1.09 3.18  | 6000    | 6000 | 0   | 13.30 ms   | 103.32 ms  | 245.01 ms  | 101.94 ms  | 4.61 ms         | 25             | 99           |
| head 2    | 694012     | 1.84 1.23 3.09  | 6000    | 6000 | 0   | 7.18 ms    | 69.82 ms   | 220.83 ms  | 67.72 ms   | 4.81 ms         | 23             | 98           |
| head 3    | 694074     | 1.09 1.15 2.94  | 6000    | 6000 | 0   | 7.15 ms    | 148.26 ms  | 253.90 ms  | 145.66 ms  | 4.69 ms         | 26             | 99           |

Every run achieved 100 events per second (6000 of 6000 answered 200), with no shed.

| median of 3 runs | base   | head    |
| ---------------- | ------ | ------- |
| accept p50       | 7.54 ms | 7.18 ms |
| accept p99       | 35.06 ms | 103.32 ms |
| accept max       | 157.02 ms | 245.01 ms |
| commit p99       | 30.24 ms | 101.94 ms |

`accept` is the server-side time from the request to its answer; `commit` is the part spent in the
write transaction; `client-late` is the driver's own lateness, which is the same on both trees
(about 4.5 to 4.8 ms at p99), so the spread is not the client.

## The lookups inside the write transaction

For each event that names both an e-mail and an `external_id`, the head makes one more indexed read
inside the write transaction: a lookup of the subscriber that holds the e-mail (`subscriber-by-email`).
The external-ID lookup that ingest already made decides which subscriber the event names. The
conflict decision then compares the two. The memberships of a holder are read only on the claim
path, when the holder has no external ID and is found by e-mail; the common case, a known subscriber
sending its own address with its external ID, reads nothing else. One indexed lookup should cost
well under a millisecond on this database.

This measurement does not isolate that cost. The p99 medians differ (35 ms for base, 103 ms for
head), but the ranges overlap (base 26 to 165 ms, head 70 to 148 ms), and the p50 medians are level
(7.5 ms and 7.2 ms). Three runs on a shared host cannot attribute the p99 difference to the lookup
rather than to load. Settling it needs more runs over more hours, or a measurement of the
transaction's own time that does not depend on the host.
