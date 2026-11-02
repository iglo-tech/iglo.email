# B6: send and media safety

Measurements for [D74](../design/09-decisions.md#d74-synchronous-attachment-sends-share-a-memory-budget-event-retention-joins-the-paced-loop).
Raw rows: [B6-results.jsonl](B6-results.jsonl). Host: the 16 GiB dynamic-memory VM, Bun 1.4.4, one
scenario per process, run serially in the foreground. Source: `test/tx/measure-attachments.ts` and
`test/retention/measure-events.ts`. Neither is a CI threshold.

## `POST /api/tx` with attachments

Forty concurrent multipart sends, each with one 4 MiB attachment and a declared `Content-Length`,
inside the test process (`txFixture`, real clock, loopback sink). Every dispatch is held 300 ms
first, as a slow SMTP server holds a request. "Before" removes the budget (the code path is
otherwise the shipped one); "after" is the shipped 64 MiB / 2 s wait. RSS growth is the process's
peak RSS above its level just before the burst, sampled every 2 ms. The 40 request bodies are
built before the baseline and are still resident in this harness (a real client's are not), and
the harness shares the process with the server, so growth is an upper bound for the server alone.

| Requests | Budget | Served | Refused (429) | Peak RSS growth | Latency of served p50 / p95 | Refusal latency p50 / p95 |
|---:|---|---:|---:|---:|---:|---:|
| 40 | none (before) | 40 | 0 | 1,244 MiB | 15.7 s / 16.6 s | n/a |
| 40 | 64 MiB (after) | 14 | 26 | 488 MiB | 5.4 s / 5.8 s | 36 ms / 4.6 s |
| 6 | none (before) | 6 | 0 | 233 MiB | 2.2 s / 2.2 s | n/a |
| 6 | 64 MiB (after) | 6 | 0 | 295 MiB | 2.6 s / 2.6 s | n/a |

At 40 requests the budget cuts the memory growth by 61% and the served latency by two thirds,
because the requests that do run no longer compete for the single thread with 26 others. A
refused request normally answers at once (the median is 36 ms: a full queue refuses immediately)
or after its 2-second wait; the p95 of 4.6 s is the wait plus the time the busy thread needed to
run its timer and write the answer. At 6 requests the limit is not reached and the budget costs
nothing measurable: the two rows differ by less than the spread of repeated runs (earlier runs of
the same pair, not kept in the raw file, measured 233 to 267 MiB without a budget and 247 to
295 MiB with one, and 2.2 to 2.9 s).

The budget is a bound on what is *counted* (64 MiB), not on peak RSS, which also holds the
journal's encoded payload, the SMTP library's own encoding and garbage not yet collected: the
measured growth is about eight times the counted bytes. Lowering `PARSE_COPIES` or the budget
trades more refusals for less memory.

Per-request cost: the journal stores the base64 payload and decodes one copy per synchronous
recipient, so the budget is charged `attachment bytes x recipients` for the hold. An `async`
request, or one with no attachment, gives its charge back before it is journaled.

## Event purge and send lateness

A backlog of 400,000 events received 500 days ago, a send journaled, claimed and finished every
20 ms in the same process (as the server does), 30 seconds. Lateness is how long after its due
time each send started; "send" is due time to finished. Before: the standalone loop at 500 rows
a pass and no pause. After: the shared loop (`startPurge`) at 100 rows a pass and a 250 ms pause.
The quiet set below was run after a checkpoint and a 5-second settle; an earlier set ran while the
host was busy (idle p95 lateness 470 ms, after 518 ms, before 6.0 s), with the same ordering.

| Scenario | Events purged | Rows/s | Lateness p50 / p95 / max | Send p50 / p95 / max |
|---|---:|---:|---:|---:|
| Idle process | 0 | n/a | -0.3 / 5.6 / 48 ms | 14.6 / 25.6 / 68 ms |
| Standalone loop (before) | 400,000 | 13,331 | 5,102 / 6,728 / 6,951 ms | 5,122 / 6,741 / 6,971 ms |
| Shared paced loop (after) | 11,500 | 383 | -0.2 / 11.4 / 77 ms | 14.9 / 29.8 / 97 ms |

Back-to-back passes starve the writer for seconds, as D70 measured for the three older owners; one
paced loop leaves the send path within 6 ms (p95) of an idle process. The cost is the drain rate
(383 against 13,331 rows a second): the 400,000-event backlog needs about 17 minutes where it took
30 seconds. The steady state, 100 events a second at the throughput target (M5.1), is a quarter of
the paced rate.

## Not measured

The compiled executable under real HTTP clients (the figures above use the in-process fixture), a
real SMTP server's latency, and PDF viewers (needs real devices; still in the backlog).
