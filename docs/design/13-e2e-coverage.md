# E2E coverage for 1.0.0 (B63)

Read-only audit of the browser suite (`bun run e2e`, `test/e2e/specs/`) against every journey a user can take in the admin screens, the public pages, and the mail the app sends. It is based on `origin/main` at 99576c8. No test or code changed. The gap plan at the end is the input for the next e2e tasks.

## 1. Method and counts

- **Read, not named.** Each spec was read for its assertions, its clicks and navigation, and its API and mail calls, filtered with grep and awk, and the fixtures it reads were read in full (`test/e2e/helpers.js`, `test/e2e/stack.ts`, `test/e2e/run.ts`). The exception is `editor-containment.e2e.js` (1,102 lines, 54 tests of rich-text sanitising): it was judged from its test titles and its corpus loop at lines 89–123, not line by line. Test titles were only used to find the test start line (`file:line` below is the line of `test(` or `test.describe(`).
- **Journeys come from code.** Admin routes are in `src/admin/routes.ts`, public routes in `src/public/routes.tsx`, `src/public/archive.tsx` and `src/unsubscribe/routes.tsx`, and views in `src/admin/views/*.tsx` (their `data-testid` values give the actions). Mail is in `src/unsubscribe/message.ts`, `src/public/mail.ts` and `src/tx/routes.ts`.
- **Size.** 24 files under `test/e2e/specs/`: 289 `test(` call sites, which the parameterised loops expand. `docs/perf/e2e-speed.md` records 334 passing tests in its final runs. The seven `test/e2e/browser*.ts` passes (`bun run e2e:browser*`) print what each page said and fail only when an `agent-browser` command fails, so they are smoke checks and are not counted.
- **Status.** *Covered*: a test asserts the outcome through the UI, the API, or the mail sink. *Partial*: the journey is exercised but a named outcome is not asserted, or only part of it is. *None*: no browser test touches it. Contract, unit or non-browser tests may still cover a row; the note says so where that is known.

## 2. Coverage matrix

Line numbers are `file:line` of the test that owns the assertion. Unless a line says otherwise, the spec is in `test/e2e/specs/`.

### 2.1 Admin screens

