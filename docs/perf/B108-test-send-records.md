# B108: test-send records (D114)

Cost of recording each step and campaign test send in `test_sends` (migration 22), of the
request that writes it, and of the lookup an unmatched SES notice pays. Decision:
[D114](../design/09-decisions.md#d114-test-sends-leave-a-trace-lead-2026-11-19).

## Setup

- Host: Apple silicon macOS workstation, 8 cores, shared with other sessions. The load before and
  after each run is recorded below; every gate run was below 8 on the final head.
- Runtime: `oven/bun:1.4.4` on `linux/arm64` (OrbStack Docker), as the non-root `bun` user, with
  `--cpus=6`. Durability is SQLite's default `synchronous = FULL`, as in production.
- Commits: before is `origin/main` (`9e5ad7a`); after is the final head `b32777f`.

## Measurements

Median of 100, serial, on the in-process scheduler fixture (real SQLite file, real SMTP sink).

| Operation | Before (`origin/main`) | After (`b32777f`) | Notes |
| --- | --- | --- | --- |
| Step test request, HTTP, one address | 0.25 ms | 2.53 ms | After includes the `test_sends` write, which now precedes the hand-off to the emailer; the message is queued in both |
| Recording one test send (one write transaction) | not present | 2.00 ms | `test/messaging/measure-test-sends.ts`; one row, `BEGIN IMMEDIATE` to `COMMIT` |
| Unmatched notice lookup, table of 100 rows | not present | 2.2 µs | Indexed `message_id`; a notice with no test record pays this once |
| Unmatched notice lookup, table of 100,100 rows | not present | 1.8 µs | Same lookup at the size of a busy week's test records |

The request delta (about 2.3 ms) is the durable write of one row, one fsync per commit. A test
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

## Release gate: `bun run check` on `b32777f`

Ten consecutive valid passes on the final head, in the arm64 container, `--cpus=6`, each run
1538 tests in 140 files with 0 failures, no type errors, format and lint clean.

| Run | Load before | Load after | Result |
| --- | --- | --- | --- |
| 1 | 1.80 | 4.50 | pass |
| 2 | 4.50 | 4.12 | pass |
| 3 | 3.87 | 4.17 | pass |
| 4 | 4.17 | 4.81 | pass |
| 5 | 4.81 | 5.01 | pass |
| 6 | 4.85 | 4.59 | pass |
| 7 | 4.59 | 4.85 | pass |
| 8 | 4.85 | 4.29 | pass |
| 9 | 4.29 | 4.65 | pass |
| 10 | 4.67 | 4.66 | pass |

The earlier head `3764203` had two invalid runs under the gate's rule (real-time wall limits only,
load above the 8 cores, the tests' own state showing progress) and then ten passing runs. Those
are superseded by the table above.

## Other acceptance steps (container, same commit)

`ui:verify`; the bubblewrap probe (as uid 1000, seccomp and AppArmor unconfined); `templates:compiled`;
`contract:templates`, `contract:normal` (58 passed), `contract:auth`, `contract:roles`, `contract:lists`,
`contract:subscribers`, `contract:settings`, `contract:sends`, `contract:fixture`,
`contract:messaging`, `messaging:fixture`: all exit 0. `bun test test/server`: 19 pass.
`bun test test/contract`: 48 pass. `bun run sends:production` (root, Docker socket, host
networking): exit 0.
