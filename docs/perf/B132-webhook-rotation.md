# B132: webhook secret rotation, before and after

B132 changes the delivery path (each attempt reads the webhook's secrets with its body, D130) and
the `webhooks` table (two columns, migration 26). Both are sending and storage work under AGENTS, so
this records the webhook harness on the merge base and on the head.

## Result

Three interleaved pairs (base, head, base, head, base, head) of `bun test/webhooks/measure.ts <executable> 1 1000`,
one webhook, 1000 events, in one `oven/bun:1.4.5` container (linux/arm64). Every run delivered 1000 of 1000.

| median of 3 runs, ms | base | head |
| --- | --- | --- |
| ingest p50 (`POST /api/subscriber-events`) | 1.58 | 1.09 |
| ingest p99 | 5.97 | 4.57 |
| unsubscribe p50 (one-click) | 1.62 | 1.59 |
| unsubscribe p99 | 3.56 | 3.80 |
| drain: 1000 deliveries reach the receiver | 32 | 31 |

**The 1.58 vs 1.09 ms ingest difference is warm-up, not the change.** The median of three pairs
keeps the slow early runs (base 2.38 and 1.58 ms, head 1.17 and 1.09 ms). The last pair alone is
1.05 vs 1.04 ms.

Per run, in the order measured:

| run | tree | load 1/5/15 | ingest p50 | ingest p99 | unsub p50 | unsub p99 | drain ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | base | 0.58 0.60 2.11 | 2.38 | 8.68 | 5.37 | 15.44 | 27 |
| 2 | head | 0.98 0.68 2.12 | 1.17 | 7.73 | 1.59 | 3.80 | 33 |
| 3 | base | 1.38 0.77 2.14 | 1.58 | 5.97 | 1.62 | 3.56 | 35 |
| 4 | head | 1.35 0.78 2.13 | 1.09 | 4.57 | 1.54 | 3.56 | 28 |
| 5 | base | 1.33 0.78 2.13 | 1.05 | 3.73 | 1.39 | 3.43 | 32 |
| 6 | head | 1.46 0.82 2.13 | 1.04 | 2.56 | 1.69 | 4.26 | 31 |

The first run (base) is the slowest on ingest and unsubscribe p50, which is warm-up on a cold
container, not the change. **The webhook path did not regress.** The drain measure cannot separate
the new read and the HMAC from host noise: the two trees agree to within a few milliseconds on
1000 deliveries.

## Setup

- Harness: `test/webhooks/measure.ts` from the head tree, for both trees, so the harness is the same.
  It drives the compiled executable over real HTTP with a loopback receiver (D122's block is turned
  off for it, as the harness states).
- Base: `efac462`, `origin/main` when the head was rebased. Executable SHA-256
  `bcc176c114482828291763ee95631ab908a67575d0643508aa56a0a9395fc21a`.
- Head: `db6c32c`, the B132 commit on that base (its content is commit `6bb61c1` before the rebase).
  Executable SHA-256 `fa462434bf68054e064ca183ff19eb6e52c6bcdaf845fc99108d3760f3b610c0`.
- Both built with `bun install --frozen-lockfile` and `bun run build` in one setup container, then
  timed in a second container, so the host is the same for every run.
- Load averages are the container's `/proc/loadavg` before each run. The host is shared with other
  agents' containers, so the load is not constant.

## What the change adds to the delivery path

- Each attempt reads the delivery's body with its webhook's secrets in one primary-key join
  (`delivery-signing`), in place of a read of the body alone. The join is on `webhook_deliveries.id`
  and `webhooks.id`, and `webhooks` holds at most 20 rows.
- Each attempt signs once per live secret. With no rotation in its window that is one HMAC, as before.
  Only a delivery during a rotation's overlap computes a second HMAC.
- The retention pass runs one `UPDATE` on `webhooks` per pass (`webhook-expire-secrets`), which
  touches no row unless a window has ended.

The extra HMAC during an overlap window is not measured separately. It is one hash over a small body
per attempt, and the attempt's own network request costs far more.