| Journey | Tests | Status | What is missing |
|---|---|---|---|
| Sign in, wrong password, return to `next`, sign out, navigation by role | `login.e2e.js:7,17,26,38` | Covered | |
| First-run setup on a fresh instance (no account claim) | `login.e2e.js:56` | Covered | |
| Two-factor: enrol, challenged at login, disable | `twofa.e2e.js:6` | Covered | |
| Password reset: unknown address, mailed link once, reset does not skip 2FA | `reset.e2e.js:20,27,61` | Covered | |
| Profile: name, email, password, end other sessions | `users.e2e.js:520` | Covered | |
| API tokens shown once | `users.e2e.js:457` | Covered | |
| Restore hold banner (D67, `src/admin/layout/shell.tsx:221`) | none | **None** | Whole journey |
| Dashboard: counts, charts, system, escaped names, empty charts, scoped role, refused read | `dashboard.e2e.js:24,70,83,130` | Covered | Charts are checked against the API, not against seeded real clicks |
| Subscribers: search, SQL query, sort, export via API | `subscribers.e2e.js:44,52,71,87,93,106,126` | Covered | |
| Subscribers: create, pre-confirmed create, edit, blocklist by status, invalid attribs, rejected save, data download, delete | `subscribers.e2e.js:149,174,202,222,231,240,252` | Covered | |
| Subscribers: filters and pagination | `subscribers.e2e.js:277,289,301,310` | Covered | |
| Subscribers: bulk actions on page and by query (add, remove, unsubscribe, blocklist, export, delete); filtered bulk, split across `subscribers-filtered-bulk*.e2e.js` | `subscribers.e2e.js:342–434`; `subscribers-helpers.js` | Covered | |
| Subscriber detail: manage lists, delete subscription, overview | `subscribers.e2e.js:470,519,528` | Covered | |
| Subscriber detail: confirm and unsubscribe/re-subscribe a subscription | `subscribers.e2e.js:503,509` | Covered | Admin side only |
| Subscriber detail: opt-in confirmation sent | `subscribers.e2e.js:483` | Partial | Asserts a mail exists for the address. The confirmation link is never opened (see 2.3) |
| Subscriber detail: Bounces tab (`btn-clear-bounces`) | none | **None** | Clear bounces from the subscriber page |
| Subscriber detail: Activity tab, views and clicks | `sequences.e2e.js:457,477` | Covered | |
| Subscriber detail: Events, Enrollments, Sends tabs | `sequences.e2e.js:267` | Covered | |
| Subscribers: scope safeguards; list-scoped role | `subscribers.e2e.js:547,562,584` | Covered | |
| Import: modes, statuses, overwrite, stop, refused file, wrong delimiter, webhook budget, log rendering, polling | `import.e2e.js:51,91,104,121,134,150,176,231,240,260,279` | Covered | 100-row files only |
| Lists: show, counts, link to campaign, opt-in campaign, subscribers per list, edit, delete | `lists.e2e.js:93,107,117,128,144,182` | Covered | |
| Lists: create every type and opt-in combination, search, filters, sort, public lists on the form | `lists.e2e.js:211,249,262,276,283,295,312,322,344` | Covered | |
| Lists: bulk and filtered bulk deletion | `lists.e2e.js:357,389–419` | Covered | |
| List analytics: subscription chart, presets, selection in URL | `maintenance.e2e.js:207,223,256` | Partial | Only the subscription chart with seeded data. Unsubscriptions and the unique toggle are not checked |
| Campaigns: preview from list, search and filters, sort, timestamps, bulk delete | `campaigns.e2e.js:131,424,472,513,532` | Covered | |
| Campaigns: start, pause, send (resume), cancel, from the listing | `campaigns.e2e.js:622` | Partial | Checks status only. No count of mail sent, no check that a pause or cancel stops mail (see 2.3) |
| Campaigns: stale listing, double click sends once, live stats while running | `campaign-safety.e2e.js:213,247,281` | Covered | Live stats come from stubbed API responses |
| Campaigns: create and edit in four formats with one or two lists; metadata; schedule and unschedule | `campaigns.e2e.js:145,196` | Partial | The schedule is saved and read back. Firing at `send_at` is never observed |
| Campaigns: convert formats, alternate text, attributes, archive settings, shared subject, malformed JSON, clone | `campaigns.e2e.js:254,294,319,353,367,389` | Covered | |
| Campaigns: test send of unsaved content | `campaigns.e2e.js:270` | Covered | Mail checked in the sink |
| Campaigns: attachments delivered when started | `campaigns.e2e.js:563` | Covered | Mail checked in the sink |
| Campaigns: inline image vs URL in mail; link tracking toggles | `campaigns.e2e.js:646,712` | Covered | Link tracking checks the stored `href`, not a click |
| Campaign editor containment: handlers from paste, drop, stored body, format switch, dialogs | `campaign-editor.e2e.js:80,114,133,158,175,199,216,244` | Covered | |
| Campaign editor: previews reach no receiver | `campaign-editor.e2e.js:318,337` | Covered | |
| Campaign editor: unrelated saves keep archive metadata and the schedule | `campaign-editor.e2e.js:375,386` | Covered | |
| Campaign editor: send-only and manage roles start a campaign | `campaign-editor.e2e.js:407,442` | Covered | |
| Campaign rich-text corpus (hostile HTML, 54 tests across modes) | `editor-containment.e2e.js:89–1081` | Covered | |
| Campaign and template pages: hostile names, stored script, permission-gated buttons, templates reloaded | `campaign-safety.e2e.js:79,128,333,367,383` | Covered | |
| Campaign analytics: views chart with a real view | `maintenance.e2e.js:186` | Partial | Clicks, links and bounces charts are never asserted with data. The unique toggle is not tested |
| Campaign analytics: reader status charts | `maintenance.e2e.js:244` | Partial | Responses are stubbed with `page.route` |
| Templates: seeded defaults, clone, create/edit/preview, default template, delete, search and filter | `templates.e2e.js:37,44,53,100,117,135` | Covered | |
| Media: upload, search, copy URL, delete, image sizing, SVG, hostile names, refused root, permissions, picker | `media.e2e.js:47,72,100,129,154,175,215` | Covered | |
| Forms: public lists only, redirect whitelist, form HTML, snippet escaping, list scope, redirect after submit | `forms.e2e.js:60,72,81,96,137,226,240,259,275` | Covered | |
| Forms: subscribe through the public form, then unsubscribe and manage preferences | `forms.e2e.js:148` | Partial | The unsubscribe URL is built from the API, not taken from the mail (see 2.2) |
| CAPTCHA: solve, replay refused, missing answer refused, snippet, trusted site | `captcha.e2e.js:47,84,104,117,137` | Covered | |
| Bounces: actions by type, view and delete, paging and filters, hostile sources, select-all, viewer, permissions, bulk scopes | `bounces.e2e.js:81,110,131,167,207,235,263,305` | Covered | Bounces arrive through `POST /webhooks/bounce`, not signed SES notifications (see 2.3) |
| Sequences: test mode to sink, editor save and validation, live enrollments, explorer, condition checks, template preview | `sequences.e2e.js:53,103,125,182,218,353,390,443` | Covered | |
| Sequences: a changed wait applies to waiting enrollments | `sequences.e2e.js:410` | Covered | |
| Sequences: exit on unsubscribe or blocklist; re-entry; marketing step to a consenting person | none | **None** | Exits are implemented (`src/sequences/enrollments.ts:278–291`). See 2.3 and gap task E2 |
| Users and roles: create, edit, clone, delete roles (user and list), users, filters, bulk delete | `users.e2e.js:68,102,126,146,183,209,229,273,283,308,342` | Covered | |
| Users: last administrator refused; own role not raised; route permission per URL; logs in as scoped users | `users.e2e.js:320,330,370,398,432` | Covered | |
| Users: names as text on every screen | `users.e2e.js:480` | Covered | |
| Settings: sender defaults, save across tabs, logo and favicon, search | `settings.e2e.js:54,103,147,161` | Covered | |
| Settings: SMTP servers, presets, passwords, duplicate UUIDs, custom headers, test connection | `settings.e2e.js:183,222,268,303,320,342,379,418` | Covered | The test mail is checked in the sink (`settings.e2e.js:435`) |
| Settings: privacy, performance, security (trusted URLs, CAPTCHA) | `settings.e2e.js:439,468,486,515` | Covered | |
| Settings: bounces and SES settings; bounce appears on the bounces screen | `settings.e2e.js:568,602` | Covered | |
| Settings: appearance editors, public custom CSS and JS | `settings.e2e.js:635,679` | Covered | |
| Settings: media provider read-only; messengers kept; viewing needs `settings:get` | `settings.e2e.js:746,760` | Covered | |
| Maintenance: orphans and blocklisted, unconfirmed opt-ins, export link, webhook budget, permissions | `maintenance.e2e.js:28,50,66,90,106` | Covered | |
| Logs: rendered as text, refused read, failure message, empty log | `maintenance.e2e.js:116,142,168` | Covered | |
| Hostile names and parameters on every screen | `hostile.e2e.js:10,104` | Covered | |
| Every screen loads under the CSP and Alpine expressions evaluate | `csp.e2e.js:32,122,200,241` | Covered | Loads the screens, does not check their data |

