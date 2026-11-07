# B26: the tx attachment budget counts measured memory (D87)

Raw runs: [B26-results.jsonl](B26-results.jsonl) (`variant` before/after). Harness: `bun test/tx/measure-memory.ts <attachmentMiB> <recipients> sync|async [requests] [gated|serial]`, one scenario per process, a loopback SMTP sink that keeps no message text, a small warm-up send first, a held 100 ms dispatch, and the kernel's peak resident size (`VmHWM`, reset through `/proc/self/clear_refs`) instead of a timer, which cannot sample while the thread is busy. "Growth" is that peak minus the RSS after a full collection before the requests. In-process, so request bodies are built before the baseline; the real socket read is not included.

## Setup

- Before: `origin/main` a104dc7 (archived into `node_modules/.cache/b26/control`; `routes.ts` sha256 `23f4f163…`, `payload.ts` `e2fd2271…`) with the harness files copied in. After: this branch (`routes.ts` `fed0e7aa…`, `payload.ts` `f5acd08d…`). Bun 1.4.4 on Linux x86-64, in-process (no compiled executable; the budget and payload code are the same in it).
- Host: dynamic memory (min 2 GiB, max 16 GiB), shared with other projects' suites. 1-minute load average 4.2 to 6.6 during the runs (recorded per run in the raw file). Runs held `flock ~/.local/state/iglo-email-cos/measurement.lock`, one after another. Two rounds each; the spread between rounds is large for the heavy rows because the collector's timing varies. Not a CI threshold.

## Where the bytes go (4 MiB attachment, one recipient, before)

| Stage | Peak growth |
|---|---:|
| multipart parse (read chunks, joined body, form, file copy) | about 17 MiB (4.3 x) |
| journal write: base64, JSON text, SQLite's copy of the 5.6 MB row | about 40 MiB |
| claim and decode the row for SMTP | about 100 MiB |

The last stage was one regular expression in `decodePayload`: `^(?:[A-Za-z0-9+/]{4})*(...)?$` over a 5.6 MB string keeps a backtrack frame per four-character group (146.9 MiB measured in isolation with `test/tx/payload.test.ts`; 10 MiB after). `decodePayload` also re-encoded the message it had just decoded only to validate it (two more copies of every attachment), and `encodePayload` copied each attachment before encoding it. Those three are fixed; the parse copies, the per-recipient payload text and the concurrent push of all synchronous recipients are not, and are why the charge below is what it is. A JSON request cannot carry caller attachments, so only multipart was measured.

## Before and after

Single send on an idle server (`gated` = the shipped budget):

| Attachment x recipients | Before, growth | After, growth |
|---|---:|---:|
| 4 MiB x 1 | 162, 162 MiB | 63, 68 MiB |
| 3 MiB x 4 | 208, 200 MiB | 113, 122 MiB |
| 1 MiB x 15 | 168, 153 MiB | 130, 156 MiB |

Many requests at once (old budget 64 MiB, new 128 MiB; the new charge admits two 4 MiB uploads at a time where the old admitted three):

| Scenario | Before: ok / 429, growth | After: ok / 429, growth |
|---|---|---|
| 16 x 4 MiB, one at a time | 16 / 0, 297 and 341 MiB | 16 / 0, 252 and 275 MiB |
| 40 x 4 MiB at once | 14 / 26, 571 and 585 MiB | 17 to 18 / 22 to 23, 290 and 389 MiB |
| 40 x (1 MiB x 4 recipients) at once | 17 / 23, 402 and 397 MiB | 3 / 37, 125 and 160 MiB |
| 12 x (1 MiB x 15 recipients) at once | 0 / 12, 44 MiB | 1 / 11, 137 and 152 MiB |

## Reading

- Copies removed: 4 MiB single send 162 to 63 to 68 MiB; one-at-a-time stream 297 to 341 down to 252 to 275 MiB; the worst overlap 585 down to 290 to 389 MiB.
- The target of about 256 MiB is met for single sends, one-at-a-time streams of 4 MiB sends (borderline) and many-recipient bursts, and missed when two 4 MiB sends overlap (up to 389 MiB). The rest is native memory the collector does not return for seconds: sixteen sends in a row reach 250 to 275 MiB with only one in flight, and `Bun.gc(false)` after each send changed nothing (not kept). A 2 GiB host stays inside it; a 1 GiB host would not.
- Refusals: the many-recipient bursts are refused far more (3 of 40 served against 17) because each is now charged for its per-recipient copies; they are refused at once or after the 2 s wait, never after journaling, and `async` is charged less. The old count let 40 four-recipient sends grow to 400 MiB.
- The largest legal send (a 16 MiB request: 4 MiB x 3, 3 MiB x 5, 1 MiB x 15) is admitted by an idle server; `test/tx/tx.test.ts` checks it.
