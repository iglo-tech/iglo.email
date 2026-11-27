# B164: SES quota reads when the send rate changes

B164 ([D192](../design/09-decisions.md#d192-backup-cli-on-older-instance-databases-and-the-ses-refresh-on-a-rate-change-b164-lead-2026-11-27))
changes when the SES account loop (`src/messaging/ses-account.ts`) reads `GetAccount`, which feeds
the dispatcher's quota guard. It adds no read at a steady rate. The counts below come from the
injected-clock tests in `test/messaging/ses-account.test.ts` (B164 cases), not from a timed run:
the loop's cost is its reads, one HTTP call each.

## Reads at a steady rate (unchanged)

| state | before | after |
|---|---:|---:|
| more left than `max(10% of the quota, rate × 300 s)` | 12 per hour | 12 per hour |
| at most that left | 60 per hour | 60 per hour |
| a rate change that does not shorten the wait | 0 extra | 0 extra |

## A raised rate mid-sleep

Quota 10,000, 6,500 sent (3,500 left), SES `MaxSendRate` 20, `messaging.max_send_rate` raised from
10 (line 3,000: 5-minute reads) to 14 (line 4,200: 1-minute reads) 30 s after a read.

| | before | after |
|---|---|---|
| next read after the raise | 300 s after the last read | 60 s after the last read |
| reads in the first 5 minutes after the last read | 2 (0 s, 300 s) | 6 (0, 60, 120, 180, 240, 300 s) |
| most sends between two reads at rate 14 | 14 × 270 s = 3,780 (up to 14 × 300 s = 4,200 for a raise just after a read) | 14 × 60 s = 840, the hold line's rate term |

Setting the rate to 0 (SES's own rate, 14) 90 s after a read: before, the next read came at 300 s;
after, it starts at once, since the minute from the last read is over, and then every minute.
