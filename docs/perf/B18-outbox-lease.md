# B18 outbox lease measurements

Bounded observation on 2026-11-06 (Linux x86-64, Bun 1.4.4, host not reserved). `bun test/sends/measure-lease.ts`
enqueues 2000 transactional rows into a fresh database (production migrations, WAL, synchronous=FULL), starts the real
outbox loop with an instant in-process emailer and real clock, and times until all rows are `sent`. Only the journal and
the loop's claim and finish commits are measured; no SMTP. Three serial runs each. "Before" is main at 4be9929 (same
script, `src/messaging` restored), "after" adds the per-pass lease expiry (one indexed-less `UPDATE ... WHERE
status='sending' AND claimed_until <= ?`, matching zero rows in the normal case).

| Code            | Run 1 | Run 2 | Run 3 |
| --------------- | ----: | ----: | ----: |
| Before (rows/s) |  2504 |  2397 |  2847 |
| After (rows/s)  |  2499 |  2353 |  3003 |

The runs overlap; no throughput change is measurable. Not a CI threshold.
