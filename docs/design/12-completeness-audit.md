# Completeness audit (D89)

An end-to-end completeness audit of iglo.email against the needs of typical **newsletter**, **lifecycle (sequences)**, and **transactional** email projects, following the owner direction in [D89](09-decisions.md#d89-narrow-complete-product-scope-owner-2026-11-07): "feature complete but not wide: everything a typical project needs, with one way to do each thing."

Every "present" claim is verified against code and public endpoints with file:line citations. Every "gap" names what was looked for and where. Every duplicate identifies whether it stays (e.g. required for listmonk API compatibility under D57) or should be removed.

---

## 1. Inventory and Checklist

### Audience

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| CSV import | Present | `src/subscribers/import/routes.ts:162` (`POST /api/import/subscribers`), `src/subscribers/import/importer.ts:329` (`start`), `src/admin/views/import.tsx:1` | Keep (v1 core) |
| ZIP import | Duplicate / Dropped | `src/subscribers/import/routes.ts:120` explicitly throws 400 "Only a CSV file can be imported: ZIP files are not supported." | Drop (CSV is the one way, D89) |
| Subscriber export | Present | `src/subscribers/query-routes.ts:490` (`GET /api/subscribers/export`), `src/subscribers/export.ts:1-60` | Keep |
| Segments / SQL queries | Present | `src/subscribers/query-routes.ts:489` (`GET /api/subscribers?query=`), `src/subscribers/query.ts:1`, isolated query runner in `src/subscribers/query-runner.ts:24` | Keep |
| Query bulk actions | Present | `src/subscribers/query-routes.ts:493-508` (`POST /api/subscribers/query/delete`, `PUT /api/subscribers/query/blocklist`, `PUT /api/subscribers/query/lists`) | Keep |
| Custom attributes | Present | `attribs` JSON column in `src/subscribers/store.sql:18`, validated in `src/subscribers/input.ts:81` (`validAttributes`), stored in `src/subscribers/store.ts:286, 477` | Keep |
| Double opt-in confirmation | Present | `src/public/routes.tsx:383-384` (`POST /subscription/optin/:subUUID`), `src/public/mail.ts:132-150` (`optin`), `src/subscribers/routes.ts:202-203` (double opt-in for API-created subscribers) | Keep |
| Preference centre (manage lists) | Present | `src/public/preferences.tsx:1-120`, `src/campaigns/public.tsx:110-131` (`GET/POST /subscription/:campUUID/:subUUID`), `src/unsubscribe/routes.tsx:120-145` (manage preferences) | Keep |
| Unsubscribe (one-click RFC 8058) | Present | Campaign: `src/campaigns/public.tsx:120-131` (`POST /subscription/:campUUID/:subUUID`); Transactional: `src/unsubscribe/routes.tsx:129-131` (`POST /m/:sendUUID/unsubscribe/:subUUID`); Header: `src/campaigns/runner/runner.ts:400-403` (campaigns) and `src/unsubscribe/message.ts:28-35` (tx and sequences) (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) | Keep |
| Blocklist / Suppression | Present | `src/subscribers/routes.ts:436` (`PUT /api/subscribers/:id/blocklist`), line 444 (`PUT /api/subscribers/blocklist`), domain blocklist `src/messaging/sends.ts:142` (`addressBlocklisted`), `privacy.domain_blocklist` | Keep |
| GDPR export and wipe | Present | Export: `src/subscribers/routes.ts:382` (`GET /api/subscribers/:id/export`), `src/public/routes.tsx:386` (`POST /subscription/export/:subUUID`). Wipe: `src/public/routes.tsx:406` (`POST /subscription/wipe/:subUUID`), `src/subscribers/routes.ts:429` (`DELETE /api/subscribers/:id?wipe=true`), anonymizer in `src/messaging/anonymize.ts:1` | Keep |
| Subscriber activity history | Present | `src/subscribers/routes.ts:360-364` (`GET /api/subscribers/:id/subscriber-events`, `/enrollments`, `/sends`), `src/subscribers/routes.ts:375` (`GET /api/subscribers/:id/activity`), tracking in `src/analytics/subscriber.ts:1-60` | Keep |
| External ID addressing | Duplicate (URL forms) | Path: `/api/subscribers/external/:external_id` (`src/subscribers/routes.ts:461`); Query: `/api/subscribers/external?external_id=...` (`src/subscribers/routes.ts:461`, D39) | Stays (query form is required because Bun normalizes encoded dot segments `%2E` in URL paths, D39) |

---

### Campaigns

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| Campaign drafts | Present | `status: "draft"` default on creation, `src/campaigns/store.ts:212`, `src/campaigns/routes.ts:837` | Keep |
| Scheduling | Present | `send_at` timestamp field in `src/campaigns/store.ts:70`, validated in `src/campaigns/input.ts:182`, evaluated by runner loop in `src/campaigns/runner/store.sql:6-8` and `src/campaigns/runner/runner.ts:325-329` (`claimBatch` via `store.due`) | Keep |
| Test send | Present | `src/campaigns/routes.ts:836` (`POST /api/campaigns/:id/test`), MCP tool `send_campaign_test` in `src/mcp/tools.ts:236` | Keep |
| A/B subject testing | Gap / Dropped | Explicit non-goal in `docs/design/01-scope.md:23` ("A/B testing"). No schema fields or sample split runner in `src/campaigns/` | Drop (violates D89 one-way simplicity; adds sample-splitting and statistical variance complexity with minimal owner benefit; a typical project doesn't need it) |
| Pause / Resume / Cancel | Present | `src/campaigns/routes.ts:841` (`PUT /api/campaigns/:id/status`), coordinates runner state transitions between `draft`, `scheduled`, `running`, `paused`, `cancelled`, and `finished` | Keep |
| Throttling / Rate limits | Present | Concurrency and message rate pacing in `src/campaigns/runner/runner.ts:515-545`, sliding window rate limiting via `app.message_sliding_window`, `app.message_sliding_window_rate`, `app.message_sliding_window_duration` | Keep |
| Shared send-rate cap | Gap | No process-wide send-rate cap shared across all sending sources. Campaign runner limits rate per worker (`src/campaigns/runner/runner.ts:515-545`, `app.message_rate` × `app.concurrency`, up to 100/s default in `src/settings/defaults.ts:7-8`), while the outbox pushes tx and sequence mail with no rate limiter (`src/messaging/outbox.ts:18`). Throttled sequence sends end `failed` without retry (`src/messaging/sends.ts:312`), silently losing lifecycle email against SES account rate limits (14/s default) | Task (implement process-wide shared send-rate cap, task B37) |
| Archive page and RSS | Present | Decided by B36 (previously listed under "Later" in `01-scope.md:36`): fully implemented in `src/public/archive.tsx:164` (`GET /api/public/archive`), line 186 (`GET /archive.xml`), line 221 (`GET /archive`), line 296 (`GET /archive/latest`), line 309 (`GET /archive/:id`), gated by `app.enable_public_archive` | Keep (confirm v1 feature) |
| Per-campaign analytics | Present | `src/analytics/routes.ts:225` (`GET /api/campaigns/analytics/:type`), SQL aggregation in `src/analytics/queries.sql:1-48`, admin views in `src/admin/views/analytics.tsx:137-326` | Keep |
| Unique vs Total counts | Present | `src/analytics/routes.ts:159-164` (evaluates `params.get("unique") === "true"` and `privacy.individual_tracking`), checkbox in `src/admin/views/analytics.tsx:235` | Keep (confirm v1 feature) |
| Link tracking | Present | `src/unsubscribe/tracking.ts:1-120`, link rewrite in `src/campaigns/render.ts:37`, redirect handler `GET /link/:linkUUID/:campUUID/:subUUID` in `src/campaigns/public.tsx:215` | Keep |
| List / Segment targeting | Present | Campaigns target list IDs (`src/campaigns/input.ts:39`, `src/subscribers/campaign-recipients.ts:8-12`). Dynamic segmentation is performed by query bulk actions into lists (`PUT /api/subscribers/query/lists`) | Keep (the query-to-list bulk action is the one way, as upstream) |
| Attachments & Media | Present | `media` array on campaigns (`src/campaigns/input.ts:40`), cached and attached in `src/media/attachments.ts:1` and `src/campaigns/runner/runner.ts:443-460` | Keep |
| Plain-text alternative | Present | `altbody` field on campaigns (`src/campaigns/input.ts:27`), compiled in `src/campaigns/render.ts:60`, sent as MIME alternative `altBody` in `src/messaging/email.ts:313`, MCP tool `campaign_text` in `src/mcp/tools.ts:221` | Keep |
| Campaign preview | Present | `src/campaigns/routes.ts:817-818` (`GET|POST /api/campaigns/:id/preview`), MCP tool `preview_campaign` in `src/mcp/tools.ts:202` | Keep |
| Campaign cloning | Present | `src/admin/views/campaigns.tsx:149`, `onClone()` duplicates campaign parameters into a new draft | Keep |

---

### Lifecycle (Sequences)

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| Event ingestion API | Present | `src/events/routes.ts:44` (`POST /api/subscriber-events`), line 64 (`POST /api/subscriber-events/batch`), supports `subscriber_id`, `email`, `external_id`, and `idempotencyKey` (`src/events/input.ts:24`) | Keep |
| Sequence triggers | Present | `trigger` column in `src/sequences/store.sql:10`, parsed in `src/sequences/input.ts:237-240`, triggered on matching event ingestion via `exitThenTrigger` in `src/events/store.ts:36-39, 126-135` | Keep |
| Delays & Steps | Present | `wait` ISO 8601 duration on steps validated in `src/sequences/input.ts:155`, due time calculations in `src/sequences/enrollments.ts`, recalculated via `POST /api/sequences/:id/steps/:step/reschedule` (`src/sequences/routes.ts:241`, `src/sequences/enrollments.ts:500-540`) | Keep |
| Exit conditions / Exit events | Present | `exit_on` array on sequence definitions (`src/sequences/input.ts:241-249`), exits evaluated in `src/events/store.ts:36-39, 126-135` and `src/sequences/enrollments.sql:10` | Keep |
| Send-time step conditions | Present | Evaluated at send time in `src/conditions/evaluate.ts:1`, syntax validated via `POST /api/conditions/validate` (`src/sequences/routes.ts:215`), compiled in `src/conditions/compile.ts:1` | Keep |
| Per-step analytics | Present | `src/analytics/routes.ts:196-201` (`GET /api/sends/analytics?group_by=step`), displayed in `src/admin/views/sequence.tsx` and `sequences.tsx` | Keep |
| Manual & test enrollments | Present | `POST /api/enrollments` with `test: true` or `force: true` (`src/sequences/routes.ts:355-401`) | Keep |
| Enrollment timeline | Present | `GET /api/enrollments/:id/timeline` (`src/sequences/routes.ts:333`), detailed audit trace of steps, conditions, and sends (`src/sequences/timeline.ts:1`) | Keep |

---

### Transactional

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| API send with template + data | Present | `src/tx/routes.ts:155` (`POST /api/tx`), accepts `{ subscriber_email, template_id, data, headers, attachments, ... }` | Keep |
| Idempotency key | Present | `idempotencyKey` field in `src/tx/input.ts:33`, replay check in `src/tx/routes.ts:225-233`, deduplicated and stored in `src/messaging/sends.ts:496-510` | Keep |
| Delivery status lookup | Present | `src/messaging/routes.ts:58` (`GET /api/sends/:id`), line 13 (`GET /api/sends`), returns delivery status (`queued`, `sending`, `sent`, `failed`, `skipped`) and Message-ID | Keep |
| Transactional attachments | Present | Base64-decoded attachments in `src/tx/input.ts:10-14, 35`, attachment budget checks in `src/tx/routes.ts:125` | Keep |
| Per-message events (webhooks out) | Present (Narrow) / Dropped | `src/webhooks/store.ts:9-15` emits `send.failed` and `bounce.recorded`. Does NOT emit `send.delivered`, `send.opened`, or `send.clicked` webhooks | Drop (SMTP acceptance is not inbox delivery, SES Delivery events are refused by design, and opens/clicks are in analytics API; `send.failed` and `bounce.recorded` cover consent sync; log drop in D89) |

---

### Deliverability

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| DKIM signing | Present (SES Easy DKIM / nodemailer config) / Dropped (Admin UI) | Nodemailer DKIM supported in `src/messaging/email.ts:199-205` and D50 (`smtp[i].dkim = { domain_name, key_selector, private_key }`). Drop DKIM admin UI: with Amazon SES as the only provider (D89), SES Easy DKIM is the one way to sign; in-app `smtp[].dkim` stays API-only for listmonk compatibility (D50/D57). Document in `docs/operations.md` (task B41) | Drop DKIM admin UI; document SES Easy DKIM as the one way in `docs/operations.md` (task B41) |
| SPF / DMARC guidance | Gap | Absent from `docs/operations.md` and admin UI | Task (document SES Easy DKIM, SPF via custom MAIL FROM domain, and DMARC alignment and policy in `docs/operations.md`, task B41) |
| SES configuration set | Present (Documented) | Documented in `docs/operations.md:290-291` (Amazon SES step 1: `X-SES-CONFIGURATION-SET` via `smtp[].email_headers`), supported in `src/campaigns/input.ts:30`, `src/tx/input.ts:26`, `src/settings/defaults.ts:97` | Keep (already documented and supported) |
| Bounce & complaint handling | Present | `src/bounces/routes.ts:364` (`POST /webhooks/service/ses`), `src/bounces/ses.ts:1-338`, verified via SNS certificate and `bounce.ses_topic_arns` allowlist | Keep |
| Threshold actions | Present | `bounce.actions` in `src/settings/defaults.ts:123-136`, executed in `src/bounces/store.ts:180-220` (soft count, hard count, complaint count -> blocklist/unsubscribe/delete) | Keep |
| Sending domain checks | Present (Syntax) / Dropped (DNS) | `src/settings/mail.ts:1-60` validates email syntax and domain format; D50 explicitly establishes "No DNS lookup or DNS-verification claim" to avoid network calls during transactions | Drop runtime DNS checks (SES verifies identities; syntax validation suffices, D50) |
| List-Unsubscribe header | Present | `src/campaigns/runner/runner.ts:400-403` (campaigns), `src/unsubscribe/message.ts:28-35` (tx and sequences), `src/tx/routes.ts:439-445`, controlled by `privacy.unsubscribe_header` | Keep |
| RFC 5322 Message-ID | Present | Generated in `src/messaging/email.ts:432`, saved to `sends.message_id` and tracked on bounce | Keep |

---

### Operations

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| Users, Roles & API keys | Present | `src/users/store.ts`, `src/roles/roles.ts`, `src/users/auth.ts:1-300`, TOTP in `src/users/totp.ts:1` | Keep |
| Administrative audit log | Gap / Dropped | No administrative audit logging in `src/` for user actions (creation, deletion, role changes, settings changes). Only application error log buffer exists (`src/maintenance/log-buffer.ts`) | Drop (for a single-owner instance with 1-2 admins, an audit log engine exceeds D89 scope; backups and `/api/logs` are enough; log drop in D89) |
| Backup & restore hold | Present | CLI command `iglo.email backup` (`src/backup/cli.ts:1`), `restoreHold` in `src/settings/hold.ts:1` (D67) | Keep |
| Upgrade path | Present | Automatic SQLite migrations in `src/db/migrations.ts:1-150` run on startup (`src/main.ts:179`) | Keep |
| Health check | Present | Unauthenticated `GET /health` (`src/server/server.ts:12`), Authenticated `GET /api/health` (`src/users/routes.ts:30`) | Keep |
| Metrics / Logging | Present (Logs) / Dropped (Metrics) | Logging: `GET /api/logs` (`src/maintenance/routes.ts:251`, 100-line safe buffer in `src/maintenance/log-buffer.ts`). Metrics: No Prometheus `/metrics` endpoint | Drop Prometheus `/metrics` (container stats, `/health`, `/api/health` and `/api/logs` are enough; log drop in D89) |
| Public rate limits | Present | `src/public/rate-limit.ts:1`, configured via `security.public_rate_limit` (subscribe, optin, unsubscribe, privacy) | Keep |
| Signed webhooks out | Present | `src/webhooks/delivery.ts:1-250`, HMAC SHA-256 signatures with retry backoff | Keep |
| Settings UI | Present | `src/admin/views/settings.tsx:1-1161`, mounted at `/admin/settings` | Keep |
| Docker image | Present | `Dockerfile:1-55`, official multi-arch Docker image (amd64, arm64) built in `.github/workflows/release.yml` wrapping compiled binary (D89) | Keep |
| MCP endpoint | Present (B39 #91 closed the gap: 20 tools) | `POST /api/mcp`, 14 tools at audit time (`src/mcp/routes.ts:1`, `src/mcp/tools.ts:1-656`, D91). Missing `create_campaign` (POST `/api/campaigns`), `list_lists` (GET `/api/lists`), `list_media` (GET `/api/media`), and read-only `list_sequences`/`get_sequence` | Task (add missing MCP tools for D89 completeness, update D91 and tests, task B39) |

---

### Templates

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| Campaign, Tx & Archive templates | Present | `src/templates/store.ts:11` (`type TemplateType = "campaign" | "campaign_visual" | "tx"`), archive template seeded in migration 0001 and rendered in `src/public/archive.tsx:104` | Keep |
| Template preview | Present | `src/templates/routes.ts:181` (`GET /api/templates/:id/preview`), `src/templates/routes.ts:191` (`POST /api/templates/preview`), `src/mcp/tools.ts:105` | Keep |
| Liquid reference guide | Present | `docs/design/06-templates.md`, `src/mcp/reference.ts:1-247`, MCP tool `template_reference` in `src/mcp/tools.ts:263` | Keep |
| Media library | Present | `src/media/store.ts:1-120`, `src/media/routes.ts:1-280`, filesystem storage in `src/media/filesystem.ts:1-180`, admin view `src/admin/views/media.tsx:1-150` | Keep |
| Thumbnail generation | Gap / Dropped | Deferred in `docs/design/01-scope.md:40` ("thumbnails (B36 decides)"); `src/media/routes.ts:5, 203` points `thumb` directly to the original uploaded file itself | Drop (`thumb` is the original image; avoids adding sharp/libvips native image dependencies to Bun binary; log drop in D89) |

---

### Inert Settings and Duplicates

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| Admin notification emails | Gap | `app.notify_emails` in `src/settings/defaults.ts:22`, rendered in `src/admin/views/settings.tsx:214`. Templates exist at `src/templates/builtins/campaign-status.txt` and `import-status.txt` (`src/templates/builtins.ts:37-38`), but nothing calls them when campaigns finish/cancel/pause on `app.max_send_errors` (`src/campaigns/runner/runner.ts:604-608`) or imports finish/fail | Task (implement admin notification mails and turn input into live field on General settings, task B38) |
| Postback HTTP messengers | Duplicate / Inert | `src/settings/defaults.ts:120`, rendered in disabled `<Unavailable>` settings UI tab `src/admin/views/settings.tsx:978-995` (tab entry `:1066`). Postback messengers were dropped in D89/01-scope; no code runs them | Task (remove inert "Messengers" tab from Settings UI, task B40; round-trip preserved for D57) |
| S3 media storage settings | Inert Settings | 10 settings in `src/settings/defaults.ts:70-79` (`upload.s3.*`), rendered in disabled `<Unavailable>` card with `upload.provider` and 9 fields in `src/admin/views/settings.tsx:588-608`. S3 was dropped in D89; `POST /api/media` rejects `upload.provider: s3` with 400 (`src/openapi/differences.ts:605`) | Task (remove S3 card and `upload.provider` from Settings UI, task B40; retain in defaults for listmonk API round-trip compatibility only; log drop in D89) |
| Update checks setting | Inert Setting | `app.check_updates` in `src/settings/defaults.ts:21`, rendered as a disabled switch in `src/admin/views/settings.tsx:216`. Dropped in D44/01-scope (no update checks against GitHub) | Task (remove switch from Settings UI, task B40; stays false/inert for listmonk API compatibility) |
| SMTP Retries and Retry delay | Inert UI Controls | `smtp[].max_msg_retries` and `msg_retry_delay` in `src/admin/views/settings.tsx:826-842`, validated in `src/settings/validate.ts:32-33`. Nothing reads them; actual retries are fixed in code (transactional only, `attempts < 5` in `src/messaging/sends.ts:312`; marketing sends are never retried) | Task (remove inert inputs from SMTP settings modal, task B40; keep round-tripping through `/api/settings` for D57) |
| OIDC authentication settings | Inert Settings | 11 settings in `src/settings/defaults.ts:50-61` (`security.oidc.*`). OIDC login was deferred/dropped (D89). No OIDC routes exist and correctly not rendered in UI | Keep inert in defaults for listmonk API round-trip compatibility; log drop in D89 |
| Database vacuum cron settings | Inert Settings | `maintenance.db.vacuum` and `maintenance.db.vacuum_cron_interval` in `src/settings/defaults.ts:179-182`. SQLite does not run vacuum cron loops; correctly not rendered in UI | Keep inert in defaults for listmonk API round-trip compatibility; log drop in D89 |
| Inert bounce provider settings | Inert Settings | `bounce.azure`, `bounce.sendgrid_*`, `bounce.postmark`, `bounce.forwardemail`, `bounce.lettermint`, `bounce.mailboxes` in `src/settings/defaults.ts:140-174`. B35 already removed them from the UI; Amazon SES is the only provider (D89) | Keep inert in defaults for listmonk API compatibility; log drop in D89 |
| Basic Auth vs Token Auth | Duplicate (API Auth) | `src/users/auth.ts:57-76` (`parseAuthorization`) supports both `Authorization: Basic <base64>` and `Authorization: token <user>:<key>` | Stays (required by listmonk API compatibility, D57) |
| Campaign `messenger` vs SMTP `from_addresses` routing | Two ways (SMTP routing) | Campaign `messenger` (a named SMTP server, `src/main.ts:440-445`) vs `smtp[].from_addresses` routing (`src/messaging/email.ts:615-621`). Both are upstream behavior (D57). Transactional mail accepts only `email` (`src/tx/routes.ts:473`), so tx can only use from-address routing | Stays (upstream compatibility D57) |
| `POST /api/public/subscription` (JSON) vs `POST /subscription/form` (form POST) | Two ways (Public subscription) | JSON API endpoint `src/public/routes.tsx:175` vs HTML form post `src/public/routes.tsx:267`. Both upstream (D57) | Stays (upstream compatibility D57) |
| Automatic opt-in mail vs opt-in campaigns | Two ways (Opt-in email) | Automatic opt-in on signup (`src/public/mail.ts:132-150`, `src/subscribers/routes.ts:202-203`) vs opt-in campaigns (`src/campaigns/routes.ts:487`, `src/campaigns/optin.ts:11`) | Stays (different jobs: confirming each individual signup vs re-confirming subscribers in bulk) |
| Manual `POST /api/bounces` vs SES webhook | Two ways (Bounce ingestion) | Manual bounce webhook `src/bounces/routes.ts:260-273` (`/webhooks/bounce`) vs SES SNS webhook `src/bounces/routes.ts:364` (`/webhooks/service/ses`) | Stays (upstream behavior; manual path is still useful for recording a bounce by hand) |
| Web UI editor vs MCP endpoint | Two ways (Templates) | Squire / CodeMirror in `src/admin/views/template.tsx` vs 14 MCP tools in `src/mcp/tools.ts` (D91) | Stays (intentional design: browser UI for human operators, MCP for AI agents, D89/D91) |

---

## 2. Proposed Tasks

Proposed tasks, in priority order:

1. **B37** Shared send-rate cap for SES: one process-wide per-second limiter that the campaign runner and the outbox (tx and sequence sends) both wait on before an SMTP push, configured as one setting sized to SES's maximum send rate; measurements in `docs/perf/` (modules `src/messaging/email.ts` or `outbox.ts`, `src/campaigns/runner`, `src/settings`, settings UI; size M)
2. **B38** Admin notification mails: send the ported `campaign-status` mail to `app.notify_emails` when a campaign finishes, is cancelled, or pauses on `app.max_send_errors`, and the `import-status` mail when an import finishes or fails; turn the input into a live field on General settings (modules `src/campaigns/runner`, `src/subscribers/import`, `src/templates/builtins`, `src/messaging`, `src/main.ts`, `src/admin/views/settings.tsx`; size M)
3. **B39** MCP completeness for D89: add `create_campaign` (POST `/api/campaigns`), `list_lists` (GET `/api/lists`), `list_media` (GET `/api/media`), and read-only `list_sequences`/`get_sequence`; update D91 and the tests (modules `src/mcp`, `test/mcp`; size S/M)
4. **B40** Settings UI: remove dropped and inert controls: the S3 card with `upload.provider`, the Messengers tab, the `app.check_updates` switch, and the SMTP `max_msg_retries`/`msg_retry_delay` inputs; all values keep round-tripping through `/api/settings` (D57) (modules `src/admin/views/settings.tsx`, `assets/admin/js/views/settings.js`, `i18n/en.json`, `test/e2e/specs/settings.e2e.js`; size S)
5. **B41** Deliverability docs: SES Easy DKIM as the one way to sign, with in-app `smtp[].dkim` as API-only compatibility, plus SPF via a custom MAIL FROM domain and DMARC alignment and policy; fix the sentence cut at the end of "SMTP and DKIM"; mark the configuration set as already documented (module `docs/operations.md`; size S)

---

## 3. Drops

Drops to log in D89:

- **A/B subject testing**: a non-goal in `01-scope.md`, and a typical project doesn't need it.
- **Thumbnails**: `thumb` is the original image; no native image dependency in the binary.
- **Admin audit log**: single-owner instance; backups and `/api/logs` are enough.
- **Prometheus `/metrics`**: `/health`, `/api/health` and `/api/logs` are enough.
- **Runtime for inert compatibility settings (S3, OIDC, `maintenance.db`, non-SES bounce keys, `app.check_updates`, SMTP retry fields)**: stored and round-tripped for D57 only, with no reader and no UI after B40.
- **DKIM UI**: SES Easy DKIM is the one way; API-only `smtp[].dkim` stays for D57.
- **Delivered, opened and clicked webhooks**: SMTP acceptance is not delivery, SES Delivery events are refused by design, and opens and clicks are in the analytics API. `send.failed` and `bounce.recorded` (including complaints) cover consent sync.
- **Dynamic segment targeting on campaigns**: the query-to-list bulk action (`PUT /api/subscribers/query/lists`) is the one way, as upstream.
- **Runtime DNS checks of sending domains**: SES verifies identities; syntax checks are enough (D50).
- **Archive/RSS and unique and list analytics**: **keep** (confirmed v1), not drops.
