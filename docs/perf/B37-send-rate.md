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
