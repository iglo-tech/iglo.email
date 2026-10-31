# Sequences

A sequence is a list of steps that starts when a subscriber does something (an event) and sends emails after waits, if conditions still hold at send time.

## Concepts

| Term | Meaning |
|---|---|
| **Event** | Something a subscriber did, sent by an app: `order_paid`, `subscription_canceled`, `download_finished` |
| **Sequence** | A trigger, an ordered list of steps, and exit rules |
| **Step** | Wait for a duration, check a condition, send a template |
| **Enrollment** | One subscriber's progress through one sequence: which step is next and when it is due |
| **Send** | One message, recorded in `sends` ([Sending](04-sending.md)) |

## Events API

`POST /api/subscriber-events`

```json
{
  "subscriber": {
    "external_id": "u_123",
    "email": "ana@example.com",
    "name": "Ana",
    "attribs": { "plan": "subscription", "first_name": "Ana" }
  },
  "name": "subscription_created",
  "data": { "price": 79, "currency": "USD" },
  "occurred_at": "2026-10-27T12:00:00Z",
  "idempotency_key": "polar:evt_8f2…"
}
```

- The subscriber is found by `external_id`, then by `email`. If not found and `email` is given, it is created (status `enabled`, no list memberships).
- `attribs` are **merged** into the subscriber's attributes (top-level keys replaced, `null` removes a key). This is how apps keep conditions like "plan is subscription" current without a second call.
- `email` on an existing subscriber found by `external_id` updates the address.
- A repeated `idempotency_key` for the same subscriber returns the first result and changes nothing.
- `occurred_at` defaults to the receive time. Events older than 7 days are stored but do not start sequences (prevents a backfill from sending old onboarding mail).
- `POST /api/subscriber-events/batch` accepts up to 500 events.
- Response: the event ID, the subscriber ID, and the enrollments it started (`{id, sequence_id}`) or ended (`{id, sequence_id, exit_reason}`). A repeated key replays the first request's lists.

Processing, in one transaction:

1. Upsert the subscriber, insert the event.
2. For each `active` sequence with `exit_on` containing this event name, end the subscriber's active enrollment (`exited`, `exit_reason = 'event:<name>'`).
3. For each `active` sequence whose trigger matches, create an enrollment if `reentry` allows it, with `step_id` = first step and `due_at = occurred_at + wait`.

Steps 2 and 3 run in that order, so an event that both exits and triggers the same sequence restarts it.

## Sequence definition

```json
{
  "name": "Prepaid onboarding",
  "status": "active",
  "trigger": { "event": "order_paid", "where": { "data.product": "prepaid" } },
  "exit_on": ["subscription_created"],
  "reentry": "never",
  "list_id": 3,
  "steps": [
    {
      "wait": "PT0S", "kind": "transactional", "template_id": 10
    },
    {
      "wait": "P3D", "kind": "marketing", "template_id": 11,
      "condition": { "not": { "event": "download_finished", "since": "trigger" } },
      "on_false": "exit"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `trigger.event` | Event name that starts the sequence |
| `trigger.where` | Optional predicate on the triggering event and the subscriber: either an object of `data.*` equalities on the triggering event (`{"data.product": "prepaid"}`), or a condition (same language as conditions) evaluated for the subscriber after the event's upsert, inside the event transaction. `sql` is refused here: the read-only child cannot see the uncommitted event |
| `exit_on` | Event names that end an active enrollment |
| `reentry` | `never`: once per subscriber ever. `after_exit`: again after the previous enrollment finished. `always`: every matching event starts a new enrollment, and a running one is replaced |
| `list_id` | Marketing permission list for the marketing steps. Required if any step is `marketing` |
| `steps[].wait` | ISO 8601 duration after the previous step ran (or after the trigger for the first step) |
| `steps[].kind` | `marketing` or `transactional`. Decides permission checks, the cap and unsubscribe links |
| `steps[].condition` | Checked when the step is due. Missing means always true |
| `steps[].on_false` | `skip` (move to the next step) or `exit` (end the enrollment). Default `exit` |
| `steps[].cap_policy` | `defer` (default) or `skip`, when the frequency cap blocks a marketing step |
| `steps[].max_late` | If the step runs later than `due_at + max_late` (server down, sequence paused), skip it instead of sending something stale. Default: no limit for transactional, `P2D` for marketing |

Sequences are managed in the admin UI and through `GET/POST/PUT/DELETE /api/sequences` and `PUT /api/sequences/:id/status`. Steps keep their IDs across edits (send the step `id`); omitted steps become `deleted`. A step's template must be a transactional template (steps have no body of their own yet). Archiving exits active enrollments (`sequence_archived`); a sequence with enrollments cannot be deleted. Blocklisted subscribers are never enrolled. `POST /api/enrollments` enrolls manually (`force: true` ignores reentry; a forced or `always` enroll replaces a running enrollment as `canceled`/`manual`); `DELETE /api/enrollments/:id` cancels (`canceled`, `manual`). Definitions are versioned only by `updated_at`; the admin UI shows a warning with the number of active enrollments before saving changes.

## Conditions

A small JSON predicate language. It covers what lifecycle emails need without letting a definition run arbitrary code.

```json
{ "all": [ … ] }
{ "any": [ … ] }
{ "not": { … } }

