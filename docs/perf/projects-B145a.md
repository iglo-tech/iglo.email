# B145a: what one capacity forecast costs

B145a adds a read path: `GET /api/sending/capacity` counts the app's own starts over the last 24
hours in every project ([14-projects.md](../design/14-projects.md) section 7; D159). It changes no
sending, scheduling or storage path: the rate limiter, emailer, outbox and campaign runner are as
they were, no table or index is added, and nothing is written. So the throughput runs of B139 are
not repeated; this measures the new read instead. These are local observations on one host, not
CI thresholds.

## Setup

- Host: `agents-workhorse-01`, Ubuntu 26.04, Linux 7.0.0-44 x86-64, 12 threads, 30 GB RAM, native
  (D147). Bun 1.4.5. Other workers were running: load average 5 to 6 throughout.
- Harness: `bun test/perf/projects/capacity.ts [sends] [deliveries]`. One instance in process on a
  real clock, the primary project only, a stand-in for SES `GetAccount`. It writes `sends` rows
  (half marketing, half transactional, all `sent`) and one running campaign's deliveries, each
  spread evenly over the last 48 hours, so half fall in the 24 hours the forecast reads. Then 21
  `GET /api/sending/capacity?count=10000` with an API user; the median and the worst are printed.
  A temporary data directory under the system temp directory.

## Results

Times are per request, through HTTP, the first request's on-demand SES read included in the worst.

| sends | deliveries | median ms (3 runs) | worst ms (3 runs) |
|---:|---:|---|---|
| 1,000,000 | 1,000,000 | 267.8, 276.6, 249.3 | 344.8, 327.5, 304.0 |
| 1,000,000 | 1 | 168.8 | 223.8 |
| 1 | 1,000,000 | 122.6 | 158.6 |
| 100,000 | 100,000 | 27.6 | 46.0 |

An earlier draft read each table twice (once for the 24 hours, once for the window); it took 540,
398 and 385 ms (medians) for a million of each. One scan per table, both counts from it, is the
code under review.

## Reading

- The cost is linear in the rows: `sends` has no index on a send's start time
  (`coalesce(attempted_at, sent_at)`), so the count scans the table, and the deliveries of a running
  campaign are scanned by their campaign key. Finished campaigns untouched in the window are skipped.
- A forecast runs when the campaign page opens or its send time changes, and on an API or MCP call;
  nothing polls it. At a million of each a request holds the process for about a quarter second.
- If that matters at some size, an index on the start time is a storage change with its own
  measurements (D159, "Cost").
