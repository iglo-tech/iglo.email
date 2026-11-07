# B37: shared send-rate cap measurements

Performance measurements for task B37 (Decision [D92](../design/09-decisions.md#d92-one-shared-send-rate-cap-for-ses-lead-2026-11-07)).

Measured on the compiled executable (`dist/iglo.email`, executable `2612facff61ef983`) on Linux x86-64 using the campaign throughput harness (`test/perf/m61/mixed.ts`, scenario `campaign`) with a loopback SMTP sink. Raw measurements recorded in [B37-results.jsonl](B37-results.jsonl).

Configuration: campaign workers `app.concurrency = 8`, `app.message_rate = 10` (configured campaign ceiling: 80 messages/s), `app.batch_size = 1000`, 3,640 preconfirmed subscribers, 30 s measurement window.

## Campaign Alone Throughput Comparison

| Setting | Cap (`messaging.max_send_rate`) | Messages Delivered in Window | Throughput (messages/s) | Min / Max 10 s Bucket (/s) | Max in any 1 s Window | Server Peak RSS |
|---|---|---|---|---|---|---|
| Before (origin/main `9b65896`, no limiter) | N/A (no cap) | 2,391 | 79.7 | 78.5 / 80.3 | 88 | 109 MiB |
| After: Cap 0 (disabled) | 0 | 2,395 | 79.83 | 79.6 / 80.0 | 88 | 112 MiB |
| After: Default Cap (SES production) | 14 | 413 | 13.77 | 13.7 / 13.8 | 14 | 92 MiB |
| After: High Cap (hot-path overhead test) | 1,000 | 2,400 | 80.00 | 79.9 / 80.1 | 88 | 112 MiB |

## Observations

1. **Pacing Accuracy:**
   With the default SES production limit (`messaging.max_send_rate = 14`), delivery is paced smoothly at 13.77 messages/s across the 30-second window. In every one-second window, the maximum number of messages dispatched is exactly 14, perfectly conforming to the Amazon SES account rate limit.

2. **Hot-Path Limiter Overhead:**
   Comparing Cap 0 (limiter disabled) at 79.83 messages/s and High Cap 1,000 (limiter token checking on the active send path) at 80.00 messages/s against the baseline before B37 (79.7 messages/s from M6.1b) demonstrates that the in-memory token bucket and priority queue introduce zero measurable throughput degradation on the hot path when capacity is available.
