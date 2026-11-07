# B23 sending lease follow-ups: measurements

Bounded observation on 2026-11-07 (Linux x86-64, Bun 1.4.4, host load about 2.5, not reserved). The same
`bun test/sends/measure-lease.ts` as [B18](B18-outbox-lease.md): 2000 transactional rows, the real outbox loop, an
instant in-process emailer, real clock, three serial runs each. "Before" is main at 7e0d90f (`src/` restored), "after"
adds the in-flight set (a `Set` insert and delete per row) and the `id NOT IN (SELECT value FROM json_each(?))` term of
the per-pass lease expiry, which with no live rows is an empty `json_each('[]')` on a query that already matches zero
rows.

| Code            | Run 1 | Run 2 | Run 3 |
| --------------- | ----: | ----: | ----: |
| Before (rows/s) |  3162 |  3366 |  2897 |
| After (rows/s)  |  2831 |  3356 |  3164 |

The runs overlap; no throughput change is measurable. Not a CI threshold.
