# B37: shared send-rate cap measurements

Performance measurements for task B37 (Decision [D92](../design/09-decisions.md#d92-one-shared-send-rate-cap-for-ses-lead-2026-11-07)).

Measured on the compiled executable (`dist/iglo.email`, baseline `eace43d15c975043` on `9b65896`, after `0d94d7321a6aa312` on `69d2381`) on Linux x86-64 using the campaign throughput harness (`test/perf/m61/mixed.ts`, scenario `campaign`) with a loopback SMTP sink. Raw measurements recorded in [B37-results.jsonl](B37-results.jsonl).

Configuration: campaign workers `app.concurrency = 8`, `app.message_rate = 10` (configured campaign ceiling: 80 messages/s), `app.batch_size = 1000`, 3,640 preconfirmed subscribers, 30 s measurement window.

## Campaign Alone Throughput Comparison

| Setting | Cap (`messaging.max_send_rate`) | Messages Delivered in Window | Throughput (messages/s) | Min / Max 10 s Bucket (/s) | Max in any 1 s Window | Server Peak RSS |
|---|---|---|---|---|---|---|
| Before (origin/main `9b65896`, no limiter) | N/A (no cap) | 2,381 | 79.37 | 78.1 / 80.2 | 88 | 110 MiB |
| After: Cap 0 (disabled) | 0 | 2,399 | 79.97 | 79.6 / 80.3 | 88 | 113 MiB |
| After: Default Cap (SES production) | 14 | 412 | 13.73 | 13.7 / 13.8 | 15 | 101 MiB |
| After: High Cap (hot-path overhead test) | 1,000 | 2,400 | 80.00 | 80.0 / 80.0 | 88 | 113 MiB |

## Observations

1. **Pacing Accuracy:**
   With the default SES production limit (`messaging.max_send_rate = 14`), delivery is paced smoothly at 13.73 messages/s across the 30-second window (13.7 / 13.8 in 10 s buckets). The limiter's own starts never exceed the cap: each start is at least one interval (1000 / 14 ms) after the last, so a one-second window holds at most 14 starts. The 15 in the table is wall-clock arrival jitter at the loopback sink, not a limiter overrun. The run does not show conformance to the SES account limit; the injected-clock tests check the cap (test 1 of `test/messaging/send-rate.test.ts`).

2. **Hot-Path Limiter Overhead:**
   Comparing Cap 0 (limiter disabled) at 79.97 messages/s and High Cap 1,000 (limiter check on the active send path) at 80.00 messages/s against the baseline before B37 (79.37 messages/s on clean `origin/main`) demonstrates that the in-memory rate limiter introduces zero measurable throughput degradation on the hot path when capacity is available.

3. **Low-Cap Under Concurrent Load:**
   A 20-second run at cap 1 (`messaging.max_send_rate = 1`) under concurrent campaign, sequences, and transactional load (`POST /api/tx`) produced 219 queued sends and 10 sending in the outbox at window end, with 0 failed outbox rows and 0 failed transactions (`tx.failed = 0`, `events.failed = 0`). Waiters delayed by the limiter do not time out against the 60 s cutoff and nothing is marked failed. A 20-second run cannot show the 60 s cutoff itself: that is covered on the injected clock by test 1b (`test/messaging/send-rate.test.ts`), which advances past 60 s.

## B53: per-send abort controller (2026-11-08)

Item 6 of the final nits sweep (B53) allocates the `AbortController` of a send-rate wait in `src/messaging/email.ts` only when a wait bound is in use (the SMTP settings test). Other sends pass no signal, because the limiter's `stop()` already rejects every waiter. The change is on the per-message path, so it was measured with the B37 harness (`bun run perf:mixed campaign`, cap 0, 30 s window, same configuration as above). The rows are the last four records of [B37-results.jsonl](B37-results.jsonl).

| Run | Variant | Executable | Delivered in window | Throughput (messages/s) | Min / Max 10 s bucket (/s) | Server peak RSS |
|---|---|---|---|---|---|---|
| 1 | Before (`email.ts` at `e9a38cd`) | `38ffbf17227d5598` | 2,370 | 79.00 | 77.2 / 80.2 | 113 MiB |
| 2 | Before (`email.ts` at `e9a38cd`) | `311934895f02d0aa` | 2,374 | 79.13 | 77.6 / 80.2 | 112 MiB |
| 3 | After (per-send controller removed) | `b9198511b6083164` | 2,406 | 80.20 | 79.8 / 80.8 | 116 MiB |
| 4 | After (per-send controller removed) | `b9198511b6083164` | 2,386 | 79.53 | 78.5 / 80.3 | 110 MiB |

Run 1 is the untouched `e9a38cd`. Run 2 was built with the other B53 source changes (a comment in `src/main.ts`, and the empty-`auth_protocol` rule in `src/settings/validate.ts`, neither on the campaign path) and with `email.ts` still at `e9a38cd`, so the executable hashes differ. Both "after" runs use the same executable.

Means: before 79.07 messages/s, after 79.87 messages/s. The spread between runs of one variant (about 1.2 messages/s) is as large as the gap between the variants, and all four runs sit within 79 to 80.2 messages/s, the same band as the B37 runs above. **The difference is noise.** There is no throughput regression, and the change removes an allocation per message without changing any send.