{ "event": "download_finished", "since": "trigger", "where": { "data.source": "mcp" }, "count": { "gte": 1 } }
{ "attr": "plan", "op": "eq", "value": "subscription" }
{ "list": 3, "status": ["confirmed", "unconfirmed"] }
{ "sql": "json_extract(subscribers.attribs, '$.credits_left') < 100" }
```

| Predicate | True when |
|---|---|
| `event` | The subscriber has events with this name. `since`: `trigger` (after the enrollment's trigger event), `enrollment` (after the enrollment started), `last_step` (after the previous step ran), or an ISO 8601 duration back from now (`P30D`). `where`: equality on event `data.*` fields. `count`: `gte`, `lte`, `eq`; default `gte: 1` |
| `attr` | A subscriber attribute compares with a value. `op`: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `exists`. `attr: "status"` reads the subscriber status |
| `list` | Membership in a list with one of the given statuses |
| `sql` | A segment-query fragment over `subscribers`, run in M1.7's read-only child runner. Requires the `subscribers:sql_query` permission to save. Escape hatch, not the default |

Conditions compile to one SQL query per evaluation, bound to the subscriber, using the `(subscriber_id, name, occurred_at)` index on events. "No download after 3 days" is `{ "not": { "event": "download_finished", "since": "trigger" } }`.

Rules (implemented in `src/conditions`):

- **Types.** Paths walk object keys only (`a.1` is key `"1"`, not an array index); a missing key or a non-object on the way makes the field missing. A string equals only the same JSON text, a number only a JSON number of the same value (`5` equals `5.0`), a boolean only the same boolean; nothing is coerced. `gt`/`gte`/`lt`/`lte` compare numbers numerically and text by code point, and are false for a missing field or another type. `ne` is the negation of `eq`, so it holds for a missing field. `in` is `eq` against any value. `exists` means present and not JSON null.
- **Safe numbers.** A number in a condition (`value`, `in` items, `where` values) must be a safe integer (within ±(2^53 − 1)) or a finite fraction; validation refuses others with a field error, because JSON parsing has already rounded them. Stored numbers of any size compare exactly against accepted ones.
- **Defaults.** A `list` without `status` means `["unconfirmed", "confirmed"]`: a member who has not unsubscribed. An `event` without `count` means `{ "gte": 1 }`; `count` comparators combine as a conjunction of integers 0–1000.
- **`since`.** Events count strictly after the bound, so `since: trigger` never counts the trigger event itself, nor another event at the same instant. `last_step` before the first step falls back to the trigger. Without `since` there is no lower bound; there is never an upper bound.
- **Durations.** ISO 8601 weeks, days, hours, minutes and seconds only (`P30D`, `PT12H`, `P1DT6H`); no years, months or fractions; at most 36,600 days, measured back from the injected clock's now.
- **`sql`.** A condition containing `sql` runs whole, as one statement in one read snapshot, in the read-only child; each fragment must pass M1.7's checks on its own and binds no parameters. Conditions without `sql` run on the normal read path with no child.

## Template data

A step's template receives:

- `subscriber`: `name`, `email`, `uuid`, `external_id`, `attribs`;
- `trigger`: the triggering event's `name`, `data` and `occurred_at`;
- `sequence` and `step`: names and IDs;
- the usual functions: `unsubscribe_url` and `manage_url` (marketing steps; empty for transactional steps), `track_link`, `track_view` ([Templates](06-templates.md)).

Anything else, such as monthly totals, is computed by the app and sent as event data. The sequence engine does not aggregate.

## Scheduler

Every 15 seconds, and immediately after an event creates an enrollment due now:

1. In a `BEGIN IMMEDIATE` transaction, claim up to 100 enrollments with `status = 'active' AND due_at <= now AND (claimed_until IS NULL OR claimed_until < now)`, setting `claimed_until = now + 5 min`.
2. For each claimed enrollment, outside the transaction, load the current definition of its sequence and step, then decide:

   | Check | Outcome |
   |---|---|
   | Sequence `paused` | Release the claim. It runs when resumed (subject to `max_late`) |
   | Sequence `archived`, or subscriber blocklisted or deleted | End the enrollment (`canceled`) |
   | Step `deleted` | Advance to the next active step, without waiting again |
   | Later than `max_late` | Record a `skipped` send (`skip_reason = 'late'`), advance |
   | Marketing step, no permission on `list_id` | End the enrollment (`exited`, `unsubscribed`) |
   | Condition false | `on_false`: `skip` → advance; `exit` → end (`exited`, `condition`) |
   | Marketing step blocked by the frequency cap | `defer` → set `due_at` to the earliest allowed time; `skip` → record a skipped send, advance |
   | Otherwise | Insert a `queued` send for `(enrollment_id, step_id)`, advance |

3. "Advance" means: set `step_id` to the next active step and `due_at = now + its wait`, or mark the enrollment `completed` if there is none. Each enrollment's decision and advance is one short write transaction.

Guarantees:

- **No duplicate sends:** `sends` has a unique `(enrollment_id, step_id)`. If the process dies after inserting the send but before advancing, the next run sees the existing send and only advances.
- **Restart-safe:** all state is in `enrollments` and `sends`. Nothing waits in memory.
- **Edits apply to the next step:** because the scheduler reads the current definition when a step is due, changing a template, a wait or a condition affects everyone who has not reached that step. The new `wait` applies to steps scheduled after the change; already scheduled `due_at` values are kept. The admin UI offers "reschedule active enrollments" for when that is not wanted.

M5.4 implements this in `src/scheduler/scheduler.ts`, with enrollment SQL in `src/sequences/enrollments.ts` and send rows and marketing admission in `src/messaging/sends.ts` ([measurements and crash evidence](../perf/M5.4-scheduler.md)):

- The claim skips enrollments of `paused` and `draft` sequences, so a large paused sequence cannot fill every batch; one paused after its claim is released. Writes apply only while the claim (lease and step) still holds, so an enrollment exited by an event during a decision is left alone.
- The commit re-reads the sequence and step inside its write transaction. A sequence paused (or returned to draft) while the decision waited on its condition releases the claim; one archived ends the enrollment (`canceled`, `sequence_archived`). A change to the step's status, position, kind, template, subject, condition, `on_false`, `cap_policy`, `max_late` or the sequence's list discards the decision and releases the claim, so the step is decided again on the current definition. A stale decision never writes or sends.
- A decision that throws is logged and released for a retry in 1 minute; it never stops the loop. A failing claim (a broken database) still ends the loop and surfaces.
- A send already recorded for the current step is checked first and only advanced past. The send insert and the advance commit in one transaction, re-checking identity, blocklist, consent and the cap (queued rows count) inside it.
- A step whose template is missing or not `tx` (deleted templates set `template_id` to null) records a `skipped` send with the step's current (null) `template_id` with `skip_reason = 'template_unavailable'`, logs one attention message and advances. A rendering failure records `skipped` with `render_failed`, logs, and advances. A full renderer (capacity shared with the HTTP producers) retries in 15 seconds.
- A condition error (timeout, memory limit, execution) releases the claim with `retry_at` set after a backoff equal to how late the step already is, between 1 minute and 1 hour, logs an attention message without personal data, and never sends. Claims order by `coalesce(retry_at, due_at)`, so retried enrollments queue behind due work instead of filling every batch; `due_at` is kept, and `max_late` still measures from it.
- `defer` sets `due_at` to the first instant whose cap window starts at or after the subscriber's latest counted marketing send (queued and sending rows count from their creation or attempt), at least 1 minute ahead.
- A deleted current step advances to the first active step at or after its position, keeping its due time. A deleted step's position is a cursor kept by every save while an active enrollment waits on it: one past the current position of its nearest kept predecessor (0 without one). Steps deleted before migration 5 were converted once from their old position minus the steps removed before them in the same save.
- Template data adds `subscriber.id`, `step.uuid`, `step.position` and `step.kind`; steps have no name. `trigger` is null for manual enrollments or once retention purged the event. `manage_url` is the marketing unsubscribe URL with `?manage=true` (listmonk's form; the M2.5 preferences page serves it) and empty for transactional steps.
- Conditions get `triggerAt` from the trigger event (the enrollment start when there is none), `enrolledAt` from the enrollment, and `lastStepAt` from the enrollment's `updated_at`, which the scheduler changes only when a step ran (not for claims, deferrals or deleted steps).
- A subscriber who no longer exists cancels the enrollment with `subscriber_deleted` (normally the cascade already removed it).

## Admin UI

- Sequence list with counts: active, completed, exited enrollments; sent, skipped, opened, clicked per step.
- Sequence editor: trigger, exit events, reentry, list, steps as cards (wait, kind, template, condition in a CodeMirror JSON editor with validation and examples).
- Enrollment explorer: filter by sequence, subscriber, status, exit reason; see each enrollment's timeline (trigger event, step decisions, sends).
- Subscriber page: events, enrollments and sends for that person.
- Test mode: "enroll a test subscriber with every wait shortened to 1 minute".

M5.5 builds these screens in `src/admin/views` ([what they read](07-api-and-ui.md#sequence-screens-m55)). A timeline shows what the journal holds: the scheduler records a decision only when it writes a send, so a step passed without one reads "passed", inferred from the enrollment's position, and an enrollment that ended on a false condition shows that as its end. "Reschedule active enrollments" from the guarantees above is not built: it needs a write that M5.5 was not given, so the editor says that scheduled times are kept.

### Test mode

`POST /api/enrollments` with `test: true` starts a test enrollment, marked `test` in every enrollment response. It goes through the real scheduler and sends real mail to that subscriber.

- **Waits.** Every wait is at most 1 minute (`after` in `src/sequences/enrollments.ts`, the one place this happens). A shorter wait stays as it is, so `PT0S` is still immediate. A saved wait, a condition, a template and everything else about the definition stay as they are, and `max_late` still applies.
- **Who it can reach.** What a normal enrollment needs: the sequence is active and has a step, and the subscriber exists and is not blocklisted. If any current step is marketing, the subscriber must also hold consent on the sequence's list now, or the request is refused with 409 and the reason. A full frequency cap is not refusal: the cap applies as it does to anyone, so a marketing step can wait, and a test's sends count towards the cap. Consent lost later ends the enrollment as usual.
- **Other enrollments.** A test runs beside a real enrollment and does not end or replace it. One test of a sequence can run per subscriber (409 otherwise). `reentry` neither stops a test nor counts one, so a later real trigger behaves as if the test never happened. `force` is refused with it (400), because forcing is replacing.
- **Exits.** `exit_on` events, archiving, unsubscribing, blocklisting and cancelling end a test enrollment as they end any other.
- **Marks.** Mail subjects start with `[Test] `. The explorer and the subscriber tab show a label. `active_enrollments` and `/api/sequences/counts` leave tests out. Their sends stay in the send log and in `GET /api/sends/analytics`, which counts mail delivered, and the list page says so.

## Worked example

A SaaS app with prepaid packs and a subscription. The app sends `order_paid`, `subscription_created`, `subscription_canceled`, `subscription_past_due`, `payment_succeeded`, `download_finished` and `feedback_given` events, and keeps `plan` and `first_name` in `attribs`.

| Email | Sequence | Step |
|---|---|---|
| Credits ready | `order_paid` where `data.product = "prepaid"` | step 1, `PT0S`, transactional |
| Need a hand? | same sequence | step 2, `P3D`, marketing, `not event download_finished since trigger`, `on_false: exit` |
| Second pack: try the subscription | `order_paid` where `data.order_number = 2`, `reentry: never` | `PT0S`, marketing |
| Welcome | `subscription_created` | step 1, `PT0S`, transactional |
| Did the setup work? | same sequence | step 2, `P3D`, marketing, `not event connected since trigger` |
| Your month | `subscription_monthly_summary` (the app sends it with the totals in `data`) | `PT0S`, marketing, `event download_finished since P30D` |
| Payment failed | `subscription_past_due`, `exit_on: [payment_succeeded]` | step 1 `PT0S` transactional; step 2 `P5D` transactional |
| One question | `subscription_canceled`, `exit_on: [subscription_created]` | step 1, `PT0S`, transactional |
| Win-back | same sequence | step 2, `P45D`, marketing, `not event feedback_given where data.reason = "price"` |

The app's own code shrinks to sending these events from its billing webhook and product code, and to handling the `subscriber.unsubscribed` webhook to keep its consent field in sync.
