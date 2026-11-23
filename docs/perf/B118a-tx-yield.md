# B118a: a transactional send to several recipients yields between them

Decision: [D140](../design/09-decisions.md#d140-runtime-edges-the-send-rate-restart-the-tx-yield-a-silent-smtp-server-and-a-recorded-marketing-step-b118a-lead-2026-11-23) item 2.

## The block

A send to several recipients renders each recipient in turn (`src/tx/routes.ts`). The render and the
generated text part run on the event loop, so before the change one request held the loop for the sum
of its recipients' renders. The brief measured 1.49 s for four recipients of the worst allowed template
blocking `/health`.

## The shape measured

The worst shape the data cap allows (`test/tx/measure-yield.ts`):

- the template opens 1023 elements and holds 8000 stray end tags (the largest count the create
  endpoint accepts with 1023 open elements; 10000 is refused by the renderer's work budget);
- its data holds four values of 9000 stray end tags each (about 63 KiB, under the 64 KiB value cap),
  so one render is about 250 KiB of stray tags, under the 256 KiB data cap.

The measure is the longest gap between two turns of an otherwise idle loop, taken during one send
(a `setImmediate` spinner). It is compared between a one-recipient send and a four-recipient send in
the same run, as B120's linear-time test does. Each figure is the median of three sends.

## Results

All figures are milliseconds, on macOS arm64 with other agents' work on the host. The absolute
figures moved between runs (the one-recipient baseline read 97 ms in one run and 141 ms in another
without any change to the code), so the ratio is the measure.

| run | yield | 1 recipient (per send) | median | 4 recipients (per send) | median | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| A | none | 97, 87, 109 | 97 | 341, 341, 432 | 341 | 3.5 |
| B | none (under load) | 143, 125, 141 | 141 | 833, 380, 599 | 599 | 4.2 |
| C | render yield, host | 50, 35, 33 | 35 | 55, 39, 45 | 45 | 1.3 |
| D | render yield, container, 8 CPUs, no other load | 81, 255, 93 | 93 | 206, 172, 170 | 172 | 1.85 |
| E | render yield and outbox push yield, container, 8 CPUs, no other load, five runs | 611, 47, 65, 105, 115 | 105 | 134, 139, 128, 93, 71 | 128 | 1.2 |

Run D is three runs each way; run E is five (the 611 ms first run is the warm-up). Run E is the
committed code: `deliver` in `src/messaging/outbox.ts` gives one turn after each message's push.

Where the rest of the four-recipient cost goes: the same worst shape sent `async: true` (so the
request does not push synchronously) took a median of 62 ms for one recipient and 87 ms for four (1.4),
in the container, five runs each. The rest of the block after the render yield was therefore the
synchronous push, now yielded, and a smaller encode of the payloads in the send's transaction. The
scratch variant is not committed; `test/tx/measure-yield.ts` is the measure.

Before the yield, four recipients held the loop 3.5 to 4.2 times as long as one (host). The render yield
alone brought the four-recipient block to 1.3 to 1.9 times one recipient's on the host and the container
(2.6 once under four-worker load). The rest was the synchronous push: the outbox pushed a batch's
messages in one tick, and each message's MIME build (nodemailer) ran back to back. The outbox turn
(run E) brings the container to 1.2. What remains is the journal's encode of every recipient's payload
in one write transaction (`enqueueRequest`), which a turn between renders cannot reach. The async variant puts it
at about 25 ms for four recipients (87 against 62 ms for one). Moving it out of the transaction would be a larger change than
this item. The brief's 1.49 s was not reproduced on this host: the heaviest shape the send path accepts
held the loop for 341 to 599 ms with four recipients before the yield.

## Test

`test/tx/recipient-yield.test.ts` is an order test, not a timing test. A synchronous loop cannot let a
queued immediate run, so a turn of an otherwise idle loop between the first and the last render (and
between the first and the last push) of a four-recipient send is the yield itself. Removing the render
yield fails it, and removing the push yield fails it: both shown by mutation on the host.

A timing ratio was tried first and dropped. Its assertion (the four-recipient median under 2.5 times
the one-recipient median) passed on the host and in the container with no load (1.2 to 1.9), but under
four-worker load the same measure gave 2.65 with the render yield alone and 3.6 with both, which overlaps
the 3.5 to 4.2 measured before the yield. A wall-clock ratio cannot separate the two under the load CI
runs under, so it is not a gate. The measure in `test/tx/measure-yield.ts` stays as the evidence.

## Alternatives not measured

- A smaller held cap: the held cap bounds memory, not the render's time, so it does not change this
  measure. It would also refuse large sends with 429.
- Yielding inside the text-part converter: the converter is one synchronous pass, and splitting it
  changes its output near the split. Not done; the yield bounds the block to one recipient.
