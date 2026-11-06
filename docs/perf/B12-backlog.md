# B12: tx admission fairness

Change: `ByteGate.admit` (`src/tx/gate.ts`), used by `POST /api/tx` for a send that has read its body
and holds nothing the gate counts yet (JSON body with embedded images). It never waits: it takes its
bytes now or is refused. Only multipart uploads queue, before their body is read, so D74's rule that
a waiter holds nothing is unchanged.

Rule: a send that fits may go ahead of the waiting upload at the head of the queue, at most 8 times
per waiter (`maxOvertakes`). After that it is refused with the same 429 and `Retry-After: 1` an
over-budget send gets, before anything is journaled, so its retry is not a second send. The room the
holders free then goes to the waiter.

## Journal count (`test/tx/tx.test.ts`, "a steady stream of small embedded-image sends…")

Budget 6 MiB, one 1 MiB upload held by a stalled SMTP dispatch, a second upload waiting for room, then
12 small JSON sends with one embedded PNG each, all arriving while the upload waits.

| Build | Rows journaled while the second upload waits | Small sends that passed the waiter | Refused at once |
| --- | --- | --- | --- |
| Before (unbounded overtaking, `tryAcquire`) | 13 | 12 of 12 | 0 |
| After (`maxOvertakes` 8) | 9 | 8 | 4 (429) |

## Memory (`bun test/tx/measure-fairness.ts 200 before|after`, 3 runs each)

Budget 20 MiB, a 3.5 MiB upload held, a second 3.5 MiB upload waiting (it needs 17.5 MiB, so it does
not fit), then 200 JSON sends, each to 4 recipients with a 256 KiB embedded image (1 MiB held each),
arriving while it waits. "Before" is `maxOvertakes` unbounded, which is the pre-B12 behavior. Peak RSS
is the process's `VmHWM` (the harness's server, SMTP sink and clients share the process; it started at
136–139 MiB).

| Build | 200 OK / 429 | Peak RSS while the upload waited | Peak RSS at the end |
| --- | --- | --- | --- |
| Before | 16 / 184 (plus the 2 uploads) | 225, 236, 226 MiB | 386, 396, 386 MiB |
| After | 8 / 192 (plus the 2 uploads) | 225, 229, 231 MiB | 344, 333, 334 MiB |

The peak is set by the burst of 200 parsed and rendered requests, which the 429s release as soon as
they are refused; it is not a function of the budget. After the change it is no higher (about 50 MiB
lower at the end of this run, because fewer sends are held and then dispatched). No request waits
while holding its parsed body, so there is no new memory term: the worst case stays the budget plus
the requests in flight, as in D74. The earlier draft of this change queued such sends and was
rejected in review for exactly that reason.
