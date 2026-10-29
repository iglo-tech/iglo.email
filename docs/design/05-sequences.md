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
- Response: the event ID, the subscriber ID, and the enrollments it started or ended.

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
| `trigger.where` | Optional predicate on the triggering event and the subscriber (same language as conditions) |
| `exit_on` | Event names that end an active enrollment |
| `reentry` | `never`: once per subscriber ever. `after_exit`: again after the previous enrollment finished. `always`: every matching event starts a new enrollment, and a running one is replaced |
| `list_id` | Marketing permission list for the marketing steps. Required if any step is `marketing` |
| `steps[].wait` | ISO 8601 duration after the previous step ran (or after the trigger for the first step) |
| `steps[].kind` | `marketing` or `transactional`. Decides permission checks, the cap and unsubscribe links |
| `steps[].condition` | Checked when the step is due. Missing means always true |
| `steps[].on_false` | `skip` (move to the next step) or `exit` (end the enrollment). Default `exit` |
| `steps[].cap_policy` | `defer` (default) or `skip`, when the frequency cap blocks a marketing step |
| `steps[].max_late` | If the step runs later than `due_at + max_late` (server down, sequence paused), skip it instead of sending something stale. Default: no limit for transactional, `P2D` for marketing |

Sequences are managed in the admin UI and through `GET/POST/PUT/DELETE /api/sequences`. Definitions are versioned only by `updated_at`; the admin UI shows a warning with the number of active enrollments before saving changes.

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
- the usual functions: `unsubscribe_url` (marketing steps), `manage_url`, `track_link`, `track_view` ([Templates](06-templates.md)).

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

## Admin UI

- Sequence list with counts: active, completed, exited enrollments; sent, skipped, opened, clicked per step.
- Sequence editor: trigger, exit events, reentry, list, steps as cards (wait, kind, template, condition in a CodeMirror JSON editor with validation and examples).
- Enrollment explorer: filter by sequence, subscriber, status, exit reason; see each enrollment's timeline (trigger event, step decisions, sends).
- Subscriber page: events, enrollments and sends for that person.
- Test mode: "enroll a test subscriber with every wait shortened to 1 minute".

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
