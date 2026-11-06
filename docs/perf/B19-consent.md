# B19: consent invariants (guard-only)

No sending, scheduling or storage path changed shape. The statements touched are per-subscriber
`UPDATE`s that gained a from-state in `WHERE` (`status != 'blocklisted'`, `status != 'unsubscribed'`)
and one `COUNT(*)` of a list's unconfirmed members, run once per list update that changes `optin`
(it uses the `subscriber_lists` status index, as `maintenance-unconfirmed` does). The set-based
add-by-query is still one statement per batch; it gained a join to `subscribers` by primary key.
`bun run check` and the subscriber, list, bounce and unsubscribe test files pass; the
existing query-action timings in `docs/perf/` are not affected by a guard that rows already satisfy.
