# B17: campaign runner state guards

Guard-only change to `src/campaigns/runner`: the runner's cursor, sent-count, delivery and
pause writes now name the lease (and, for the pause, the generation) in `WHERE`. The extra
predicates are on the primary key row the statement already updates (`campaigns.id`), or a
single primary-key `EXISTS` for the two delivery statements, so the per-batch cost is
unchanged: one `campaigns` row lookup per write, as before.

The one throughput effect is a gain: a due scheduled campaign (or a resume with `send_at`
set) now sends its first batch on the first scan instead of the scan about 5 s later,
because the pipe opens at the post-flip `runner_generation`. Measured on the injected
clock in `test/campaigns/runner/runner.test.ts` ("a due scheduled campaign sends its first
batch ..."): first push on the first due scan (under 5000 ms after `send_at`), against 5000 ms or more
(one scan interval later) on the unchanged code. Steady-state batch throughput is not affected.
