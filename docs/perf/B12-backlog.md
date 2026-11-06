# B12: tx admission fairness

Change: `ByteGate.admit` (`src/tx/gate.ts`), used by `POST /api/tx` for a send that holds nothing yet.
Setup (`test/tx/tx.test.ts`, "a steady stream of small embedded-image sends…"): budget 6 MiB, one 1 MiB
upload held by a stalled SMTP dispatch, a second upload waiting for room (needs about 5 MiB, does not
fit), then 12 small JSON sends with one embedded PNG each, all arriving while the upload waits. The
count is the rows journaled before anything is released (the first upload counts as 1).

| Build | Sends journaled while the second upload waits | Small sends that passed the waiter |
| --- | --- | --- |
| Before (unbounded overtaking, `tryAcquire`) | 13 | 12 of 12 |
| After (`maxOvertakes` 8) | 9 | 8; the other 4 queue behind the upload |

With a continuing stream the "before" number has no bound: every arrival that fits passes, and the
upload waits until its 429 (2 s). After the change, what can pass is the holders it already had plus 8.
Small sends that do not overtake wait inside the same 2 s bound and get the same 429 if room does not
come; a send that does not fit now is still refused at once. Memory is unchanged: the same 64 MiB
budget and 64 holders. Measured on this host, with a stalled dispatch and the injected clock, so no
timings are involved. The fairness is also covered by `test/tx/gate.test.ts` (two cases).
