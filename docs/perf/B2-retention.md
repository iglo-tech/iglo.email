# B2 bounded retention

`bun run retention:measure`: one serial run, not a CI threshold. Raw lines are in [B2-results.jsonl](B2-results.jsonl).

The database is generated offline with the production schema: 1,000,000 expired sessions, 1,000,000 finished webhook deliveries of about 600 bytes and 100,000 sent messages built by `encodePayload`, all 60 to 99 days old, 3.7 GiB. Host: shared VM, load average 3 to 5, Bun 1.4.4, SQLite 3.53.4, `synchronous = FULL`.

A concurrent send is one message every 20 ms, 50 a second, the target rate, on the same thread as the loop, as in the server: journal it, claim it, record the outcome, three separate commits. Production claims and settles in batches, so this is the harder case. **Lateness** is how long after its due time a send started. **Send** is due time to last commit. Each purge phase runs for 60 s against its backlog through the real loop, so passes run on the large table, not on a drained one.

## Message size, the input to D70

| Row | Bytes |
| --- | ---: |
| Prepared payload, a 25 KiB HTML newsletter, base64 and JSON | 26,855 |
| Tracked link paths kept for the same row, three links | 245 |

Compaction removes 99% of these bytes, and an attachment can take a row to 8 MiB. In the run, compacting 10,700 rows left 232.7 MiB free in the file for later rows, about 22 KiB each after the writer's own use.

## Before and after

Idle, no purge, 1,000 sends. Before has the migration's column but not its three partial indexes.

| Phase | Send p50 ms | Send p95 | Send p99 | Worst | Lateness p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Idle with the new indexes | 4.9 | 13.1 | 17.5 | 23.2 | 3.4 |
| Idle before | 4.5 | 8.3 | 12.9 | 22.5 | 1.1 |
| Idle with the new indexes, again | 5.1 | 7.8 | 13.3 | 77.2 | 1.3 |

The two rows with indexes bracket the one without, and the differences between them are as large as the difference from it. A send adds one short index entry when it finishes, and no cost shows above this host's noise.

During a purge, 60 s, 3,000 sends due:

| Phase | Sends done | Rows taken | Rows/s | Pass p50 ms | Pass worst | Send p50 | Send p99 | Worst | Lateness p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Sessions | 2,999 | 21,400 | 357 | 20.3 | 69.1 | 13.5 | 64.8 | 82.2 | 48.6 |
| Deliveries | 3,000 | 22,400 | 373 | 11.5 | 46.4 | 6.3 | 54.9 | 87.4 | 36.6 |
| Send bodies | 3,000 | 10,700 | 178 | 21.3 | 46.2 | 15.6 | 56.9 | 112.4 | 39.4 |
| First start, all three in turn | 3,000 | 17,950 | 299 | 21.1 | 49.7 | 16.2 | 59.2 | 71.4 | 41.2 |

So no send fell behind, and the worst a send waited for was about one pass. The cost of a purge to a send is a wait of tens of milliseconds some of the time.

The loop's rate is deliberately low: about 3.6 passes a second. Sharing the loop, 1,000,000 sessions or deliveries take about 2.3 hours, and 100,000 bodies about 28 minutes, or 9 alone. A backlog of this size exists once, at the first start. Sustained at the 50 messages/s target, body compaction keeps up even when all three share the loop (59 rows/s here).

## What the runs changed

Each row is the same backlog and writer, with one design changed.

| Design | Sends done in the phase | Send lateness p99 |
| --- | ---: | ---: |
| Three loops, 500 rows a pass, next pass at once, as event retention does | one per pass, about 9 a second against 50 due | 103 s and growing |
| Three loops, 100 rows, 100 ms pause, each loop alone | 2,949 to 3,000 of 3,000 | 87 ms to 981 ms |
| Three loops, 100 rows, 100 ms pause, all at once | 1,913 of 3,000 | 21.5 s and growing |
| One loop, owners in turn, 100 rows, 250 ms pause | 3,000 of 3,000 | 41 ms |

On a small database a 500-row pass took 11 ms; on this one, 110 ms, because each deleted row touches pages scattered through three indexes and every page reaches the WAL before FULL's sync. A pass that looked short at small scale took the whole thread in a loop that had no pause, and a timer gets one turn between passes. Pausing each loop on its own was not enough either: three loops add up, so the pause has to be shared, and the shared loop bounds the total whatever the number of tables with a backlog.

## Migration

Migration 14 took 5.7 s on this database, inside its one transaction at startup. `sends.created_at` is stored after `payload`, so building that index reads through every payload once. The time covers the migration's statements only, not the snapshot the runner takes before them.

## Limits

- Lateness is measured in one process. Helpers, HTTP and the SMTP pool were not running; [M6.1](M6.1-performance.md) covers them.
- Reads of `sends` and `webhook_deliveries` are unchanged, so they were not measured.
- This was one run on a shared host, and the worst column includes the host, as [M4.6](M4.6-maintenance.md) describes.
- Compaction moves pages to SQLite's free list. Later rows reuse them, and the file does not shrink without a `VACUUM`. Space freed stays in the WAL and in backups until those turn over.
