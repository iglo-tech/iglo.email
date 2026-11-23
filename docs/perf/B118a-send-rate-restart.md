# B118a: send-rate restart boundary

Decision: [D140](../design/09-decisions.md#d140-runtime-edges-the-send-rate-restart-the-tx-yield-a-silent-smtp-server-and-a-recorded-marketing-step-b118a-lead-2026-11-23) item 1.

## The boundary

The limiter (`src/messaging/rate.ts`) keeps its schedule in memory. Before this change its start set
`lastGrantAt = 0` and `nextAvailableAt = 0`, so the first send after a start was granted at once, even
when the previous run had sent a message a moment earlier. The B120 trace had a send 50 ms after the
last one before a restart at a rate of one per second.

Now a start counts as the last grant: `lastGrantAt` is the start time and `nextAvailableAt` is one
interval after it. The first send after a start waits one interval.

## Cost

Only the first send after each start waits. Steady state is unchanged.

| rate (per s) | wait for the first send after a start |
| --- | --- |
| 14 (the default) | 1000/14 ms, 72 ms when rounded up |
| 5 | 200 ms |
| 1 | 1000 ms |
| 0 (no cap) | none |

## Measurement

`test/messaging/rate-restart.test.ts` uses the injected clock, so the numbers are exact and need no
host load:

- Before the change, a limiter started at `T0` granted at `T0`, and a limiter started 50 ms after a
  grant at `+50 ms`: the first assertion (the first grant waits one interval) fails on the old code,
  and the restart assertion shows the 50 ms gap.
- After the change, the first grant is at `T0 + 1000 ms`, and the restarted limiter's first grant is at
  `restart + 1000 ms` (the restart at `+1050 ms` grants at `+2050 ms`).

The HTTP-level suite `test/messaging/send-rate.test.ts` (14 tests) passes after its three test
premises were updated: test 1 starts its warm-up's clock drive while the request waits, test 5b measures
from after its first send, and test 5c advances past the first interval before its first grant. The
suite passed 14/14 on the original limiter before the change, so those updates change the test's
premise, not its assertion.

## Mutation

Removing the start anchor (`lastGrantAt = 0; nextAvailableAt = 0`) fails the first test and the restart
test with the old timing, as above.