### 2.2 Public pages

| Journey | Tests | Status | What is missing |
|---|---|---|---|
| Subscription form (`POST /subscription/form`) | `forms.e2e.js:148`; `captcha.e2e.js:47,775,795` | Covered | |
| Double opt-in confirmation (`GET`/`POST /subscription/optin/:subUUID`, `src/public/routes.tsx:383–384`) | none | **None** | The link from the confirmation mail is never opened |
| Unsubscribe from a campaign link (`/subscription/:campUUID/:subUUID`) | `forms.e2e.js:148` | Partial | The URL is built from API data, not from the mail body |
| Preferences (`?manage=true`), blocklist from the public page | `forms.e2e.js:148` | Covered | |
| Message unsubscribe page (`GET /m/:sendUUID/unsubscribe/:subUUID`, `src/unsubscribe/routes.tsx:116`) | none | **None** | |
| One-click unsubscribe (`POST /m/…/unsubscribe/…`, `routes.tsx:131`) and the `List-Unsubscribe` headers (`src/unsubscribe/message.ts:32–33`) | none | **None** | The sink returns no headers (see section 3) |
| Subscriber data export and wipe (`/subscription/export/:subUUID`, `/subscription/wipe/:subUUID`, `src/public/routes.tsx:386,406`) | none | **None** | Both are data-safety journeys |
| Form snippet and redirect whitelist | `forms.e2e.js:226–275`; `captcha.e2e.js:117,828` | Covered | |
| Archive index, detail, latest and feed (`src/public/archive.tsx:186,221,296,309`) | `csp.e2e.js:147–179` | Partial | Only status 200 and the CSP are checked. Content, listing and visibility of unarchived campaigns are not |
| Campaign web view and open pixel (`archive.tsx:126`, `src/unsubscribe/routes.tsx:178`) | `sequences.e2e.js:457` | Partial | The pixel is fetched directly. The page itself is not checked |
| Click redirect (`/m/…/link/…`, `src/unsubscribe/routes.tsx:202`) | `sequences.e2e.js:457,477` | Partial | Status and `Location` checked; the redirected target is not |
| Public custom CSS and JS | `settings.e2e.js:635–675` | Covered | |

