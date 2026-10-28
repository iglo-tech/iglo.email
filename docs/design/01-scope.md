# Scope

## Goals

1. **Replace listmonk for the owner's products** with the same core behavior: subscribers, lists, opt-in, campaigns, templates, transactional email, bounces, tracking.
2. **Add lifecycle email:** apps send events, and iglo.email runs sequences with delays and conditions, re-checked at send time.
3. **Make transactional email safe for marketing use:** unsubscribe links and headers, list status checks, a frequency cap, and a send log with message IDs.
4. **Tell apps what happened:** outbound webhooks for unsubscribes, blocklisting and bounces, so apps can keep consent in sync.
5. **One stack:** Bun, TypeScript, SQLite, one executable, shared conventions with other iglo.\* projects.

## MVP platform

The MVP targets Linux x86-64 only. CI, reference acceptance and the first release artifact use that platform. macOS and Linux arm64 coverage and artifacts move to post-MVP ([D42](09-decisions.md#d42-linux-x86-64-only-for-mvp)).

## Non-goals

- Feature parity with listmonk.
- Postgres or any other database.
- A visual journey builder, lead scoring, CRM features, A/B testing.
- Multi-node or horizontal scaling. One process per instance.
- Tracking upstream listmonk after the baseline. Fixes may be ported by hand when useful.
- A public community project: no support process, no release promise, no community governance files (same stance as iglo.monitor).

## listmonk v7 features

**v1** ships in the first usable release. **Later** is planned but not in v1. **Dropped** will not be built.

| Area | v1 | Later | Dropped |
|---|---|---|---|
| Subscribers | CRUD, attributes (JSON), search, SQL segment queries (SQLite dialect), blocklist, bulk actions, subscriber data export | | |
| Lists | public/private/temporary, single and double opt-in, tags | | |
| Public pages | subscription form, opt-in confirmation, unsubscribe, manage preferences | campaign archive and RSS | |
| Campaigns | regular and opt-in campaigns, scheduling, test sends, pause/resume, throttling and sliding-window rate limits, view and click tracking | | |
| Templates | campaign and transactional templates, rich text (Squire), HTML, Markdown, plain text | visual (drag-and-drop) templates | Go template syntax (replaced by Liquid) |
| Transactional API | `POST /api/tx`, attachments, custom headers | | |
| Media | filesystem storage | S3 storage, thumbnails | |
| Import | CSV import of subscribers | ZIP import, listmonk Postgres importer | |
| Bounces | bounce API, Mailgun webhook, soft/hard/complaint actions | Postmark, SES, SendGrid and other webhooks, POP3 mailbox scanning | |
| Analytics | campaign views, clicks, bounces, link stats, dashboard counts | unique-count graphs, list analytics | |
| Users | admin users, API users and tokens, user roles and list roles, TOTP 2FA | OIDC login | |
| Messengers | SMTP pool, multiple SMTP servers | postback (HTTP) messengers | |
| Security | | CAPTCHA (Altcha) on public forms | |
| i18n | English, with listmonk's language files carried over | other languages verified | |
| Operations | settings UI, maintenance (purge, vacuum), logs view | official Docker image wrapping the executable, after 1.0 | update checks against GitHub, `--install`/`--upgrade` flags (replaced by automatic migrations), listmonk's Docker images and compose files, `config.toml` |

## New in iglo.email (v1)

| Feature | Doc |
|---|---|
| Events API and per-subscriber event history | [Sequences](05-sequences.md) |
| Sequences: triggers, steps, waits, conditions, exit events | [Sequences](05-sequences.md) |
| `external_id` on subscribers, so apps address people by their own user ID | [Data model](03-data-model.md) |
| Unsubscribe links and one-click `List-Unsubscribe` in transactional email | [Sending](04-sending.md) |
| List status check and frequency cap for marketing sends | [Sending](04-sending.md), [Sequences](05-sequences.md) |
| Send log with SMTP message IDs, returned by the transactional API | [Sending](04-sending.md) |
| Outbound webhooks (signed) | [Sending](04-sending.md) |
| Idempotency keys on events and transactional sends | [Sending](04-sending.md), [Sequences](05-sequences.md) |

## First consumer

The first consumer is an existing SaaS app with about a dozen lifecycle emails: purchase confirmation, onboarding, "did the setup work?", monthly summary, dunning, exit survey and win-back. Its needs set the v1 bar. The worked example in [Sequences](05-sequences.md) uses a generic version of it.
