# Completeness audit (D89)

An end-to-end completeness audit of iglo.email against the needs of typical **newsletter**, **lifecycle (sequences)**, and **transactional** email projects, following the owner direction in [D89](09-decisions.md#d89-narrow-complete-product-scope-owner-2026-11-07): "feature complete but not wide: everything a typical project needs, with one way to do each thing."

Every "present" claim is verified against code and public endpoints with file:line citations. Every "gap" names what was looked for and where. Every duplicate identifies whether it stays (e.g. required for listmonk API compatibility under D57) or should be removed.

---

## 1. Inventory and Checklist

### Audience

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| CSV import | Present | `src/subscribers/import/routes.ts:162` (`POST /api/import/subscribers`), `src/subscribers/import/importer.ts:161` (`start`), `src/admin/views/import.tsx:1` | Keep (v1 core) |
| ZIP import | Duplicate / Dropped | `src/subscribers/import/routes.ts:120` explicitly throws 400 "Only a CSV file can be imported: ZIP files are not supported." | Drop (CSV is the one way, D89) |
| Subscriber export | Present | `src/subscribers/query-routes.ts:490` (`GET /api/subscribers/export`), `src/subscribers/export.ts:1-60` | Keep |
| Segments / SQL queries | Present | `src/subscribers/query-routes.ts:489` (`GET /api/subscribers?query=`), `src/subscribers/query.ts:1`, isolated query runner in `src/subscribers/query-runner.ts:24` | Keep |
| Query bulk actions | Present | `src/subscribers/query-routes.ts:491-508` (`POST /api/subscribers/query/delete`, `PUT /api/subscribers/query/blocklist`, `PUT /api/subscribers/query/lists`) | Keep |
| Custom attributes | Present | `attribs` JSON column in `src/subscribers/store.sql:5`, validated in `src/subscribers/input.ts:110` (`validAttributes`), stored in `src/subscribers/store.ts:98` | Keep |
| Double opt-in confirmation | Present | `src/public/routes.tsx:320-394` (`POST /subscription/optin/:subUUID`), `src/public/mail.ts:107` (`optin`), `src/subscribers/routes.ts:320` (`POST /api/subscribers/:id/optin`) | Keep |
| Preference centre (manage lists) | Present | `src/public/preferences.tsx:1-120`, `src/public/routes.tsx:406-476` (`GET/POST /subscription/:campUUID/:subUUID`), `src/campaigns/public.tsx:92-180` | Keep |
| Unsubscribe (one-click RFC 8058) | Present | Campaign: `src/unsubscribe/routes.ts:100` (`POST /subscription/:campUUID/:subUUID/unsubscribe`); Transactional: `src/unsubscribe/routes.ts:182` (`POST /m/:sendUUID/unsubscribe/:subUUID`); Header: `src/messaging/email.ts:258-261` (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) | Keep |
| Blocklist / Suppression | Present | `src/subscribers/routes.ts:436` (`PUT /api/subscribers/:id/blocklist`), line 444 (`PUT /api/subscribers/blocklist`), domain blocklist `src/messaging/sends.ts:27` (`addressBlocklisted`), `privacy.domain_blocklist` | Keep |
| GDPR export and wipe | Present | Export: `src/subscribers/routes.ts:382` (`GET /api/subscribers/:id/export`), `src/public/routes.tsx:481` (`POST /subscription/export/:subUUID`). Wipe: `src/public/routes.tsx:507` (`POST /subscription/wipe/:subUUID`), `src/subscribers/routes.ts:429` (`DELETE /api/subscribers/:id?wipe=true`), anonymizer in `src/messaging/anonymize.ts:1` | Keep |
| Subscriber activity history | Present | `src/subscribers/routes.ts:360-364` (`GET /api/subscribers/:id/subscriber-events`, `/enrollments`, `/sends`), `src/subscribers/routes.ts:375` (`GET /api/subscribers/:id/activity`), tracking in `src/analytics/subscriber.ts:1-60` | Keep |
| External ID addressing | Duplicate (URL forms) | Path: `/api/subscribers/external/:external_id` (`src/subscribers/routes.ts:461`); Query: `/api/subscribers/external?external_id=...` (`src/subscribers/routes.ts:461`, D39) | Stays (query form is required because Bun normalizes encoded dot segments `%2E` in URL paths, D39) |

---

### Campaigns

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| Campaign drafts | Present | `status: "draft"` default on creation, `src/campaigns/store.ts:85`, `src/campaigns/routes.ts:251` | Keep |
| Scheduling | Present | `send_at` timestamp field in `src/campaigns/store.ts:91`, evaluated by runner loop in `src/campaigns/runner/runner.ts:153-157` (`isDue`) | Keep |
| Test send | Present | `src/campaigns/routes.ts:333` (`POST /api/campaigns/:id/test`), MCP tool `send_campaign_test` in `src/mcp/tools.ts:236` | Keep |
| A/B subject testing | Gap / Dropped | Explicit non-goal in `docs/design/01-scope.md:23` ("A/B testing"). No schema fields or sample split runner in `src/campaigns/` | Drop (violates D89 one-way simplicity; adds sample-splitting and statistical variance complexity with minimal owner benefit) |
| Pause / Resume / Cancel | Present | `src/campaigns/routes.ts:311` (`PUT /api/campaigns/:id/status`), coordinates runner state transitions between `draft`, `scheduled`, `running`, `paused`, `cancelled`, and `finished` | Keep |
| Throttling / Rate limits | Present | Concurrency and message rate pacing in `src/campaigns/runner/runner.ts:241-285`, sliding window rate limiting via `app.message_sliding_window`, `app.message_sliding_window_rate`, `app.message_sliding_window_duration` | Keep |
| Archive page and RSS | Present | Decided by B36 (previously listed under "Later" in `01-scope.md:36`): fully implemented in `src/public/archive.tsx:164` (`GET /api/public/archive`), line 186 (`GET /archive.xml`), line 221 (`GET /archive`), line 296 (`GET /archive/latest`), line 309 (`GET /archive/:id`) | Keep (confirm v1 feature) |
| Per-campaign analytics | Present | `src/analytics/routes.ts:225` (`GET /api/campaigns/analytics/:type`), SQL aggregation in `src/analytics/queries.sql:1-48`, admin views in `src/admin/views/analytics.tsx:137-326` | Keep |
| Unique vs Total counts | Present | `src/analytics/routes.ts:159-164` (evaluates `params.get("unique") === "true"` and `privacy.individual_tracking`), checkbox in `src/admin/views/analytics.tsx:235` | Keep (confirm v1 feature) |
| Link tracking | Present | `src/unsubscribe/tracking.ts:1-120`, link rewrite in `src/campaigns/render.ts:37`, redirect handler `GET /link/:linkUUID/:campUUID/:subUUID` in `src/unsubscribe/routes.ts:203` | Keep |
| List / Segment targeting | Present | Campaigns target list IDs (`src/campaigns/input.ts:39`, `src/subscribers/campaign-recipients.ts:8-12`). Dynamic segmentation is performed by query bulk actions into lists (`PUT /api/subscribers/query/lists`) | Keep |
| Attachments & Media | Present | `media` array on campaigns (`src/campaigns/input.ts:40`), cached and attached in `src/media/attachments.ts:1` and `src/campaigns/runner/runner.ts:365` | Keep |
| Plain-text alternative | Present | `altbody` field on campaigns (`src/campaigns/input.ts:27`), compiled in `src/campaigns/render.ts:60`, sent as MIME alternative `altBody` in `src/messaging/email.ts:236`, MCP tool `campaign_text` in `src/mcp/tools.ts:221` | Keep |
| Campaign preview | Present | `src/campaigns/routes.ts:326` (`POST /api/campaigns/preview`), MCP tool `preview_campaign` in `src/mcp/tools.ts:202` | Keep |
| Campaign cloning | Present | `src/admin/views/campaigns.tsx:149`, `onClone()` duplicates campaign parameters into a new draft | Keep |

---

### Lifecycle (Sequences)

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| Event ingestion API | Present | `src/events/routes.ts:44` (`POST /api/subscriber-events`), line 64 (`POST /api/subscriber-events/batch`), supports `subscriber_id`, `email`, `external_id`, and `idempotencyKey` (`src/events/input.ts:24`) | Keep |
| Sequence triggers | Present | `trigger_event` column in `src/sequences/store.sql:5`, triggered on matching event ingestion via `exitThenTrigger` in `src/events/store.ts:126-135` | Keep |
| Delays & Steps | Present | `delay_seconds` on steps (`src/sequences/input.ts:27`), due time calculations in `src/sequences/enrollments.ts:67`, recalculated via `POST /api/sequences/:id/steps/:step/reschedule` (`src/sequences/routes.ts:241`) | Keep |
| Exit conditions / Exit events | Present | `exit_events` array on sequence definitions (`src/sequences/input.ts:51`), exits evaluated in `src/sequences/enrollments.ts:175-185` | Keep |
| Send-time step conditions | Present | Evaluated at send time in `src/conditions/evaluate.ts:1`, syntax validated via `POST /api/conditions/validate` (`src/sequences/routes.ts:215`), compiled in `src/conditions/compile.ts:1` | Keep |
| Per-step analytics | Present | `src/analytics/routes.ts:196-201` (`GET /api/sends/analytics?group_by=step`), displayed in `src/admin/views/sequence.tsx` and `sequences.tsx` | Keep |
| Manual & test enrollments | Present | `POST /api/enrollments` with `test: true` or `force: true` (`src/sequences/routes.ts:355-401`) | Keep |
| Enrollment timeline | Present | `GET /api/enrollments/:id/timeline` (`src/sequences/routes.ts:333`), detailed audit trace of steps, conditions, and sends (`src/sequences/timeline.ts:1`) | Keep |

---

### Transactional

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| API send with template + data | Present | `src/tx/routes.ts:327` (`POST /api/tx`), accepts `{ subscriber_email, template_id, data, headers, attachments, ... }` | Keep |
| Idempotency key | Present | `idempotencyKey` field in `src/tx/input.ts:33`, deduplicated in `src/messaging/sends.ts:140-160` | Keep |
| Delivery status lookup | Present | `src/messaging/routes.ts:58` (`GET /api/sends/:id`), line 13 (`GET /api/sends`), returns delivery status (`queued`, `sending`, `sent`, `failed`, `skipped`) and Message-ID | Keep |
| Transactional attachments | Present | Base64-decoded attachments in `src/tx/input.ts:10-14, 35`, attachment budget checks in `src/tx/routes.ts:125` | Keep |
| Per-message events (webhooks out) | Present (Narrow) | `src/webhooks/store.ts:9-15` emits `send.failed` and `bounce.recorded`. Does NOT emit `send.delivered` or open/click webhook events | Keep current scope (SMTP acceptance is not inbox delivery; SES SNS handles bounces/complaints) |

---

### Deliverability

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| DKIM signing | Present (Config) / Gap (Admin UI) | Supported via nodemailer in `src/messaging/email.ts:21` and D50 (`smtp[i].dkim = { domain_name, key_selector, private_key }`), documented in `docs/operations.md:241`. But `src/admin/views/settings.tsx` has NO UI input fields for DKIM | Task (add UI guidance or fields in settings modal) |
| SPF / DMARC guidance | Gap | Absent from `docs/operations.md` and admin UI | Task (add documentation in `docs/operations.md`) |
| SES configuration set | Present (Headers) / Gap (Field) | Operators can supply `X-SES-CONFIGURATION-SET` header in campaign headers (`src/campaigns/input.ts:30`), tx headers (`src/tx/input.ts:26`), or SMTP default headers (`src/settings/defaults.ts:97`). No dedicated setting | Task (document `X-SES-CONFIGURATION-SET` header in `docs/operations.md`) |
| Bounce & complaint handling | Present | `src/bounces/routes.ts:114` (`POST /api/bounces/ses`), `src/bounces/ses.ts:1-338`, verified via SNS certificate and `bounce.ses_topic_arns` allowlist | Keep |
| Threshold actions | Present | `bounce.actions` in `src/settings/defaults.ts:123-136`, executed in `src/bounces/store.ts:180-220` (soft count, hard count, complaint count -> blocklist/unsubscribe/delete) | Keep |
| Sending domain checks | Present (Syntax) / Dropped (DNS) | `src/settings/mail.ts:1-60` validates email syntax and domain format; D50 explicitly establishes "No DNS lookup or DNS-verification claim" to avoid network calls during transactions | Drop runtime DNS checks (syntax validation suffices) |
| List-Unsubscribe header | Present | `src/messaging/email.ts:258-261` and `src/tx/routes.ts:439-445`, controlled by `privacy.unsubscribe_header` | Keep |
| RFC 5322 Message-ID | Present | Generated in `src/messaging/email.ts:245`, saved to `sends.message_id` and tracked on bounce | Keep |

---

### Operations

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| Users, Roles & API keys | Present | `src/users/store.ts`, `src/roles/roles.ts`, `src/users/auth.ts:1-300`, TOTP in `src/users/totp.ts:1` | Keep |
| Administrative audit log | Gap | No administrative audit logging in `src/` for user actions (creation, deletion, role changes, settings changes). Only application error log buffer exists (`src/maintenance/log-buffer.ts`) | Drop (for a single-tenant instance with 1-2 admins, an audit log engine exceeds D89 scope; error buffer and database backups suffice) |
| Backup & restore hold | Present | CLI command `iglo.email backup` (`src/backup/cli.ts:1`), `restoreHold` in `src/settings/hold.ts:1` (D67) | Keep |
| Upgrade path | Present | Automatic SQLite migrations in `src/db/migrations.ts:1-150` run on startup (`src/main.ts:179`) | Keep |
| Health check | Present | Unauthenticated `GET /health` (`src/server/server.ts:12`), Authenticated `GET /api/health` (`src/users/routes.ts:30`) | Keep |
| Metrics / Logging | Present (Logs) / Gap (Metrics) | Logging: `GET /api/logs` (`src/maintenance/routes.ts:251`, 100-line safe buffer in `src/maintenance/log-buffer.ts`). Metrics: No Prometheus `/metrics` endpoint | Drop Prometheus metrics (container stats and `/health` suffice; D89: feature complete but not wide) |
| Public rate limits | Present | `src/public/rate-limit.ts:1`, configured via `security.public_rate_limit` (subscribe, optin, unsubscribe, privacy) | Keep |
| Signed webhooks out | Present | `src/webhooks/delivery.ts:1-250`, HMAC SHA-256 signatures with retry backoff | Keep |
| Settings UI | Present | `src/admin/views/settings.tsx:1-1100`, mounted at `/admin/settings` | Keep |
| Docker image | Present | `Dockerfile:1-55`, official multi-arch Docker image (amd64, arm64) built in `.github/workflows/release.yml` wrapping compiled binary (D89) | Keep |
| MCP endpoint | Present | `POST /api/mcp`, 14 tools (`src/mcp/routes.ts:1`, `src/mcp/tools.ts:1-656`, D91) | Keep |

---

### Templates

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| Campaign, Tx & Archive templates | Present | `src/templates/store.ts:16` (`type: "campaign" | "tx"`), archive template seeded in migration 0001 and rendered in `src/public/archive.tsx:104` | Keep |
| Template preview | Present | `src/templates/routes.ts:182` (`POST /api/templates/:id/preview`), `src/mcp/tools.ts:105` | Keep |
| Liquid reference guide | Present | `docs/design/06-templates.md`, `src/mcp/reference.ts:1-247`, MCP tool `template_reference` in `src/mcp/tools.ts:263` | Keep |
| Media library | Present | `src/media/store.ts:1-120`, `src/media/routes.ts:1-280`, filesystem storage in `src/media/filesystem.ts:1-180`, admin view `src/admin/views/media.tsx:1-150` | Keep |
| Thumbnail generation | Gap / Dropped | Deferred in `docs/design/01-scope.md:40` ("thumbnails (B36 decides)"); `src/media/routes.ts:5, 203` points `thumb` directly to the uploaded file itself | Drop (formalize drop in D89; avoids adding sharp/libvips native dependencies to Bun binary) |

---

### Inert Settings and Duplicates

| Item | Status | Evidence (file:line or route) | Recommendation |
|---|---|---|---|
| Postback HTTP messengers | Duplicate / Inert | `src/settings/defaults.ts:120`, rendered in settings UI tab `src/admin/views/settings.tsx:980-1066`. Postback messengers were dropped in D89/01-scope; no code runs them | Task (remove inert "Messengers" tab from Settings UI) |
| S3 media storage settings | Inert Settings | 10 settings in `src/settings/defaults.ts:70-79` (`upload.s3.*`). S3 was dropped in D89; `POST /api/media` rejects `upload.provider: s3` with 400 (`src/openapi/differences.ts:605`) | Keep inert in defaults for listmonk API round-trip compatibility only; log drop in D89 |
| OIDC authentication settings | Inert Settings | 11 settings in `src/settings/defaults.ts:50-61` (`security.oidc.*`). OIDC login was deferred/dropped (D89). No OIDC routes exist | Keep inert in defaults for listmonk API round-trip compatibility; log drop in D89 |
| Database vacuum cron settings | Inert Settings | `maintenance.db.vacuum` and `maintenance.db.vacuum_cron_interval` in `src/settings/defaults.ts:179-182`. SQLite does not run vacuum cron loops; comments in `src/admin/views/maintenance.tsx:3` note it is inert | Keep inert in defaults for listmonk API round-trip compatibility; log drop in D89 |
| Notification emails setting | Inert Setting | `app.notify_emails` in `src/settings/defaults.ts:22`, rendered in `src/admin/views/settings.tsx:214`. No notifications are ever sent to these addresses | Task (remove unread input from General Settings) |
| Inert bounce provider settings | Inert Settings | `bounce.azure`, `bounce.sendgrid_*`, `bounce.postmark`, `bounce.forwardemail`, `bounce.lettermint`, `bounce.mailboxes` in `src/settings/defaults.ts:140-174`. B35 already hid them from the UI; Amazon SES is the only provider (D89) | Keep inert in defaults for listmonk API compatibility; log drop in D89 |
| Update checks setting | Inert Setting | `app.check_updates` in `src/settings/defaults.ts:21`. Dropped in D44/01-scope (no update checks against GitHub) | Stays false/inert for listmonk API compatibility |
| Basic Auth vs Token Auth | Duplicate (API Auth) | `src/users/auth.ts:124-150` supports both `Authorization: Basic <base64>` and `Authorization: token <user>:<key>` | Stays (required by listmonk API compatibility, D57) |
| Web UI editor vs MCP endpoint | Two ways (Templates) | Squire / CodeMirror in `src/admin/views/template.tsx` vs 14 MCP tools in `src/mcp/tools.ts` (D91) | Stays (intentional design: browser UI for human operators, MCP for AI agents, D89/D91) |

---

## 2. Proposed Tasks

In priority order, ready to paste into the work queue in `docs/status.md`:

1. **B37** Deliverability documentation: document Amazon SES setup, SPF DNS records, DKIM (Easy-DKIM & custom keys via D50), DMARC policy, and `X-SES-CONFIGURATION-SET` header in `docs/operations.md`. Touches `docs/operations.md`. Size: S.
2. **B38** Remove inert Messengers tab from Settings UI: remove the unused postback HTTP messenger editor from `src/admin/views/settings.tsx:980` (postback messengers were dropped in D89 and no code runs them). Touches `src/admin/views/settings.tsx`. Size: S.
3. **B39** SMTP DKIM guidance in Admin UI: add clear DKIM guidance and documentation link to the SMTP server edit dialog in `src/admin/views/settings.tsx` explaining how DKIM is handled via SES Easy-DKIM or custom RSA keys in settings. Touches `src/admin/views/settings.tsx`. Size: S.
4. **B40** Hide unread `app.notify_emails` from General Settings: remove the inert "Notification emails" input in `src/admin/views/settings.tsx:214` since the server sends no campaign completion notification emails. Touches `src/admin/views/settings.tsx`. Size: S.

---

## 3. Drops

Ready to log in `docs/design/09-decisions.md` under D89:

- **Campaign archive and RSS feed**: Decided **KEEP** in v1. Fully implemented and verified in `src/public/archive.tsx:164-324` (`/archive`, `/archive.xml`, `/archive/latest`, `/archive/:id`). Formally confirmed for v1 scope.
- **Unique-count and list analytics**: Decided **KEEP** in v1. Fully implemented and verified in `src/analytics/routes.ts:121-175, 224-229` and `src/admin/views/analytics.tsx:137-326`. Formally confirmed for v1 scope.
- **Thumbnails generation**: Decided **DROP**. The current implementation points `thumb` directly to the uploaded file itself (`src/media/routes.ts:5, 203`), avoiding heavy native C/C++ image-processing dependencies (sharp/libvips) in the compiled Bun binary; modern browsers scale images for admin previews efficiently.
- **A/B subject testing**: Decided **DROP**. Contradicts D89 single-path philosophy; sample-splitting and statistical variance engines add significant complexity with minimal owner benefit.
- **Administrative audit log**: Decided **DROP**. Point-in-time database snapshots (`iglo.email backup`) and the application error log buffer (`/api/logs`) provide adequate operational history for a self-hosted single-tenant instance without an enterprise audit engine.
- **Prometheus metrics endpoint**: Decided **DROP**. Container metrics (`docker stats`), process VmRSS watchdogs, and health checks (`/health`, `/api/health`) provide sufficient observability without introducing a Prometheus metrics server or scraping library.
- **Inert compatibility settings (S3, OIDC, Vacuum Cron, Inert Bounce Providers)**: Decided **DROP from runtime execution**. `upload.s3.*` (10 settings), `security.oidc.*` (11 settings), `maintenance.db.*` (2 settings), and inert bounce providers (`bounce.azure`, `sendgrid`, `postmark`, `forwardemail`, `lettermint`, `mailboxes`) have zero readers in application logic; retained in `src/settings/defaults.ts` only for listmonk API round-trip compatibility.