### 2.3 Mail flows (observed in the SMTP sink)

| Flow | Tests | Status | What is missing |
|---|---|---|---|
| Campaign test send | `campaigns.e2e.js:270` | Covered | |
| Campaign send with attachment; inline image | `campaigns.e2e.js:563,646` | Covered | |
| Campaign send: count of mails, once per person, schedule firing at `send_at`, pause and cancel stop mail | none | **None** | `campaigns.e2e.js:622` checks status only |
| Campaign unsubscribe link in the mail, `List-Unsubscribe` and one-click | none | **None** | |
| Opt-in confirmation mail | `subscribers.e2e.js:483`; `forms.e2e.js:148` | Partial | The mail is counted; its content and link are not used |
| Password reset mail | `reset.e2e.js:27` | Covered | |
| SMTP test mail | `settings.e2e.js:418` | Covered | |
| Sequence test mode to the sink, timeline | `sequences.e2e.js:53` | Covered | Uses the real scheduler and real time |
| Sequence step on an event (`PT0S`) | `sequences.e2e.js:267` | Covered | |
| Sequence marketing step to a consenting person | none | **None** | `sequences.e2e.js:103` covers only the refusal |
| Transactional `POST /api/tx` | none in browser | **None** | API-level tests outside the browser suite post to it, for example `test/unsubscribe/unsubscribe.test.ts` |
| Admin notification mails (B38: campaign finished, cancelled or auto-paused; import finished or failed) | none | **None** | Settings in `src/admin/views/settings.tsx:214` |
| Webhook deliveries to a receiver | none | **None** | The webhook budget tests create webhooks but never observe a delivery |
| Bounce ingress by signed SES notification | none | **None** | Covered by `test/bounces/ses.test.ts` with an injected fetch. See the decision in gap task E4 |
| Preview leaves no mail and reaches no receiver | `campaign-editor.e2e.js:318,337` | Covered | |

## 3. What the harness can and cannot do

These facts shape the plan. Each one was checked in source.

1. **The sink drops headers.** `mailbox.mails` keeps `header(name)` (`test/e2e/stack.ts`, via `decode` at `test/worked-example/harness.ts:128–138`), but `serveMail` in `test/e2e/run.ts:57–65` returns only `{ subject, body }`. Any assertion on `List-Unsubscribe` or `List-Unsubscribe-Post` needs `headers` added to that response. That is a harness change, not a production hook.
2. **There is no server clock.** `src/clock.ts` has no override, and the compiled executable reads real time. Playwright's `page.clock` (used in `maintenance.e2e.js:227`) moves only the browser. So scheduling and sequence waits must use real time. The scheduler polls every 15 s (`src/scheduler/scheduler.ts:30`), and the reschedule endpoint applies a changed wait to waiting enrollments (`sequences.e2e.js:410`). The plan does not add a production test clock.
3. **Send rate sets test length.** `app.message_rate` defaults to 10 a second (`src/settings/defaults.ts:8`). The pause and cancel test sends 600 readers for about 60 s (`campaigns.e2e.js:622`). A spec can lower the rate and restore it in `afterEach`, as `settings.e2e.js:44` does.
4. **Several tests prove a mail exists, not what it says.** `forms.e2e.js:148` and `subscribers.e2e.js:483` count mails and never open the link in them. Consent is the main case.
5. **Consent flows are built from the API.** `forms.e2e.js:148` builds `/subscription/${campaign.uuid}/${first.uuid}` from API responses. The link a subscriber would click is never taken from the mail.
6. **SNS signing cannot be run end to end without a production hook.** `test/bounces/ses-fixture.ts` signs notifications and injects the certificate fetch. The compiled executable fetches the fixed AWS certificate URL, so an e2e test would need a switch to point it at a local server. That is a production test hook, which this plan does not add. Signed SES ingress stays at contract level.
7. **There is a reusable receiver.** `receiver()` at `test/e2e/specs/campaign-editor.e2e.js:285` is a local HTTP server that records hits. Gap task E4 moves it to `helpers.js` so the other specs can use it.
8. **Timing-sensitive tests.** `playwright.config.js` sets `retries: 0` and `workers: 1`. The slowest timed tests are the 180 s test-mode sequence (`sequences.e2e.js:53`), the 60 s import stop (`import.e2e.js:104`), the 600-reader campaign (`campaigns.e2e.js:622`), and the live-stats polling (`campaign-safety.e2e.js:281`). A flake in any of them fails the whole run.

