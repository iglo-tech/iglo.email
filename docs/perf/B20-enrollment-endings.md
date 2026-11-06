# B20: enrollment endings

Guard-only change, argued instead of measured. The scheduler's claim and decision paths are unchanged. The edits drop one `s.status = 'active'` comparison from the `exit-by-event` subquery, add two `NULL` assignments to five `UPDATE`s of rows that are already being rewritten, and change the status string the scheduler writes when it ends an enrollment. No new query, index, loop or lock; the scheduler measurement harness (`test/scheduler/measure.ts`) exercises claim and advance, which these edits do not touch.
