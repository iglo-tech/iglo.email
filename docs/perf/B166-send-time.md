# B166: campaign batch lookup before and after (D194)

B166 changes the campaign runner's send-time lookup (`fresh()` in
`src/campaigns/runner/runner.ts`): an unchanged plan now copies the row the reads verified into the
batch instead of keeping the claimed copy. It is an in-memory assignment per source-linked
recipient, with no extra read or write. The other B166 changes on this path are an address-only
suppression lookup when a lookup writes a new address (1 % of this workload's recipients are
renamed, none change address, so it does not run here) and, for a user absent from the view, one
indexed subscriber read by ID (none here).

## Method

`bun test/sources/send-time-measure.ts <data-dir> 10000 source` (the B150e measurement,
[B150e-send](B150e-send.md)): one campaign to 10,000 source-linked recipients through the runner,
each read from the real PocketBase 0.40.5 binary per batch, 1 % renamed in the source first. The
database directory is on disk (`$HOME/b166-acceptance/`). "Before" is an export of `origin/main`
at 6cb754b, "after" is the B166 branch, run alternately on the same host
(`agents-workhorse-01`, Linux x86-64, 12 cores), 2026-11-27.

## Results

| Run | Seconds | Recipients/s | Batch lookup p50 / p95 / max (ms) | Read p50 / p95 (ms) | RSS (MiB) |
|---|---|---|---|---|---|
| before 1 | 5.5 | 1,812 | 15.9 / 20.9 / 71.3 | 0.7 / 1.5 | 207.0 |
| after 1 | — | — | 15.7 / 20.7 / 71.1 | 0.7 / 1.5 | 207.5 |
| after 2 | 5.5 | 1,811 | 15.9 / 20.7 / 72.8 | 0.7 / 1.5 | 193.7 |
| before 2 | 5.6 | 1,800 | 15.9 / 20.6 / 75.2 | 0.7 / 1.5 | 197.5 |
| after 3 | 5.2 | 1,906 | 15.2 / 18.0 / 74.6 | 0.7 / 1.4 | 228.5 |
| before 3 | 5.3 | 1,905 | 15.2 / 18.0 / 68.7 | 0.7 / 1.4 | 206.9 |

(The first "after" run's total time was not captured; its lookup figures were.) Every run sent
10,000 with no errors.

## Reading

The batch lookup time (100 batches of 100) and the throughput are the same before and after,
within the run-to-run spread (about 5 % here, between the second and third pair). The unchanged
path adds no measurable cost.
