# B108: test-send records (D114)

Cost of recording each step and campaign test send in `test_sends` (migration 22), of the
request that writes it, and of the lookup an unmatched SES notice pays. Decision:
[D114](../design/09-decisions.md#d114-test-sends-leave-a-trace-lead-2026-11-19).

## Setup

- Host: Apple silicon macOS workstation, 8 cores, shared with other sessions. Load averages
  were 3 to 35 during these runs; the load before and after each run is recorded below.
- Runtime: `oven/bun:1.4.4` on `linux/arm64` (OrbStack Docker), as the non-root `bun` user, with
  `--cpus=6`. Durability is SQLite's default `synchronous = FULL`, as in production.
- Commits: before is `origin/main` (`9e5ad7a`); after is the B108 branch.

## Measurements

Median of 100, serial, on the in-process scheduler fixture (real SQLite file, real SMTP sink).

| Operation | Before (`origin/main`) | After (B108) | Notes |
| --- | --- | --- | --- |
| Step test request, HTTP, one address | 0.25 ms | 2.62 ms | After includes the `test_sends` write; the message is queued in both |
| Recording one test send (one write transaction) | not present | 1.95 ms | `test/messaging/measure-test-sends.ts`; one row, `BEGIN IMMEDIATE` to `COMMIT` |
| Unmatched notice lookup, table of 100 rows | not present | 2.1 µs | Indexed `message_id`; a notice with no test record pays this once |
| Unmatched notice lookup, table of 100,100 rows | not present | 1.7 µs | Same lookup at the size of a busy week's test records |

The request delta (about 2.4 ms) is the durable write of one row, one fsync per commit. A test
send is started by a person or an agent, one at a time, with at most four in flight (D105, D109),
so the cost is not on any send path. A bounce or complaint notice pays the lookup only when it
carries a Message-ID; a native `POST /webhooks/bounce` pays nothing.

Commands (run in the container, after `bun install --frozen-lockfile`):

```sh
bun test/messaging/measure-test-sends.ts 100        # record, request and lookups (this branch)
```

The "before" request figure is the request part of that script (the same loop, without the
record and lookup steps), run once on an export of `origin/main`. That loop was a scratch script
and is not committed, because `origin/main` has no `test_sends` for the record step to need.

## Release gate: `bun run check`

Ten consecutive valid passes on the release commit, in the arm64 container, `--cpus=6`. Two
earlier runs were invalid under the gate's rule: each failed only on real-time wall limits (a
30 s per-test timeout, a 60 s runner wait, and 3 s and 15 s harness waits), with the load above
the 8 cores, and the tests' own state showed progress. Their failure text was not captured in the
first run; the second run's are recorded in the PR.

| Run | Load before | Load after | Result |
| --- | --- | --- | --- |
| 1 | 11.5 | 28.7 | invalid: 1 wall-bound timeout (scheduler starvation test, 29.8 s of 30 s) |
| 2 | 28.6 | 33.3 | invalid: 3 wall-bound timeouts (runner 180 of 300 sent at its 60 s wait; scheduler 15 s wait; B37 1b 3 s wait with 70 sends in flight) |
| 3 | 34.5 | 9.8 | pass, 1535 of 1535 |
| 4 | 9.5 | 7.6 | pass, 1535 of 1535 |
| 5 | 7.6 | 5.3 | pass, 1535 of 1535 |
| 6 | 4.9 | 4.7 | pass, 1535 of 1535 |
| 7 | 4.7 | 5.7 | pass, 1535 of 1535 |
| 8 | 5.7 | 4.1 | pass, 1535 of 1535 |
| 9 | 3.9 | 4.9 | pass, 1535 of 1535 |
| 10 | 4.6 | 4.4 | pass, 1535 of 1535 |
| 11 | 4.2 | 4.4 | pass, 1535 of 1535 |
| 12 | 4.4 | 5.1 | pass, 1535 of 1535 |

Each passing run: 140 files, 1535 tests, 0 failures, no type errors, format and lint clean.

## Other acceptance steps (container, same commit)

`ui:verify`; the bubblewrap probe (as uid 1000, seccomp and AppArmor unconfined); `templates:compiled`;
`contract:templates`, `contract:normal`, `contract:auth`, `contract:roles`, `contract:lists`,
`contract:subscribers`, `contract:settings`, `contract:sends`, `contract:fixture`,
`contract:messaging`, `messaging:fixture`: all exit 0. `bun test test/server`: 19 pass.
`bun test test/contract`: 48 pass. `bun run sends:production` (root, Docker socket, host
networking): exit 0.