## 4. Gap plan

Seven tasks, each about 8–15 tests, release-critical first. Each can run as its own spec file, so the longest-first queue keeps working. Test counts are estimates.

### E1. Sending lifecycle to the sink (release-critical, about 14 tests)

- **Journeys:** scheduled campaign fires at `send_at`; pause stops mail and resume finishes it; cancel stops mail; a person on two lists gets one mail; unsubscribed and blocklisted people get none; the sent count on the listing matches the mail count; `POST /api/tx` delivers with its template and attachment, and an unknown template is refused.
- **Spec:** new `test/e2e/specs/sending.e2e.js`.
- **Fixtures:** the SMTP sink; an audience helper (`campaigns.e2e.js` has `audience()` at its top, which should move to `helpers.js`); a helper that counts mails and waits for the count to hold still for a fixed settle window in real time; `app.message_rate` lowered in this spec and restored in `afterEach`.
- **Harness gap:** the counting helper only. No clock change.

### E2. Consent and unsubscribe from the mail (release-critical, about 14 tests)

- **Journeys:** following the double opt-in link in the confirmation mail confirms the subscription (`GET` then `POST`); a wrong or unknown UUID changes nothing; the unsubscribe link in a campaign mail unsubscribes from that list only; the message page `/m/…/unsubscribe/…` works; the one-click `POST` works from the `List-Unsubscribe-Post` header; blocklist-all leaves no mail for the next campaign; re-subscribing through the form follows the list's opt-in rule; sequence marketing reaches a consenting person; a sequence enrollment exits when its person unsubscribes or is blocklisted (the product does this, `src/sequences/enrollments.ts:278–291`, and no browser test checks it).
- **Spec:** new `test/e2e/specs/consent.e2e.js`.
- **Fixtures:** the sink with headers; a campaign send (E1's helper); a double opt-in list.
- **Harness gap:** add `headers` to `serveMail` in `test/e2e/run.ts:57–65`. This is the only change this task needs outside its spec.

### E3. Operations and data safety (about 10 tests)

- **Journeys:** campaign finished, cancelled, or auto-paused mails reach `app.notify_emails` (B38); import finished and failed mails do the same; the notify-email setting validates and saves; the restore-hold banner shows on a restored instance and no mail is sent while the hold stands; release clears it; GDPR export and wipe through the public pages (2.2) with the mail stopping after a wipe.
- **Spec:** new `test/e2e/specs/operations.e2e.js`.
- **Fixtures:** the notify-email setting; a third instance made from a snapshot taken with the existing `backup` CLI, which writes the hold itself (D67). The release step uses the CLI on a stopped server, as D67 requires.
- **Harness gap:** `stack.ts` must start that third instance. This uses the production CLI and adds no hook.

### E4. Webhooks and bounce ingress (about 10 tests)

- **Journeys:** a webhook registered through the API receives subscriber and campaign events at a local receiver; a hard bounce through `POST /webhooks/bounce` blocklists the person and reaches the receiver; the webhook budget refusal shows its message; the receiver sees nothing for a webhook that is disabled.
- **Spec:** new `test/e2e/specs/webhooks.e2e.js`. Add the bounce cases to `bounces.e2e.js`.
- **Fixtures:** the receiver, moved from `campaign-editor.e2e.js:285` to `helpers.js`; `webhooks.block_private_addresses` turned off for the spec and restored, as `settings.e2e.js` already does.
- **Decision:** signed SES notifications stay at contract level (see section 3, item 6). Making them e2e needs a production hook.

### E5. Public archive and tracking pages (about 10 tests)

- **Journeys:** the archive index lists archived campaigns only; the detail page renders the body with the archive template; `/archive/latest` and `archive.xml` show the campaign; an archive that is off returns not-found; hostile names render as text; the web view for a real subscriber renders without a view pixel or tracked links and records no view (deliberate difference, `07-api-and-ui.md`, public view and archive pages); the open pixel is a PNG and records nothing when tracking is disabled; the `/m/…/unsubscribe/…` page works (there is no `GET /m/:sendUUID` message page). Done in B68 (#121).
- **Spec:** new `test/e2e/specs/public.e2e.js`.
- **Fixtures:** a finished, archived campaign (exists in `csp.e2e.js:147–160`); the privacy setting.
- **Harness gap:** none.

### E6. Analytics with real data (about 10 tests)

- **Journeys:** campaign clicks and links charts after real clicks; the bounces chart after a bounce; the unique toggle with individual tracking on; the interval (day, week, month) and the date range change the buckets; the list unsubscriptions chart after a real unsubscribe; the dashboard charts after real views.
- **Spec:** new `test/e2e/specs/analytics.e2e.js`, or extend `maintenance.e2e.js`.
- **Fixtures:** the pixel and link `GET`s (`sequences.e2e.js:457`); `POST /webhooks/bounce`; the privacy setting.
- **Harness gap:** none. The range is fixed through `from` and `to`.

### E7. Sequence depth (about 10 tests)

- **Journeys:** re-entry policies, seen in the explorer; a `PT0S` step that sends within one scheduler interval; a changed wait applied to waiting enrollments through the reschedule endpoint; a paused or deactivated sequence stops sending, and reactivation resumes it; the on-false branch of a condition; a trigger with a `where` clause; the timeline shows sent, skipped and failed entries.
- **Spec:** new `test/e2e/specs/sequences-lifecycle.e2e.js`. The file is kept separate so `sequences.e2e.js` (616 lines) stays one balanced file.
- **Fixtures:** the events API, the reschedule endpoint, and steps with `PT0S`.
- **Harness gap:** none.

**Order:** E1, E2 and E3 first, because they cover sending, consent and data safety. E4 to E7 after them.

**Time added.** The new specs add about 1–2 minutes each on two stacks. E1 and E7 contribute most of the real-time waits (the scheduler's 15 s polls, and 60 s sends).

## 5. Release gate

- **Current runtime.** `docs/perf/e2e-speed.md`: 17.0 min serially for 334 tests (2026-11-05, loaded host); 9.8–10.1 min at the default two stacks under load of 9–16; 5.6 min at three stacks on a lighter host. The default is two stacks because each stack takes about 1.1 GiB and one to one and a half cores.
- **Where it would run.** `release.yml` runs on tag pushes and `workflow_dispatch`. Its `build` job runs on matrix runners, and `publish` depends only on `build` (`release.yml:62–65`). `publish` and `image` run on `ubuntu-24.04` (`release.yml:65,110`). I believe GitHub's standard public Linux runner has 4 vCPU and 16 GB RAM; that should be checked before the timing is relied on.
- **Recommendation: yes, but after a stability pass.** Add an `e2e` job on `ubuntu-24.04` that installs Chromium with Playwright (cache `~/.cache/ms-playwright`), runs `bun run e2e` with `E2E_WORKERS=2`, and make `publish` depend on it: `needs: [build, e2e]`. The job only needs to run on the x86-64 build, since `bun run e2e` builds the executable itself. Make it required only after the full suite passes three times in a row on the release-candidate commit. The suite has real-time waits and no retries, so one flaky run would block a release.
- **Owner decisions needed.** (1) Whether one Playwright retry is acceptable in the release job. (2) `AGENTS.md` says CI is not a merge gate. A release-tag gate is a different thing, but the owner should confirm that is the intent. (3) Whether the restore-hold test (E3) is worth a third instance on every run.

## 6. Not covered by design

- **MCP** is API only and is covered by `test/mcp`. No browser test is planned for it.
- **Backup and restore CLI** is covered by `test/backup`. E3 uses the CLI only to set up the restore-hold case.
- **Signed SES notifications** are covered by `test/bounces` and the contract suite (section 3, item 6).
- **Visual layout** is covered by `bun run ui:verify` and the agent-browser passes, which print and do not assert.
