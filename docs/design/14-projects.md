# Projects

**Status: implemented** ([D142](09-decisions.md#d142-one-instance-serves-several-projects-owner-2026-11-23), [D163](09-decisions.md#d163-projects-documentation-pass-and-definition-of-done-b144b-lead-2026-11-25)). Every task in [section 17](#17-tasks) has merged into `main`: B138a (#205, 5c5ca72), B138b (#217, e3761c6), B140 (#218, 57380e8), B139 (#219, 46ba748), B142 (#220, ad28a61), B144a (#221, e7c06f4), B145a (#223, b45b700), B143a (#224, 93498a4), B141 (#225, e9a32cb), B145b (#226, 60373c4), B141a (#227, 94c4b98), B143b (#228, e9a65b8), and B144b, this documentation pass. The other design documents, the README and `operations.md` describe the shipped behaviour; [D15](09-decisions.md#d15-one-instance-per-product) is superseded. [Section 18](#18-definition-of-done-for-the-feature) names the evidence.

This was the implementation spec for the workers and leads of the tasks in [section 17](#17-tasks), and stays the reference for how projects work. Each section's "As built" list is the code; where it and the text above it differ, the list wins.

- Read sections 1–16 before starting any task.
- The invariants in [section 14](#14-invariants) apply to every task. Breaking one is a blocking review finding.
- Where this spec describes today's code, check the code. The code wins, and the spec is fixed in the same PR.
- **listmonk's API is a starting point, not a constraint** ([D143](09-decisions.md#d143-listmonks-api-is-a-starting-point-not-a-constraint-owner-2026-11-23)). Where staying compatible would make a design more complex, change the API, list the difference in 07 with its reason, and update the contract cases.

## Goal

One iglo.email process serves several independent projects (products, newsletters, apps) for one operator. An instance is mostly idle, so one instance per project wastes a server and duplicates the SES setup.

- **One configuration** for the instance: SMTP/SES, the send rate, bounces and security.
- **One send queue** across all projects. It respects the SES account's rate and shares it fairly. Marketing mail may wait up to an hour. Transactional mail does not wait.
- **Plan against the real SES limits.** The app reads the account's rate and 24-hour quota from SES. Scheduling a campaign shows whether it fits, so quota problems are avoided when planning, not handled in the queue.
- **One admin account** that works in every project.
- **API and MCP credentials are scoped to one project.** An AI agent given a token for project A cannot read or change project B.

## Non-goals

These are out of scope. Do not build them, even partly:

- Multi-tenancy for different customers, billing, quotas per customer.
- New human-user features: invitations, per-project roles for humans, ACL screens. Project-local human users stay exactly as today ([section 5](#5-one-admin)). Removing them is a later decision.
- Sharing subscribers, lists, templates or campaigns between projects. Each project's audience and consent stay separate, which was D15's reason for one instance per product.
- Routing projects by path prefix (`/p/<slug>/…`). The UI and pages contain about 600 absolute paths, and listmonk's API contract assumes the root.
- A second sending provider, or SMTP settings per project. All mail goes through the instance's SES configuration.
- Moving subscribers between projects, merging projects, renaming a project's main hostname.
- An upgrade path from earlier iglo.email data directories (owner, 2026-11-23: nothing is live).
- Horizontal scaling. The process model is still one process and one data directory ([D69](09-decisions.md#d69-a-file-lock-enforces-one-process-per-data-directory)).

## Terms

| Term | Meaning |
|---|---|
| Instance | The process and its data directory. It owns the instance database, the instance settings, the admin account and the dispatcher |
| Project | One audience. Its own SQLite database with today's whole schema: subscribers, lists, templates, campaigns, sequences, sends, webhooks, media, users |
| Slug | A project's permanent ID: `[a-z0-9][a-z0-9-]{0,39}`, unique, never changed. It is the directory name |
| Hostname | A project's main host, such as `news.example.com`. It is set at creation, never changed, and used for every new link and Message-ID |
| Extra hostname | Another host that serves the same project, such as an old domain whose links in sent mail must keep working. It is never used for new links |
| Instance host | The host of `--root-url`. It serves the instance pages and, optionally, the primary project |
| Primary project | The project whose hostname is the instance host. At most one. Requests for a host no project claims go to it. A single-project install is an instance with only a primary project, and it behaves exactly as today |
| Admin | The one admin account. It is kept in `instance.db` and copied into every project as a Super Admin user ([section 5](#5-one-admin)) |
| Dispatcher | The instance's send scheduler: one emailer, one rate limiter and fair start slots across projects |
| SES snapshot | The last values read from SES's `GetAccount`, held in memory: maximum send rate, maximum sends in 24 hours, sent in the last 24 hours, and the read time |

## 1. Data layout

```text
data/
  iglo-email.lock          instance lock (D69), unchanged; one for the whole directory
  instance.db              (+ -wal, -shm) projects, hostnames, instance settings, admin account
  projects/
    <slug>/
      iglo-email.db        (+ -wal, -shm) today's schema, unchanged in meaning
      uploads/             media of this project
      stage/               D62 staging of this project
  backups/
    <timestamp>/instance.db, <slug>.db …   `iglo.email backup` output
    pre-migration/…        automatic snapshots before migrations (instance and each project)
    deleted/<slug>-<timestamp>.db          final snapshot of a deleted project
```

- **Migrations:** `instance.db` has its own migration manifest in `migrations/instance/`. Project databases keep `migrations/`. Each manifest is applied to its own databases with the existing runner and the pre-migration snapshot rule.
- **Directories:** the `--data-dir` flag is unchanged. Project directories are always under `projects/` and are never configurable.
- **Pragmas:** a project database is opened with the same pragmas as today ([02-architecture](02-architecture.md#platform)).
- **No upgrade:** start refuses a data directory that has `iglo-email.db` at its root, with a message that the layout changed. Nothing converts old data.

## 2. Routing

- **One server:** one `Bun.serve` on the existing port.
- **Lookup:** each request is dispatched by its `Host` header. Lowercase it, strip the port, then look it up among hostnames and extra hostnames. Ignore `X-Forwarded-Host`: the reverse proxy must pass `Host` through, and `operations.md` says so.
- **Project host:** the project's own router. It holds every route that exists today. The API, admin UI, public pages and MCP keep their current paths and contracts.
- **Instance host:** the instance routes come first:
  - `/admin/instance/**`: the instance pages
  - `/api/instance/**`: JSON for those pages, session only
  - `/webhooks/service/ses`
  - the instance login and handoff paths ([section 5](#5-one-admin))

  Every other path goes to the primary project, if there is one.
- **A host no project claims:**
  - **With a primary project:** the request is handled exactly as on the instance host: instance routes first, then the primary project.
    - Existing tests and fixtures call `127.0.0.1` with a different configured host, including the SES bounce tests, and health checks call by IP. All of them keep working.
    - Routing does not depend on how many projects exist.
    - Such a request reaches only the instance and the primary project, so isolation holds.
  - **Without a primary project:**
    - the instance health route answers on any host
    - `/admin` redirects to the instance host's `/admin/instance/projects`
    - everything else gets a plain-text `404` that names no project and no hostname, with no log line per request
- **Root URL:**
  - A project's `app.root_url` is `--root-url` with its host replaced by the project's hostname. Scheme, port and path are kept.
  - It stays read-only, as under D14.
  - All links, Message-IDs (`rootDomain`), cookies, CORS and Origin checks of a project derive from it, as they do today from the bootstrap root URL.
- **Routing table:** held by the instance object passed to the server, not by module-level state. A project created or deleted while running updates it without a restart.

## 3. Instance store and composition

- **New module `src/projects/`.** It owns `instance.db`'s registry tables:
  - projects: slug, name, created time, primary flag
  - hostnames: hostname, project, main or extra
- **Other instance tables belong to their modules.** Settings owns the instance settings table and users owns the admin account. "A module owns its tables" still holds across both kinds of database.
- **`createProject(instance, slug)`** replaces today's wiring in `src/main.ts`.
  - It receives the instance services: dispatcher, instance settings reader, admin sync, clock, logger and process-wide budgets.
  - It opens the project's database and wires every store, route and loop exactly as `main()` does now.
  - It returns `{ router, start(), stop(), db, … }`.
  - `main()` opens the instance, then calls `createProject` for each registered project.
  - All projects are wired before the port binds, and loops start only after it binds, as [B52](../briefs/B52.md) requires.
- **No shared database handles.** A project's modules see only that project's database. Instance services are passed in as narrow functions, never as the instance `Database`.
- **No SQLite transaction across two database files.** There is no `ATTACH`. Each step that writes two databases states its order and why a crash between the two writes is safe.

### As built (B138b)

[D151](09-decisions.md#d151-instance-layout-routing-and-shared-budgets-b138b-lead-2026-11-24) records the choices this spec left open. Where this list and the sections above differ, this list is the code.

- **Modules.** `src/projects/layout.ts` (paths, the earlier-layout check and its message), `registry.ts` (the `projects` and `hostnames` tables, slug and hostname rules), `instance.ts` (`openInstance`: instance.db, wiring every project, the routing table, `add` and `remove` at runtime, the no-primary answers), `budgets.ts` (the process-wide budgets), `logger.ts` (prefixed stderr lines) and `compose.ts` (`createProject(services, options)`). `src/server/server.ts` has the routing seam, `serveRouted(listen, dispatch)`.
- **`createProject(services, options)`.** Services: the clock, the shared budgets, and the listen address (only `App.bootstrap` carries it). Options: slug, directory, root URL, where its pre-migration snapshot goes, and its seed (the first admin, and for the primary project the first API user). No host, port or other instance configuration.
- **Fresh install.** With an empty registry and nothing under `projects/` but possibly `main/`, the instance registers the primary project `main`, named after the site name default, on the instance host. An existing `projects/main/` is used as it is (a restore, or a first start that stopped before its row).
- **The primary's main hostname follows `--root-url`.** At each start it is set to the instance host. A non-primary project may not hold the instance host.
- **Seeds.** `IGLO_EMAIL_ADMIN_*` creates the admin account, which B140 copies into every project ([section 5, "As built"](#as-built-b140)). `IGLO_EMAIL_API_*` seeds the primary project only: an API credential belongs to one project.
- **Routing.** `Host`, lowercased and without its port; a missing or unparsable `Host` is an unclaimed host. Without a primary: `GET /health` answers the instance's health; `/admin` and every `/admin/…` path except `/admin/instance/…` answer `302` to `--root-url` + `/admin/instance/projects`; anything else is `404` with the body `404 page not found\n`, `text/plain`.
- **Instance health.** `200 {"data":true}` while no project's loops have failed, else `503`. A loop failure still stops the whole process, as one install did.
- **Runtime add and remove.** `add` validates, wires the project (creating its directory and database), writes the registry rows last, then serves and starts it. A failure before the rows removes the new directory. `remove` takes the project off the routing table, stops and closes it, then deletes its rows; its directory stays (the final snapshot and removal are B143's). B143a serializes both, drains requests before the close and archives the directory ([section 10, "As built"](#as-built-b143a)).
- **Budgets (invariant 7).** One rate-limit table per public limit kind (subscribe, opt-in, privacy, unsubscribe, bounce webhooks), with each project's peers keyed by its slug inside the one 10,000-peer bound; one ALTCHA key and replay table; one pair of subscriber-query children, which every project's own runner takes after its own and frees when the child exits; one pair of analytics children, which every project's reader acquires before its own; one analytics egress budget (64 MiB of finished responses for the process); one tx attachment byte gate. The send rate limiter, per project in B138b, became the one dispatcher in B141 ([section 7, "As built"](#as-built-b141)).
- **Logs.** Each project keeps its own buffer for `GET /api/logs`; every stderr line starts with `[<slug>] ` or `[instance] `. The instance buffer and its Logs page are B143a's ([section 13, "As built"](#as-built-b143a-1)).
- **CLI.** `backup` and `backup --release-hold` acted on the primary project under the one lock until B144a; since then they act on `instance.db` and every project, or one project with `--project` ([section 12, "As built"](#as-built-b144a)). `reset-password` and `reset-totp` act on the admin account and every copy for the admin's name, and on the primary project's user for any other (B140).
- **Two databases.** Two steps write both. Runtime `add` writes the project's database first, then its registry row: a crash between leaves a directory with no row, reported at start and never served. The fresh install writes the primary's row first, then its database: a crash between leaves a row whose project is created at the next start, and a crash before the row leaves at most `projects/main/`, which the next start adopts.

## 4. Settings: instance and project

**Rule:**

- **Instance key:** the key describes the server, the SES account, sending capacity or the operator.
- **Project key:** the key describes an audience, a brand, consent, content or public pages.

A new key must be classified in this table when it is added.

**Removed:** `app.concurrency`, `app.message_rate`, `app.batch_size` and `app.message_sliding_window*`.
- The dispatcher paces all sending ([section 7](#7-global-send-queue)), so a second, per-campaign pacing layer only adds rules that can conflict with it.
- How many recipients a campaign claims at once comes from its grant, capped by a fixed internal maximum. The B141 worker measures it and picks it, starting at 100.

| Instance | Project |
|---|---|
| `smtp` (all servers, DKIM, test pools) | `app.root_url` (read-only, derived from the hostname) |
| `messaging.max_send_rate` | `app.site_name`, `app.site_url`, `app.favicon_url`, `app.logo_url`, `app.from_email` |
| `ses.api_region`, `ses.api_access_key_id`, `ses.api_secret_access_key` (new; the secret is masked, [section 7](#ses-account-and-capacity-planning)) | `app.max_send_errors` |
| `bounce.enabled`, `bounce.webhooks_enabled`, `bounce.ses_enabled`, `bounce.ses_topic_arns`, inert provider keys (`bounce.azure`, `bounce.sendgrid_*`, `bounce.postmark`, `bounce.forwardemail`, `bounce.lettermint`, `bounce.mailboxes`) | `bounce.actions` |
| `security.trusted_proxies`, `security.session_duration`, `security.oidc` | `security.captcha`, `security.trusted_urls`, `security.public_rate_limit` |
| `app.check_updates`, `app.cache_slow_queries`, `app.cache_slow_queries_interval`, `maintenance.db` | `app.enable_public_archive`, `app.enable_public_subscription_page`, `app.show_optin_page`, `app.enable_public_archive_rss_content`, `app.send_optin_confirmation`, `app.notify_emails`, `app.lang` |
| `webhooks.block_private_addresses`, `sources.private_hosts` (B150a) | `privacy.*`, `marketing.min_interval`, `source.*` (B150a: the external source, [15-external-sources](15-external-sources.md#2-settings-project-keys)) |
| `upload.provider`, `upload.s3.*` (inert), `appearance.admin.custom_css`, `appearance.admin.custom_js` | `upload.extensions`, `upload.filesystem.*` (paths resolve inside the project directory), `appearance.brand.*`, `appearance.public.*` |

**API:**

- **Project host:** `GET` and `PUT /api/settings` read and write project keys only.
  - A key that is not a project key, including any instance key, is a `400` that names it, and nothing is written.
  - `app.root_url` stays read-only, as in D14 today.
- **Instance host:** `GET` and `PUT /api/instance/settings` read and write instance keys only, with an instance session and CSRF. Secrets are masked as today.
- **No merging:** there is no merged object, no rule for unchanged instance keys and no write order across two databases. Each request writes one database.

**Admin UI:**

- A project's Settings page shows only project keys, with a link to "Instance settings" on the instance host.
- The instance Settings page shows only instance keys.

### As built (B139)

[D154](09-decisions.md#d154-settings-split-b139-lead-2026-11-25) records the choices this section left open. Where this list and the text above differ, this list is the code.

- **Modules.** `src/settings/keys.ts` gives every default key its side (a key without one does not compile); `src/settings/instance.ts` is the instance store over instance.db's `settings` table (migration `instance/0003`) and hands out the one reader every project gets; `createSettings` in `store.ts` takes that reader, stores the project keys and reads both sides; `routes.ts` serves the same bodies and rules for both APIs; the views are one `settingsPage(side)`. Migration 33 removes every instance key from a project database (`restore.hold` stays).
- **Classification.** The table above, plus `messengers` (inert, beside SMTP) as an instance key. The campaign pacing keys (`app.concurrency`, `app.message_rate`, `app.batch_size`, `app.message_sliding_window*`) were instance keys until B141 removed them.
- **Reads and changes.** A project's settings read is its project rows and the instance's keys together, re-read on each call as before (D88), so an instance change is seen by the next read in every project, with no restart, as a change in one install was. The instance store calls each project's settings listener after its commit (the send-rate wake).
- **Project API.** `GET /api/settings` serves the project keys and `app.root_url`. A `PUT /api/settings` or `PUT /api/settings/:key` naming any other key, an instance key or a name that binds no setting, is `400` "Not a project setting: <name>…" after the permission check, with nothing written. `app.root_url` in a full write is ignored; its own key PUT stays the `400` it was.
- **Instance API.** On the instance host and unclaimed hosts: `GET`/`PUT /api/instance/settings`, `PUT /api/instance/settings/:key`, and `POST /api/instance/settings/smtp/test`, which sends through the primary project (its sender, default from address and brand) and is `409` without one. Instance session and CSRF; any `Authorization` header is `401`. A full write keeps the native instance keys a listmonk-shaped body leaves out, as the project API does.
- **SES keys.** `ses.api_region` (an AWS region name), `ses.api_access_key_id` (`AKIA` and 16 capitals or digits) and `ses.api_secret_access_key` (16 to 128 printable characters) are set together or not at all. A blank secret, or the mask a GET served, keeps the stored one (a value that only partly is the mask is a new, refused value); a blank key ID clears it, and the stored region too unless the same save sets another region, so clearing the key ID alone clears all three (B149d, D167). The secret is masked. B145a's SES account reads them ([section 7, "As built (B145a)"](#as-built-b145a)).
- **OIDC.** `security.oidc` is an instance key, and a role ID names one project's role, so the instance checks OIDC role IDs for shape only (positive whole numbers).
- **The instance login** now takes its session length from `security.session_duration` and its client address from `security.trusted_proxies`, as a project's login does.
- **Pages.** `/admin/instance/settings` in the instance layout (Performance, Security, Media, SMTP, Bounces, Amazon SES, Appearance); a project's Settings page keeps General, Performance, Privacy, Security, Media, Bounces (the actions) and Appearance (the public editors), and links to it.
- **Tests.** `test/projects/settings.test.ts` in `contract:projects`. The settings contract and the other corpora reach both sides through `test/contract/settings-split.ts`; against upstream it is plain fetch.

## 5. One admin

The owner works alone. The design keeps today's project authentication untouched, so the user and role contract suites (which also run against upstream) do not change. It adds one account that exists in every project.

- **The admin account lives in `instance.db`:** username, password hash, optional TOTP and email. There is exactly one.
  - `IGLO_EMAIL_ADMIN_USER` and `IGLO_EMAIL_ADMIN_PASSWORD` create it on first start, as today.
  - `iglo.email reset-password` and `reset-totp` act on it.
- **Copied into every project:**
  - Each project database has one user row for the admin: same username, password hash and TOTP, Super Admin role, password login on. The project's users table marks it as the admin's copy.
  - It is written on project creation and on every start, from `instance.db` to each project.
- **Password and TOTP changes write through.** A change can come from any place that changes them today:
  - the project profile and 2FA routes
  - the email password reset (`issueReset` and its completion in `src/users/auth.ts`)
  - the instance Account page
  - the CLI

  Each one writes `instance.db` first, then every project's copy. A crash in between is repaired at the next start, because the instance is the source. So the existing profile, 2FA and reset tests and e2e specs keep passing on the copy.
- **The copy is protected:**
  - Through a project's API or UI it cannot be deleted or disabled, or have its role or username changed. Those return `403` and write nothing.
  - This is the only change to project user behavior.
  - The B140 worker lists every test that touches the bootstrap admin, and confirms that none of them deletes it, disables it or changes its role.
- **Username clash:** the admin's username is reserved in every project.
  - Creating a project user with that name is a `409`.
- **Logging in:**
  - Today's project login on any project host works with the admin's credentials, because the copy is a normal user row.
  - The instance pages have their own login at `/admin/instance/login`, checked against `instance.db`.
    - Its session cookie is `instance_session` with `Path=/`. It has a different name from a project's `session` cookie, so neither replaces the other.
    - Both can exist on the instance host at once.
- **Handoff, so one sign-in is enough:**
  1. On the instance host, with a valid instance session, `GET /admin/instance/open/<slug>?next=<path>` mints a random 32-byte token. It is held in memory, used once, valid for 60 s and bound to the slug.
  2. The instance host answers 303 to `<project root URL>/admin/handoff?token=…&next=…`.
  3. The project redeems the token in-process and creates a normal project session for the admin's copy, through a narrow `createSession(userId)` from the project's users module. It sets today's cookie.
  4. It answers 303 to `next`.

  `next` must be a path that starts with `/` and not `//`. Anything else becomes `/admin`. A spent, expired or foreign token is a `403` with no session.
- **Logout and session expiry** work per host, as today.
- **Other human users** in a project keep working exactly as today. The owner simply does not create any.

### As built (B140)

[D153](09-decisions.md#d153-one-admin-b140-lead-2026-11-24) records the choices this section left open. Where this list and the text above differ, this list is the code.

- **Modules.** The users module owns the account: `src/users/account.ts` (instance.db's `admin_account` and `admin_sessions`, migration `instance/0002`), `instance-auth.ts` (the instance login, session and Account changes), `handoff.ts` (the tokens and the project's `/admin/handoff`), and in `store.ts` the copy (`users.admin_copy`, migration 32): `syncCopy`, its protection, the reserved name and the write-through hook. `src/admin/instance/routes.tsx` has the instance pages and JSON routes; `assets/admin/js/views/instance-account.js` the Account page's script. `src/projects/admin-sync.ts` writes a change to instance.db, then every other project; `admin-recovery.ts` is the CLI's admin path. `createProject` takes the admin as an instance service (`account`, `changed`, `redeem`) and exports `syncAdmin`.
- **No account** without the variables on a start with none: the instance login refuses everyone, and projects behave as before.
- **Copies** are written at each wiring; a row with the admin's name and no mark is adopted. Name and email stay the project's.
- **Write-through:** instance.db, then every other copy, then the source's own commit; a crash is repaired at the next start.
- **Protection** answers after the last-admin rule: `403` for a change to username, status, type, user or list role or password login, and for a delete naming the copy. Its password and email are changed only by the copy itself (its own session, or completing a reset token issued to it), the instance Account page or the CLI; another user or any API user gets `403`, nothing written, so a credential scoped to one project never reaches the instance or another project. The email is compared without case: another user's edit that sends the copy's own address in any case keeps the stored address as it is and changes the other fields (B149d, D167). The reserved name is `409`.
- **Instance routes** on the instance host and on unclaimed hosts: `/admin/instance` (to Account), `/admin/instance/login`, `/admin/instance/login/twofa`, `/admin/instance/account`, `/admin/instance/open/<slug>`, and `/api/instance/account`, `/api/instance/account/password`, `/api/instance/account/totp`, `/api/instance/account/twofa`, `/api/instance/logout`. Any `Authorization` header is `401`.
- **Cookies** `instance_session`, `instance_csrf` and `instance_nonce`, with the project cookies' attributes; the instance session lasted the default 7 days until B139, and since then follows `security.session_duration` ([section 4, "As built"](#as-built-b139)).
- **Handoff:** `GET /admin/instance/open/<slug>?next=` answers `303` to `<project root URL>/admin/handoff?token=…&next=…`; the project answers `303` to `next` with today's cookies, or `403`.
- **CLI:** `reset-password` and `reset-totp` with the admin's name write instance.db and every copy under the one lock; any other name is the primary project's user.
- **Tests:** `bun run contract:projects` runs `test/projects`: B138b's isolation and instance tests, the admin cases (`admin.test.ts`, compiled executable) and the handoff expiry on an injected clock (`handoff.test.ts`).

## 6. API and MCP scoping

- **API users are project users.** They live in the project database and are created on that project's Users page with today's roles. A role can still restrict a user to some lists.
- **A credential is checked only against the database of the project its request reaches.**
  - The same `user:token` sent to another project's host is a `401`, even when a user of that name exists there.
  - On the instance host or an unclaimed host, it reaches only the primary project.
  - Instance routes never accept API credentials.
- **No API route or MCP tool takes a project argument, lists projects or names another project.** `tools/list` and the OpenAPI document gain only the capacity endpoint ([section 7](#ses-account-and-capacity-planning)), which reports instance totals and never names a project.
- **MCP `initialize` instructions:** one added sentence naming the project and saying that the endpoint serves only that project, and one saying to check capacity before scheduling a large campaign. Keep the instructions within their size limit (D108).
- **Instance JSON routes (`/api/instance/**`)** require an instance session plus CSRF, and are never exposed to API users or MCP. The OpenAPI coverage test lists them as excluded, with the reason "instance host, admin session only".

## 7. Global send queue

### Today

Check this against the code before changing it:

- **One rate limiter:** one process-wide token limiter, `messaging.max_send_rate`, paces every SMTP push ([D92](09-decisions.md#d92-one-shared-send-rate-cap-for-ses-lead-2026-11-07), `src/messaging/rate.ts`). It has two priorities, `outbox` before `campaign`. The emailer acquires a token per push, and the 60 s push deadline (D49) starts after the token is granted.
- **Outbox:** claims up to 10 due rows per commit, of mixed kinds. It keeps a `live` set so a lease does not expire under a push that is waiting (`src/messaging/outbox.ts`).
- **Campaign runner:** paces itself with `app.message_rate`, `app.concurrency` and the sliding window, and advances its cursor per batch (`app.batch_size`) in one transaction before sending. This work removes that per-campaign pacing. The runner renews its lease by heartbeat, and runs one batch at a time in the process.
- **Durable work stays in each project's tables:** outbox `sends` rows and campaign cursors. Claiming and admitting a send must commit together with the same project's consent state: marketing policy, frequency cap, blocklist.

### Why this changes with several projects

**Restart loss.** A marketing row that is claimed and then waits for a token becomes `unknown` and is lost if the process stops. A restart turns `sending` into `unknown`, and marketing is never retried. Its consent and frequency-cap check also goes stale while it waits. With one project the wait is short. With many projects sharing one rate, a project could hold claimed rows for minutes. The fix is to claim only what can start almost at once.

**Fairness.** Fair sharing across projects needs one place that decides whose message starts next.

### The dispatcher

An instance service in `src/messaging/`. It owns the emailer, its SMTP pools, the rate limiter and the SES snapshot. Projects never build their own emailer.

- **"Global queue" means global scheduling, not one table.** Each project keeps its durable rows. The dispatcher decides which project's work starts in which slot.
- **Per-push context:**
  - The one emailer receives, with each push, what is per project today: the Message-ID domain (the project's root domain), the copy-allowed check (that project's blocklist) and the hold check (that project's restore hold, or the instance's).
  - Today these are closed over in `createEmailer` (`src/main.ts`). They become arguments of the push.
- **Classes, in strict priority order:**

  | Class | What | Latency target |
  |---|---|---|
  | `transactional` | tx sends of kind transactional (sync and async), transactional sequence steps, opt-in confirmations, subscriber mails, password reset, admin notifications, campaign and step test sends | Starts within the reservation horizon (2 s) plus one token interval. Never waits for marketing or campaign work beyond that |
  | `marketing` | outbox rows of kind marketing: sequence marketing steps and tx marketing sends | May wait. Budget: 1 hour from due to start under normal load |
  | `campaign` | campaign recipients | Runs at whatever capacity is left |

- **Start slots:**
  - The dispatcher turns the effective rate into a schedule of start slots, one every `1000 / rate` ms. A slot is a time at which one message may start.
  - It assigns slots in class order, round-robin across projects within a class, one slot per project per turn.
  - Each assigned slot is consumed by exactly one push. A granted push does not acquire another token, so there is no double pacing.
- **Transactional** keeps today's path: claim first, then take the next free slot ahead of the other classes.
- **Marketing and campaign reserve before they claim** ([invariant 3](#14-invariants)):
  1. The project loop asks for up to N slots for its class: the outbox's 10, or the campaign's fixed internal maximum.
  2. The dispatcher grants only slots that fall within the next 2 seconds (the reservation horizon), at most N.
  3. The loop claims at most as many rows or recipients as it was granted, with no transaction open while it waits for the grant.
  4. Each message starts at its slot. Unused slots go back at once.
  5. The campaign cursor advances only over granted recipients, so a campaign batch is at most the slots its project gets within 2 s.
- **Mixed outbox claims:** the outbox claim is split by kind. Transactional rows are claimed as today. Marketing rows are claimed only against a grant.
- **Synchronous `POST /api/tx` of kind marketing:**
  - It waits at most the horizon plus 5 seconds for a grant.
  - Without one (backlog, or the quota guard), its row stays `queued` and the response is the async answer, `status: "queued"`. The outbox sends it later.
  - It never holds a request open longer than that.
- **Rate `0`** (no cap, D92): slots are not paced. The dispatcher still grants in class order and round-robin, and the in-flight bound is a fixed 200 messages, process-wide, instead of `2 × rate`.
- **One in-flight bound for the process.** The 2-second horizon bounds claimed-but-not-started marketing and campaign messages, process-wide, to at most `2 × rate`, or 200 at rate `0`. That bound replaces the runner's "one batch at a time" (invariant 7).
- **Rate:**
  - `messaging.max_send_rate` is instance-wide.
  - The effective rate is the lower of it and SES's `MaxSendRate` ([below](#ses-account-and-capacity-planning)).
- **Wake and idle:** enqueue and start signal the dispatcher. An idle instance runs no dispatcher timer.
- **Restart:**
  - Grants are in memory and are lost on restart, which is correct: nothing granted is claimed until the claim commits.
  - The B118 note, that the first send after a restart can follow the last one at once, stays a separate backlog item.
- **Shutdown order:**
  1. Projects stop asking for slots.
  2. Granted pushes start or are dropped before their claim.
  3. In-flight sends drain under today's deadlines.
  4. The dispatcher stops.

### As built (B141)

[D155](09-decisions.md#d155-the-dispatcher-b141-lead-2026-11-25) records the choices this section left open. Where this list and the text above differ, this list is the code.

- **Modules.** `src/messaging/dispatcher.ts` is the instance service: `createDispatcher({ clock, smtp, rate, held?, onStart? })` builds the one emailer and hands each project a sender (`sender({ rootUrl, copyAllowed, refuse })`). `src/projects/instance.ts` builds the one dispatcher, wakes it when the effective rate or the guard changes (B145b), passes it to `createProject` as a service, and closes it after every project. `src/messaging/rate.ts` (the limiter) is gone.
- **Per-push context.** `createEmailer` (`src/messaging/email.ts`) takes no root URL, copy policy or hold any more: each push carries them (`PushContext`: the Message-ID domain, `copyAllowed`, `refuse`) and its start wait. The sender fills them from its project on every push.
- **The interface (B145 builds on it).**
  - `request(class, count, signal?)` → `Grant`: up to `count` slots of `marketing` or `campaign`, resolved as soon as at least one is granted; rejected when the signal aborts or the sender stops. No transaction is open while it waits.
  - `Grant`: `count` (unused slots), `keep(n)` (returns the unused rest at once), `release()` (returns every slot not started; a push still waiting in one ends not-started, so its claim is handed back).
  - `push(message, { copies?, testPool?, grant? })`: with a grant the message takes one of its slots and acquires nothing else; without one it is transactional and takes the next start ahead of every granted one. `test(server, message, rootUrl)`: the SMTP settings test, transactional, waiting at most 10 s.
  - The effective rate is the `rate()` input (the lower of `messaging.max_send_rate` and SES's `MaxSendRate` since B145b), re-read on `wake()`.
  - `held()` is the hold predicate: while it is true no marketing or campaign slot is granted, transactional starts are not affected, and `wake()` resumes granting. B145b's quota guard fills it.
- **Schedule.** One start every `1000 / rate` ms. A start is taken by the first waiting transactional push, else by the next ready granted push of `marketing`, else of `campaign`, round-robin across projects within a class. A push whose start is free (rate `0`, or a transactional push with its tick come and none ahead) starts in the same turn. The first start waits one interval after the first time any project asks to send (a push, a test or a slot request), not after the dispatcher was built: the instance builds it before its projects open, which can take longer than an interval at a low rate (B118a; B149b, D165).
- **Grants.** Free room is the horizon (`floor(2 × rate)` slots, at least one; 200 at rate `0`) minus the slots reserved and not started, minus the waiting transactional starts, and at rate `0` minus the granted pushes still in flight. It is granted marketing first, then campaign, one slot per project per turn, and no project holds more than its share of the horizon (the horizon divided by the projects of that class with a request or a reservation, rounded up). A request is answered as soon as it holds one slot: it never waits for more. Slots a batch does not use go back at once. At rate `0` a granted batch (up to 100 per campaign) starts at once, so `app.max_send_errors` can be passed by up to one batch before the error pause; at any positive rate the pause cancels the waiting slots. With SES keys and a snapshot the effective rate is never `0` (D165).
- **Outbox.** Two loops per project: the transactional loop claims up to 10 due transactional rows at once (as before, with lease expiry); the marketing loop only looks for a due marketing row, asks for up to 10 slots, then claims at most that many in one commit and pushes each in its slot. Each claim names its kind (migration 34 adds `idx_sends_due_kind`). A synchronous `POST /api/tx` claims its transactional rows at once; for its marketing rows it waits at most `HORIZON_MS + 5000` for a grant, and without one returns with the rows `queued`.
- **Campaign runner.** The loop's claim only opens due campaigns; while a pipe is open it asks for up to `MAX_CLAIM` = 100 campaign slots (chosen by measurement, D155), then claims at most the granted recipients from the next pipe in rotation in one commit and advances the cursor over them only. Every recipient is pushed in its slot at once. After each outcome the status is reread; a pause, cancel, error pause or shutdown releases the grant, so the pushes still waiting end not-started and return to the cursor. The process-wide one-batch slot is gone.
- **Shutdown.** A project's `stop()` stops its loops and closes its sender together: open requests are rejected, unused slots and waiting pushes go back (not-started, their claims handed back: outbox rows return to `queued`, campaign recipients to the cursor), and the pushes in SMTP flight drain under their deadlines. The instance closes the dispatcher (and its pools, 5 s) in the same turn as the projects. The sender's own 5 s close deadline (B143a, for a delete) settles only a push that may have reached SMTP (its operation started on a connection) `unknown`; a transactional or granted push still queued in a pool for a connection is handed back not-started and never starts, so its row stays `queued` across the restart, as the emailer's close leaves it (B141a).
- **Removed keys.** `app.concurrency`, `app.message_rate`, `app.batch_size`, `app.message_sliding_window`, `…_duration` and `…_rate`: a write naming one is the `400` of any unknown key, on either side (07).
- **Tests.** `test/messaging/dispatcher.test.ts` (priority and fairness, two campaigns within ±1, no double pacing, rate `0`), `test/messaging/rate-restart.test.ts` (B118a, and the first interval counted from the first send asked for), `test/tx/dispatcher.test.ts` (mixed claim, synchronous marketing under a hold and behind a real transactional backlog), `test/projects/dispatcher-crash.test.ts` (SIGKILL and SIGTERM mid-wait on the compiled executable, in `contract:projects`) and `test/projects/shutdown-queued.test.ts` (an orderly stop with one send in SMTP flight and one queued behind it for the connection, B141a). Measurements: `docs/perf/projects-B141.md`; migration 34 in isolation and the mixed load on the B149b build, with the data directory's filesystem recorded: `docs/perf/projects-B149b.md`.

### SES account and capacity planning

The SES account already knows its limits, so the app reads them instead of having them typed in, and shows them when a campaign is planned.

- **Reading the account:**
  - **Credentials:** instance settings `ses.api_region`, `ses.api_access_key_id` and `ses.api_secret_access_key`, for an IAM user that only has `ses:GetAccount`. SES SMTP credentials cannot sign API calls, so these are separate. All three are empty by default.
  - **The call:** SES v2 `GetAccount` (`GET https://email.<region>.amazonaws.com/v2/email/account`), signed by an in-house SigV4 signer on Web Crypto, with no AWS SDK (invariant 9) and a 10-second limit.
  - **What it reads:** `SendQuota.MaxSendRate`, `Max24HourSend`, `SentLast24Hours`, `ProductionAccessEnabled` and `SendingEnabled`.
  - **When it reads:** at start, every 5 minutes, every minute while the last read left at most `max(10% of the quota, effective rate × 300 s)`, and on demand when a forecast is asked for and the snapshot is older than 1 minute.
  - **Storage:** the snapshot is held in memory only. A restart reads it again.
  - **Failure:** a failed read keeps the last snapshot, shows its age, and writes one attention line per hour while reads fail. A failed read never stops sending.
  - **Check button:** instance settings has a "Check SES account" button that shows the values or the AWS error.
- **Rate:**
  - Effective rate = the lower of `messaging.max_send_rate` and `MaxSendRate`. The setting stays a cap the operator may lower, default 14.
  - Instance settings shows SES's rate beside the setting and warns when the setting is higher.
  - Without API credentials, the setting alone applies, as today.
- **Forecast:** one question, "does the busiest 24 hours around this campaign fit the quota?" Every number is computed from these inputs, so a test can compute it by hand.
  - **Window:** the 24 hours ending at F, where F is the candidate's estimated finish: its start T plus its recipient count ÷ the effective rate. The rolling peak is reached when the campaign ends, not when it starts. Without a candidate (the Sending page), F is now.
  - **App history:** the app's own starts per hour over the last 24 hours, from every project's `sends` and campaign deliveries.
  - **Outside sends:** sends the app did not make, equal to `SentLast24Hours` minus the app's own 24-hour total, never below 0. This is mail from other software on the same account. It is spread evenly over the past 24 hours.
  - **Still counted at F:** past sends, both the app's own by hour and the outside share, that are less than 24 hours older than F. This is zero when F is 24 hours or more from now. A daily newsletter at the same hour is therefore not double-counted against yesterday's run.
  - **Baseline:** the app's non-campaign starts over the last 24 hours, counted for the part of the window that lies in the future.
  - **Planned:**
    - the recipients of every `scheduled` campaign whose `send_at` falls inside the window (F − 24 h, F]
    - the remaining recipients of every `running` campaign, in every project
    - the candidate campaign's recipients, if given, with an optional campaign ID so an already scheduled campaign being edited is not counted twice

    These come from a narrow per-project function that returns `send_at` and recipient counts only, counted the way the runner counts them. A campaign counts in full in the window where it starts, which overstates rather than understates.
  - **Output:**
    - window demand = still counted + baseline + planned
    - the quota and the headroom
    - whether the window fits
    - the snapshot's age

    These are instance totals only, with no project name and no other project's campaign.
- **Where it shows:**
  - **API:** a native endpoint `GET /api/sending/capacity` (optional `at`, `count` and `campaign_id` for a candidate) on every project host, with the `campaigns:get` permission. The OpenAPI document covers it, and MCP exposes it through the existing generation rules.
  - **Campaign page:**
    - When a send time is set, when a campaign is scheduled and before it starts, the admin UI shows "Fits: 18,200 of 50,000 in the 24 h up to Tue 13:40" or "Over the quota by 3,100 in the 24 h up to Tue 13:40".
    - If it is over, the user must confirm.
    - Scheduling is never refused. The listmonk status API is unchanged.
  - **Instance Sending page:** the effective rate, the snapshot, and the forecast for the 24 hours from now.
- **Last-resort guard.** A forecast can still be wrong: lists grow, transactional mail spikes, other software sends. SES refusing mail past the quota would make marketing sends `failed` and lose them. So:
  - The dispatcher stops granting slots to the `marketing` and `campaign` classes when the remaining quota is at most `max(2% of Max24HourSend, effective rate × 60 s)`. 60 s is the fast refresh interval, which is always in force before the hold line is reached. The remaining quota is `Max24HourSend − SentLast24Hours`, from the latest snapshot.
  - The second term covers what the app can send between two fast reads: at rate 14 and a one-minute refresh that is 840, more than 2% of a 10,000 quota. Without it, SES would refuse mail past the quota and marketing would be lost as `failed`.
  - It writes one attention line when it starts holding and one when it stops.
  - Rows stay `queued`, with no lease. Running campaigns stay `running`, with their heartbeat, and their cursors do not move.
  - Everything resumes by itself when a newer snapshot is above that line.
  - No pause, no notification, no counter of the app's own.
  - Transactional is never held.
  - Without API credentials there is no forecast and no guard, and instance settings says so.

### As built (B145a)

[D159](09-decisions.md#d159-ses-account-and-forecast-b145a-lead-2026-11-25) splits B145 and records the choices this section left open. B145a built the account and the forecast; B145b feeds `MaxSendRate` into the dispatcher's rate and adds the guard ([section 7, "As built (B145b)"](#as-built-b145b)). Where this list and the text above differ, this list is the code.

- **Modules.** `src/messaging/sigv4.ts` (the signer), `src/messaging/ses-account.ts` (the client, the snapshot loop, `effectiveRate` and `refreshDelay`, all pure but the loop), `src/messaging/capacity.ts` (the forecast over every project's source), `src/campaigns/planned.ts` and `sends.starts` (each project's counts and send times, never rows). The instance (`src/projects/instance.ts`) owns one account and one forecast and gives each project its source; `InstanceConfig.sesEndpoint` points tests at a stand-in.
- **Reading.** As above, with the refresh line using the effective rate, no fast refresh for an account without a daily limit, an on-demand read only when the last attempt (good or failed) is over a minute old, and a key change dropping the snapshot. The refresh counts from when the last read began, not from its answer, so a slow answer does not stretch the minute between two fast reads (B151, D175). The attention line is "SES GetAccount answered …; keeping the snapshot read at …", at once on the first failure and then hourly.
- **Forecast.** As above, at exact times rather than hour buckets (a daily run at yesterday's hour is never counted twice), with the outside share and the baseline prorated by the exact past and future parts of the window and rounded up. Starts are `sends` rows `sending`, `sent` or `unknown` at their latest attempt (`coalesce(attempted_at, sent_at)`; a row counts once, at its last attempt) and campaign deliveries `claimed`, `sent` or `unknown`. A candidate by `campaign_id` takes its audience and send time and leaves it out of its own project's planned list; with rate 0 it takes no time; without a daily limit it always fits.
- **API.** `GET /api/sending/capacity` with `at` (RFC 3339, zone required), `count` and `campaign_id`, `campaigns:get`; `available: false` with `reason` `not_configured` or `not_read` until a read succeeds. A failed read shows project users a fixed text, never AWS's message. OpenAPI component `SendingCapacity`; MCP tool `get_sending_capacity`. The MCP instructions name the project (to 40 characters) and say to check capacity before scheduling a large campaign.
- **Pages.** The campaign page shows the line for a saved draft, paused or scheduled campaign at the form's send time and adds it to the confirmation when over. Instance settings, Amazon SES: "Check SES account" (`POST /api/instance/settings/ses/check`) shows the values or the AWS error, says when no keys are saved, and warns when the send-rate setting is higher than SES's rate.
- **Cost.** About 28 ms for 100,000 sends and 100,000 deliveries, 250–280 ms for a million of each ([projects-B145a](../perf/projects-B145a.md)).
- **Tests.** `test/messaging/sigv4.test.ts`, `test/messaging/ses-account.test.ts` (injected clock, stand-in server), `test/projects/capacity.test.ts` in `contract:projects` (three projects, hand-calculated windows, the MCP call). `test/projects/capacity-serve.ts` runs an instance with the stand-in for the `agent-browser` pass.

### As built (B145b)

[D161](09-decisions.md#d161-effective-rate-and-quota-guard-b145b-lead-2026-11-25) records the choices the **Rate** and **Last-resort guard** items leave open. Where this list and the text above differ, this list is the code.

- **Wiring.** The instance builds the SES account before the dispatcher and passes its `rate()` (`effectiveRate` of the setting and the latest snapshot) and `held()` as the dispatcher's inputs. The account calls the instance's `onChange`, which is `dispatcher.wake()`, whenever the effective rate or the hold moved: after a good read, after a settings write that changes the rate setting or the keys. An unrelated settings write, an unchanged read and a failed read wake nothing. The dispatcher, the outbox and the campaign runner are unchanged: `held()` already stopped marketing and campaign grants and left transactional starts alone (B141).
- **Hold line.** `holdLine(snapshot, rate) = max(0.02 × Max24HourSend, rate × 60)` and `quotaHeld(snapshot, rate)`, both pure, in `src/messaging/ses-account.ts`. Held when `Max24HourSend − SentLast24Hours` is at most the line, so a quota already overrun holds too. Never without the keys, without a snapshot, or for an account without a daily limit (`-1`). The rate is the effective rate; at rate `0` (no setting, no snapshot rate) the 2% term alone applies.
- **When it changes.** The hold is re-evaluated only when the snapshot or the settings change, never on a timer. A failed read keeps the snapshot, so the hold follows the last good read. A newer snapshot above the line lifts it. Removing or changing the keys drops the snapshot (B145a), so a hold ends with them; the new keys' first read decides again. A change of the rate setting moves the line's rate term and can start or end a hold on the same snapshot.
- **Attention lines.** `[instance] SES quota guard: holding marketing and campaign sends: <left> of the 24-hour quota of <max> left, at or below the hold line of <line> (snapshot read at <time>)` when it starts, `… resuming marketing and campaign sends: <left> … above the hold line of <line> …` when it ends, and `… resuming …: the SES API keys changed` when the keys end it. Nothing repeats while the state stays.
- **While held.** Granted slots and pushes already started finish; nothing is handed back or retried. Outbox marketing rows stay `queued` with no claim (the marketing loop waits in its request for slots, outside any transaction). A running campaign keeps its lease renewed and its cursor where it was, waiting in its request. Synchronous marketing `POST /api/tx` returns its rows `queued` after its bounded wait (B141). Transactional mail starts as before.
- **Instance settings.** Beside `messaging.max_send_rate` (Performance): "SES allows N/s. Sending runs at the lower of the two." from the latest snapshot when the page was rendered, and a warning while the field's value is higher (or `0`, no cap): "The setting is higher than the rate SES allows: sending runs at N/s." Without keys: "No SES API credentials are saved: the setting alone applies, with no capacity forecast and no quota guard." With keys and no good read yet, that the setting alone applies until one. The B145a check result's warning stays.
- **Cost.** Within ±1% of `main` for outbox and campaign throughput, with no keys and with a snapshot far from the line ([projects-B145b](../perf/projects-B145b.md)).
- **Tests.** `test/messaging/ses-account.test.ts` (the hold line at both terms, one line at start and end, a failed read keeps the hold, the keys ending it, which changes wake the dispatcher) and `test/projects/guard.test.ts` in `contract:projects` (an in-process instance on a test clock with the SES stand-in and a sink: the effective rate in both orders and after a new snapshot, the guard at 20,000 of 1,000,000 and at 840 of 10,000 at rate 14 with a running campaign, queued marketing rows and a synchronous transactional call, resume on a newer snapshot, no guard without keys, the settings line; B149b: a hold that starts with marketing sends in flight, and marketing asked for three hours into a hold). A key change during a read discards it and reads the new keys at once, for the loop and for a forecast (B149b).

### What does not change

- At-most-once for marketing and campaigns, the transactional retry rules (D24, D53), the frequency cap, the restore hold and the Message-ID format.
- Never add a retry that could send marketing mail twice.

## 8. Bounces and SES notifications

- **`POST /webhooks/service/ses` is served on the instance host.** It uses the instance's bounce settings and topic ARNs, and handles SNS `SubscriptionConfirmation` once, with today's checks.
- **One project:** when exactly one project exists and the instance has never served more than one, every notification goes to it and is processed exactly as today, including today's fallback to the recipient address (B149b round 2: once a second project was registered, the several-projects rules apply even after deletes leave one).
- **Several projects:** routing to a project.
  1. Take the Message-ID from the notification, as today.
  2. Look up its domain among hostnames and extra hostnames.
  3. If no host matches, ask each project, in slug order, whether the UUIDs in that Message-ID, name one of its sends, campaign deliveries or test sends.
  4. Exactly one match decides the project. No match, or more than one, stores nothing in any project, acts on nobody, and writes one attention line: "An SES notice matched no project".
  5. The project records the bounce with today's rules, including the `bounce_receipts` deduplication in its own database.
- **No match by recipient address across projects.** The fallback to the recipient address applies only inside a project the notice was routed to. The same address can be a subscriber in two projects, and a bounce must never act on a project the message did not come from.
- **Native bounce route:** `POST /webhooks/bounce` (native and listmonk-compatible) stays a project route, with project credentials.

### As built (B142)

[D156](09-decisions.md#d156-ses-routing-b142-lead-2026-11-25) records the choices this section left open. Where this list and the text above differ, this list is the code.

- **Modules.** `src/bounces/ses-route.ts` holds the route (`registerSesRoute`) and each project's side of it (`createSesProject`). `src/projects/instance.ts` registers the route on its own router and sends `POST /webhooks/service/ses` there on the instance host and on hosts no project claims, before the primary project; `src/projects/compose.ts` exports each project's narrow side as `project.ses`. A project's router no longer serves the SES service: on a project host the path answers `400 Unknown service.` as any unknown provider does.
- **Settings and order.** The instance's `bounce.enabled` (else `503`), `bounce.webhooks_enabled` (else the public `404`, branded as the primary project, or plainly without one), the bounce rate limit, then `bounce.ses_enabled` (else `400 Unknown service.`), the signature, the topic ARNs and the message type, as before. `SubscriptionConfirmation` and `UnsubscribeConfirmation` are answered once by the instance and reach no project.
- **Rate limit.** The bounce webhook table's peers are keyed by the empty slug, which no project has; the limit is the largest of the floor (6,000 a minute) and every project's own budget, so one project's limit is unchanged.
- **A project's side** is two functions: `claims(messageId)` answers only true or false, and `receive(notice)` records a verified notice with today's rules (the `bounce_receipts` key `sns:<MessageId>` and its expiry, test-send attention lines, bounce actions) in that project's database. A campaign delivery `<campaign>.<subscriber>@host` is a project's when both its campaign and its subscriber are; a send `<send>@host` when it holds the send; a test send by its exact Message-ID inside the test-send retention window.
- **Routing.** One served project on an instance that has never served more than one: it, whatever the Message-ID. Several, or one left after others (B149b round 2): the Message-ID of the notice's `mail` (every recipient of one notice shares it; from `commonHeaders.messageId` when the header list has none, as when SES truncates it), and every project in slug order through `claims`; exactly one `true` decides. Since B149b ([D165](09-decisions.md#d165-dispatcher-ses-account-and-bounce-routing-hardening-b149b-lead-2026-11-25)) the domain decides nothing: a project user can choose a campaign test's Message-ID, and a hostname can move to another project, so only the project's own records are believed. A late bounce of a project whose hostname moved still reaches that project. A Message-ID that names no record of any project (a chosen one, or one whose records are gone) and a notice without a Message-ID match nothing; no recipient address is looked up across projects. No Message-ID, no match or several matches: `200 {"data":true}` (so SNS does not retry), nothing stored anywhere, one attention line `[instance] An SES notice matched no project: SNS message <id>` on stderr, with the fixed text `An SES notice matched no project`. B142 wrote it to stderr only; since B143a it is also in the instance's log buffer and its Logs page ([section 13, "As built"](#as-built-b143a-1)).
- **One-project extra hostnames.** A project's extra hostname is that project's host, so the route answers `400 Unknown service.` there even with one project (D156, confirmed in D165): SNS subscribes the instance host.
- **A routed notice acts only on its own record's subscriber (B149b round 1, D165).** With several projects a delivery's `X-Listmonk-Campaign` and `X-Listmonk-Subscriber` headers, when present, must name the Message-ID's own UUIDs, else the notice matches nothing (the attention line above); a send's notice acts only on the send's subscriber, and one whose subscriber header names another records nothing; no subscriber is looked up by address. A campaign test refuses a custom Message-ID in the app's own send or delivery form (`400`), so no message the instance sends names another project's record. So a notice acts on a subscriber only through the record its Message-ID names, and only when the bounced address is that subscriber's.
- **The recipient-address fallback** runs only on an instance that has never served more than one project, where it is today's behavior: every message the instance sent was that project's, so it cannot cross projects. One served project is not enough: after a delete, a late notice of the deleted project's message would reach the one project left. So instance.db records, in `several_projects` (instance migration 4, owned by the registry), that the instance has ever had a project other than the one serving now: the row is written with the registration of any project besides the primary and with the removal of any project (so a new primary after a delete, or a slug used again, finds it set), and on start when `backups/deleted/` holds a deleted project's snapshot or cannot be listed (that start still serves, with an attention line); the row is never removed, and from then on the rules for several projects apply even with one left: routing through `claims`, no address lookup, and under `ownRecord` with no resolvable send the subscriber is the Message-ID's own UUID's, never a header's (D165 rounds 1 and 2). A restored instance.db older than the second project's registration or the first delete, with no snapshot in `backups/deleted/`, forgets it (operations.md says to keep the snapshots). `POST /webhooks/bounce`, a project route with project credentials; `bounce_receipts` in each project's database.
- **Tests.** `test/projects/bounces.test.ts` in `contract:projects` (compiled executable, signed SNS fixtures through the loopback tunnel; B149b: a project's host with none of its records, a delivery named with another project's host in upper case, a campaign test's chosen Message-ID naming another project's host, truncated headers, and a tie the copy's own host does not break; round 1: the review's forged-delivery probe refused at the campaign test and its late notice unmatched, delivery headers that disagree with the Message-ID, and the same forgery against a transactional send; round 2: `test/projects/bounces-deleted.test.ts`, a deleted project's late notices with one project left, across a restart and on upgraded instances, and a never-multi-project instance keeping the fallback). The existing bounce suites run unedited against the primary project; the in-process fixtures that wired the SES branch (`test/tx/fixture.ts`, `test/messaging/notice-fixture.ts`) wire `registerSesRoute` with their one database.

## 9. Background loops

- **Per project, unchanged in behavior:** campaign runner, outbox, sequence scheduler, webhook delivery, maintenance, retention and summary refresh. Each uses its project's database and the injected clock. Sending loops get slots from the dispatcher.
- **Process-wide budgets stay process-wide.** None of these may multiply by the number of projects:
  - the tx attachment memory budget (D74, D87)
  - the read-only helper child limits (D62)
  - the VmRSS watchdogs
  - the public rate limiter's memory bounds
  - the in-memory ALTCHA replay state
  - the in-flight sending bound (section 7)

  Each project may hold its own state inside the one budget.
- **Logs:**
  - Each project has its own log buffer, and `GET /api/logs` on a project host shows that project's lines.
  - Instance lines (dispatcher, SES endpoint, unmatched notices) go to the instance buffer.
  - The instance Logs page shows the instance lines and every project's lines, labeled by slug.
  - Stderr gets every line, prefixed with the slug or `instance`.
- **Health:**
  - The health route of a project reports that project.
  - The instance health route reports the instance and every project, and is unhealthy if any project's loops are down. It is served on the instance host and on unclaimed hosts when there is no primary project.

## 10. Project lifecycle

All lifecycle actions are on instance pages, with JSON routes under `/api/instance/projects`. No restart is needed.

- **Create** with slug, name and hostname. The primary flag is allowed only when no primary exists and the hostname is the instance host.
  1. Validate everything.
  2. Create `projects/<slug>/` and migrate the new database.
  3. Seed defaults as a fresh install does: default templates and settings, plus the admin's copy.
  4. Wire the project and write its registry rows. The registry is written last.
  5. Start its loops.

  A failure before the registry write removes the directory. A leftover directory with no registry row is reported at start with an attention line and is never served.
- **Edit:**
  - Rename the project.
  - Add or remove extra hostnames. Removing one warns that links in old mail to that host will stop working.
  - The slug and the main hostname never change.
- **Delete:**
  1. The admin must type the slug.
  2. The project stops asking for slots, and in-flight sends drain under today's deadlines.
  3. Its routes leave the table.
  4. A final snapshot goes to `backups/deleted/<slug>-<timestamp>.db`, with a tarball of `uploads/` if there is one.
  5. The directory is removed.

  Delete is the only removal. There is no "disable", because a disabled project whose unsubscribe links fail would be worse than one that is gone.
- **Limits:** no fixed maximum number of projects. The measurements cover 1 and 10 projects ([section 16](#16-measurements)).

### As built (B143a)

[D157](09-decisions.md#d157-lifecycle-and-instance-pages-b143a-lead-2026-11-25) records the choices this section left open. Where this list and the text above differ, this list is the code.

- **One at a time.** `add`, `update` and `remove` on the instance run in one queue: a create that loses a same-slug race finds the winner's directory (`409`) and removes nothing, and a create of a slug being deleted waits for the delete, then creates a fresh project.
- **Create** (`POST /api/instance/projects`): slug (`[a-z0-9][a-z0-9-]{0,39}`), name (trimmed, one line, at most 200 characters), hostname, optional extra hostnames and primary flag. Everything is checked before the directory is made: slug and hostnames (lowercase, no port, unique across projects and within the project), a free slug and directory, the primary rule, and the instance host for a non-primary project. The project is wired as at a start (migrations, fresh-install defaults, the admin's copy), the registry rows are written last, then it is served and its loops start. A failure before the rows closes it and removes its directory.
- **Edit** (`PUT /api/instance/projects/<slug>`): `name` and/or `extra` (the whole new list); a field left out keeps its value. The extra hostnames are replaced in one transaction; the routing table follows at once. Slug and main hostname cannot be sent.
- **Delete** (`DELETE /api/instance/projects/<slug>` with `{"confirm":"<slug>"}`): the project leaves the routing table, its sending stops (its slot requests and unused slots go back, a push waiting for its start ends not-started and its claim is handed back, and no new request of its is answered), the requests its router is answering finish (counted from dispatch to the handler's answer; a streamed body after that is not waited for), its loops stop under their own deadlines (its pushes in SMTP flight get the sender's 5 s close deadline, then settle `unknown` for it, never retried and with no shared connection cut; a push still queued for a connection ends not-started and never starts), it closes, its registry rows go, then the database is checkpointed and moved to `backups/deleted/<slug>-<ISO time>.db` and every other file of the directory except `stage/` goes into `<slug>-<ISO time>.tar` (ustar, streamed one file at a time; no tarball when there is no file), and the directory is removed. A crash before the rows go serves it again at the next start; after, it leaves a directory with no row, reported and never served, with nothing lost.
- **Primary deletion** is allowed: the instance then answers as one with no primary (section 2). A start with an empty registry registers the primary `main` only while the instance has no admin account (a first start); once an admin account exists, an empty registry means every project was deleted, and nothing is registered.
- **Leftover directories** under `projects/` with no row are reported at each start with one `[instance]` attention line, listed on the Projects page, never served, and block a create of that slug (`409`).
- **API.** Instance session plus CSRF, `401` for any `Authorization` header, `400` invalid input, `404` no such project, `409` a conflict. Not in OpenAPI or MCP (`src/openapi/excluded.ts`).

### As built (B149a)

[D164](09-decisions.md#d164-project-lifecycle-and-instance-pages-hardening-b149a-lead-2026-11-25) records the choices. Where this list and the lists above differ, this list is the code.

- **Drain deadline.** A delete waits for the project's requests in flight at most `DRAIN_MS` (5 s on the instance clock, the sender's close bound). A request still running then is cut: the delete goes on, the database closes under it (it answers an error and writes nothing more), and one `[instance]` attention line names how many were cut. A slow upload can no longer hold the lifecycle queue.
- **Shutdown bound.** The HTTP stop that ends a shutdown (SIGTERM, SIGINT or a loop failure) uses the same rule: the server takes no new request and waits for those in flight at most `DRAIN_MS` on the instance clock, then cuts their connections (one `[instance]` attention line, "Stopping: N requests still running after 5 s were cut") and the databases close under them. Before, it waited for every request, so a stalled upload held the shutdown until Bun's 10 s idle timeout and a trickled one held it indefinitely.
- **A delete that stops part way** (its close, its registry rows or its final snapshot fails) keeps the project off the routing table, listed by `GET /api/instance/projects` with `delete_error` (the step and the error) and null counts, and on the Projects page with the error and only a Delete button; it is not a leftover and its slug cannot be created. The next `DELETE` finishes it from the failed step. The failed `DELETE` answers `500` with the same text, also an attention line. After a restart the registry decides, as for a crash: rows kept, it is served again; rows gone, a leftover directory. The final snapshot's steps are remembered too: its claimed `.db` name (a hard link to the database), then the written tarball. A retry after a failed tarball removes the partial one and writes it again under the same name; a retry after a failed directory removal (an upload folder the server cannot empty, a read-only directory) only removes the directory. Every retry ends with one `.db` and one `.tar`, never a `-2` copy.
- **Snapshot names are never reused.** `backups/deleted/<slug>-<ISO time>.db` is claimed with a hard link, which fails on an existing name where a rename would replace it; a taken name (two deletes in one millisecond, or a clock set back) gets `-2`, `-3`… on both the `.db` and the `.tar`.
- **Create during shutdown.** Once the instance's `stop()` has begun, a create is refused with `503` and nothing made. A create already wiring finishes and is registered, but its loops do not start; it closes with the rest, and the next start serves it.
- **Streamed bodies** cut by a delete (`per_page=all`, exports) end early with a broken stream; the delete, the other projects and the instance are unaffected (D157's rule, now tested).
- **Holds.** A project created while `instance.db` is held starts held; the instance Settings page's SMTP test is refused (`503`) while `instance.db` or the primary project's database is held (the primary project's own hold check and the sender's start check; already so before B149a, now tested).
- **Sent in 24 h** counts a delivered send from its start (`coalesce(attempted_at, sent_at)`), as the capacity forecast does, through `idx_sends_started`: a covering range search of the window instead of every sent row ([projects-B149a](../perf/projects-B149a.md)).
- **Settings line.** With `messaging.max_send_rate` at `0` the instance Settings page says the setting has no cap of its own and sending runs at SES's rate, instead of calling it higher; the page renders the saved value's line before Alpine starts. The warning shows only for a number above SES's rate: an emptied or negative field shows no line.
- **Tests.** `test/projects/delete-hardening.test.ts` (two deletes in one millisecond, a delete stopped at its registry rows and finished by the next, one stopped at each final-snapshot step (tarball, directory removal) and finished by the next from that step, the drain bound, a `per_page=all` stream cut by a delete, a create during shutdown), `delete-sending.test.ts` (the 5 s close bound pinned between 4.9 s and 5 s, a marketing `POST /api/tx` in flight during a delete keeps its row `queued`, a deleted project's push queued behind a shared connection never starts once it frees), `held.test.ts`, `backup-delete.test.ts` (a whole backup paused while a project is deleted fails with nothing left, and a rerun is whole) and `ses-rate-line.test.ts` and `shutdown-http.test.ts` (the HTTP stop cut at 5 s of the test clock; SIGTERM on the compiled executable with a trickled upload exits cleanly within the bound).

## 11. Moving data from listmonk

There is no import feature in the app (owner, 2026-11-23). Moving the owner's listmonk v5 data is a one-time job done by an AI agent outside the app, with the public API, the CSV subscriber import and MCP that already exist.

- **No import code:** no import command, no Go-template converter, no endpoint that writes chosen IDs or UUIDs, and no listmonk reference target for it.
- **Not a gap:** if the agent finds the existing API missing something it needs, that becomes its own backlog item with a reason. It is not added to this work.

## 12. CLI and operations

- **`iglo.email backup`** snapshots `instance.db` and every project into one timestamped directory. `--project <slug>` snapshots one project. Each snapshot keeps today's guarantees: a read-only helper, a verified copy and a restore hold.
- **Restore hold (D67)** is per database.
  - A restored project database holds only that project's sending.
  - A restored `instance.db` holds all sending until it is released.
- **`reset-password` and `reset-totp`** act on the admin, and the copies follow at the next start.
- **`operations.md` covers:**
  - wildcard DNS and certificates (`*.mail.example.com`), or one record per project
  - the reverse proxy must pass `Host`
  - SES identities: each project's `from_email` domain must be verified in SES
  - the read-only IAM user for `GetAccount`
  - one SNS topic for the account
  - backup and restore per project

### As built (B144a)

[D158](09-decisions.md#d158-backup-and-restore-per-database-b144a-lead-2026-11-25) records the choices. Where this list and the text above differ, this list is the code.

- **Whole backup.** `backup` with no flag writes one directory shaped like a data directory: `instance.db`, `projects/<slug>/` for every registered project (each exactly what `--project <slug>` writes) and `iglo-email-backup.json` naming the projects. Default `<data>/backups/iglo-email-<time>/`; an explicit `--output` names the directory itself. Every snapshot is built in one partial directory and checked, and the whole set is published by one rename, so a failure on any database leaves no backup at the final name. A project created or deleted meanwhile fails it.
- **Refused outputs.** Inside `<data>/projects/` or at `<data>/instance.db*`, before any folder is made.
- **Hold per database.** A project database's `restore.hold` holds that project. `instance.db`'s holds every project, through a `TEMP` mark on each project's connection at wiring, so every existing hold check applies unchanged and nothing is written to a project file.
- **Release.** `backup --release-hold --consent-reconciled [--project <slug>]` releases that project's database, or `instance.db`'s, on a stopped server, and prints what is still held.
- **Restore** is a file copy with the server stopped, per database: a project's directory, `instance.db`, or both. A restored project's admin copy follows the instance account at the next start.
- **CLI.** `reset-password` and `reset-totp` act on the admin account and every copy at once, under the lock (B140), not "at the next start" as the text above says.
- **Operations.** [Operations guide](../operations.md#backups) "Backups", "Restore" and "Restore details". Measurements: [projects-B144a](../perf/projects-B144a.md). Tests: `test/backup/projects.test.ts`.

## 13. Admin UI

Port and style rules are unchanged: server-rendered TSX, Alpine.js, Oat, like the existing admin.

- **Instance pages:**
  - **Projects:** a list with name, hostnames, primary flag, queued marketing count, running campaigns and sent in the last 24 h. Create, rename, extra hostnames, delete.
  - **Sending:** the effective rate, the SES snapshot, and the forecast for the 24 hours from now.
  - **Instance settings.**
  - **Logs** from all projects.
  - **Account:** password and TOTP.
- **Project pages:**
  - The header shows the project name and a switcher that lists projects and opens each through the handoff.
  - Settings shows project keys only.
  - The campaign page shows the forecast ([section 7](#ses-account-and-capacity-planning)).
  - Everything else is unchanged.
- **Verification:** with `agent-browser`. `bun run e2e` gains one multi-project spec ([section 15](#15-tests)).

### As built (B143a)

- **Projects page** (`/admin/instance/projects`, the instance login's landing page and `/admin/instance`'s target): every project with its name (opening it through the handoff), slug, primary badge, hostnames, queued marketing sends, running campaigns and messages sent in the last 24 hours (sends and campaign deliveries), read through `Project.activity(since)`, three counts from `src/analytics/activity.ts`, nothing else of the project. New, edit and delete dialogs (`assets/admin/js/views/instance-projects.js`); the edit dialog warns which removed hostname's old links stop working; delete needs the typed slug. The Sending page came with B143b ([below](#as-built-b143b)).
- **Logs page** (`/admin/instance/logs`): the instance buffer (its attention lines with their whole text, since only the instance admin reads them, and unexpected errors as their class) and every project's buffer, each line labelled with its source and merged by time, the newest 5,000. Rendered with the page; reload for newer lines.
- **Switcher.** A project page's header, for the admin's copy only, shows the project's name and a menu of every served project, each link `<--root-url>/admin/instance/open/<slug>?next=/admin`, and the Projects page. The project receives the list as a narrow `projects()` instance service (slugs and names).
- **Tests.** `test/projects/lifecycle.test.ts` (compiled executable: create and send, extra hostnames and old unsubscribe links, refusals, the same-slug race, a create failing before its row, credentials and CSRF, delete and snapshot, the Logs page, leftover directories and primary deletion) `test/projects/drain.test.ts` (in process: a delete during an in-flight request, and a create of the slug being deleted) and `test/projects/delete-sending.test.ts` (in process on a test clock: while a delete drains, every start goes to the other project and the deleted one's claims are handed back; a send held in SMTP flight bounds the delete at 5 s, its connection is not cut, it is `unknown` in the snapshot and is not sent again). `test/e2e/specs/projects.e2e.js` creates a project, switches to it, changes a setting and sends a test; `bun run e2e:browser` passes over the Projects and Logs pages and the switcher.

### As built (B143b)

[D162](09-decisions.md#d162-instance-sending-page-and-the-forecasts-start-time-index-b143b-lead-2026-11-25) records the choices. Where this list and the text above differ, this list is the code.

- **Sending page** (`/admin/instance/sending`, instance session only; API credentials `401`, a project session or none goes to the instance login; in the instance nav after Projects; `src/admin/instance/sending.tsx`). Rendered with the page, no script, reload for newer values:
  - **Rate:** the effective rate, `messaging.max_send_rate`, SES's `MaxSendRate`, and which applies (SES's when lower or the setting is `0`; the setting when not higher or SES's is not known); an effective `0` reads "No cap: sending is not paced".
  - **SES account:** `Max24HourSend` ("No daily limit" for `-1`), `SentLast24Hours`, remaining, production access (the sandbox said plainly), sending enabled (`SendingEnabled: false` as a warning, section 19 item 2), the read time and its age. While reads fail: "Stale" with the last error, AWS's own text.
  - **Quota guard:** holding or not, from the account's `held()` (what the dispatcher acts on, never a timer), the remaining quota and the hold line (`holdLine`, rounded up); an account without a daily limit never holds.
  - **Forecast:** the instance's forecast for the 24 hours ending now, through the same `capacity.forecast` as `GET /api/sending/capacity` with no candidate (and no asking project): still counted, outside sends, baseline, planned, window demand, quota, headroom, fits. Totals only.
  - **No keys:** says there is no SES reading, forecast or guard and links to instance settings. **Not read yet:** says so, with the last error when the reads fail.
  - Opening it may make the forecast's on-demand read (last attempt over a minute old), nothing more.
- **Index.** Migration 35, `idx_sends_started ON sends(status, coalesce(attempted_at, sent_at))`: `sends.starts` is unchanged and becomes a covering three-range search. About half the forecast's cost at a million sends and deliveries; `campaign_deliveries` stays without a time index (D162). Plan check and write cost: `test/perf/projects/sends-started.ts`; measurements: [projects-B143b](../perf/projects-B143b.md).
- **Tests.** `test/projects/sending-page.test.ts` in `contract:projects` (in process on a test clock with the SES stand-in: no keys and rate `0`, before the first read with AWS's error and one read a minute, a snapshot with the sandbox and `SendingEnabled: false` and the forecast equal to the API's, failing reads, the guard holding through time and a failed read and lifting on a newer snapshot, no daily limit, refusals). `test/projects/capacity-serve.ts` drives each state for the `agent-browser` pass (`?sent=`, `?sandbox=1`, `?disabled=1`, `?fail=1`); `bun run e2e:browser` visits the page.

## 14. Invariants

Any task that breaks one of these is not done.

1. **Isolation.**
   - No request, credential, loop, render or bounce ever reads or writes another project's database. A project's modules hold only their own `Database`.
   - Nothing selects a subscriber across projects by address.
   - Instance services (dispatcher, forecast, SES routing, admin sync) may reach every project only through narrow functions the project exports.
   - A project's API or MCP responses contain instance totals at most, never another project's rows or names.
2. **One project behaves exactly as today.**
   - Every existing HTTP-level test, contract suite and e2e spec passes against a primary project without being edited.
   - **Allowed edits:**
     - tests that construct internal modules directly (such as `createEmailer` or `createOutbox`), where a signature changes
     - tests that assert the data-directory layout
     - the settings and admin-copy behavior that sections 4 and 5 change on purpose: the project settings API with project keys only, and the removed campaign pacing keys. These are listed in 07 as deliberate differences from listmonk

     Each edit is listed in the PR body with its reason.
3. **At-most-once survives scheduling.**
   - Marketing and campaign work claims only against granted slots within the 2-second horizon.
   - A crash (SIGKILL) at any moment leaves `unknown` at most the claimed-but-not-started messages, `2 × rate` process-wide (200 at rate `0`), plus the messages already in SMTP flight, which are correctly `unknown`.
   - An orderly stop leaves no claimed-but-not-started marketing message `unknown`: not-started pushes go back before their claim, as today.
   - No retry of marketing mail is added.
4. **Transactional never waits behind other work.** With any backlog of marketing or campaign work in any project, a transactional message starts within the 2-second horizon plus one slot, plus SMTP time.
5. **One configuration.**
   - SMTP, the rate and the SES settings exist once, in the instance. No project can hold its own copy.
   - Only an admin session can change them.
6. **No cross-file transactions.** Every step that writes two databases has a documented order that is safe after a crash between the writes.
7. **Budgets do not multiply.** Every process-wide memory, child-process, rate and in-flight budget stays process-wide with N projects.
8. **No process-global state.** The instance, its routing table and its dispatcher are passed explicitly. No module-level maps of projects.
9. **No new runtime dependency.** None is expected: the SigV4 signer uses Web Crypto, which is built in.
10. **Old links keep working.** Unsubscribe works for every hostname a project's mail was sent from, extra hostnames included, until the project is deleted.

## 15. Tests

Rules from `AGENTS.md` apply: test through public boundaries, use the injected clock, no fixed ports, no DNS.

- **Host routing in tests:** test requests set `Host` explicitly. The first worker (B138b) checks that Bun's `fetch` sends a caller's `Host` header unchanged, and otherwise adds a small raw-HTTP test helper. No test depends on `*.localhost` resolution.
- **New contract suite `bun run contract:projects`.** It runs the compiled executable with three projects: primary, `a` and `b`.
  - **Isolation:** each of A's API credentials and session cookies gets `401` or `403` on B, for every route family: subscribers, lists, campaigns, templates, sequences, sends, events, media, webhooks, settings and MCP `tools/call`. B's data never appears in A's responses. An unclaimed host reaches only the primary project.
  - **Settings:**
    - a project's GET returns project keys only
    - an instance key or a removed pacing key in a project PUT is a `400` naming it, with nothing written
    - the instance settings API needs an instance session and refuses API credentials
    - the admin's change of an instance key is seen by every project
  - **Admin:**
    - instance login
    - handoff to a project, and spent, expired and foreign tokens
    - open-redirect attempts on `next`
    - login on a project host with the admin's credentials
    - a password change on the instance reaches every project
    - the copy's protected fields return `403`
    - the user and role contract suites still pass unchanged
  - **Without a primary project:** an unclaimed host gets the fixed 404, and instance health answers.
  - **Lifecycle:**
    - create a project while running and send from it
    - an extra hostname serves old unsubscribe links (the GET page and the RFC 8058 POST)
    - delete drains, then the host answers like an unclaimed one, and the snapshot exists
- **Dispatcher tests** (injected clock, test SMTP sink):
  - **Priority and fairness:** rate 10/s. Project A runs a 10,000-recipient campaign, project B queues 50 marketing sends, and project C makes a sync tx call.
    - C starts within the horizon plus one slot.
    - B's 50 all start before A gets 50 more slots.
    - Two campaigns in different projects stay within ±1 slot of each other per round.
  - **Crash mid-wait:** rate 1/s, 20 projects, each with 30 due marketing rows. SIGKILL the compiled process halfway, then start it.
    - At most `2 × rate` plus the in-flight count are `unknown`.
    - Every other row is `sent` eventually.
    - The test fails when the outbox claims before it has a grant.
  - **Orderly stop mid-wait:** the same setup with SIGTERM leaves no `unknown` row that never started.
  - **Synchronous marketing tx under backlog:** answers `queued` within the horizon plus 5 s and is sent later.
  - **Rate `0`:** grants follow class order, and in-flight never exceeds 200.
  - **No double pacing:** over 60 s at rate 10, starts are 600 ± 1, with no gap longer than two intervals while work is waiting.
  - **Mixed claim:** a batch of transactional and marketing rows claims the transactional rows at once, and the marketing rows only against grants.
- **SES account and forecast:**
  - **Signer:** the SigV4 signer matches AWS's published test vectors. A test server stands in for `GetAccount`.
  - **Refresh:** every 5 minutes, and every minute once the remaining quota is at most `max(10%, rate × 300 s)`, on the injected clock. That includes a 10,000 quota at rate 14, where the fast refresh starts at 4,200 remaining.
  - **Failure:** a failed read keeps the last snapshot and writes the hourly attention line.
  - **Rate:** the effective rate is the lower of the two values.
  - **Forecast:** fixtures with app history, an outside share, campaigns in three projects and a candidate. Window demand matches a hand calculation from the rules in section 7, for a candidate starting now, in 12 h and in 30 h, for an edited scheduled campaign given its ID, and for a daily campaign at the same hour as yesterday's. The response names no project. MCP `tools/call` of the capacity tool works with a project token.
  - **Guard:** at the hold line (both terms tested: a large quota where 2% applies, and a 10,000 quota where rate × interval applies), marketing rows stay `queued` with no lease, running campaigns keep their cursor, transactional continues, and everything resumes when a newer snapshot is above the line. One attention line marks the start and one the end.
- **Bounces:**
  - one project: today's behavior, including the address fallback
  - several projects: each project's notice lands there, an extra hostname resolves, and an unknown domain falls back to the UUID probe
  - no match stores nothing anywhere and writes the attention line
  - the same address subscribed in two projects: only the sending project is affected
- **Start refuses the old layout:** a data directory with `iglo-email.db` at its root is refused with the layout message.
- **CLI:** `backup` with and without `--project`, the per-project restore hold, and `reset-password` on the admin.
- **e2e:** one Playwright spec covers creating a project, the handoff switch, the settings split and sending a test from two projects. `bun run e2e:browser` covers the new instance pages.

## 16. Measurements

Required by `AGENTS.md` for sending, scheduling and storage changes. Store them in `docs/perf/projects-<task>.md`, before and after on the same host, three runs each.

- **Campaign throughput** for one project against the 50 msg/s target: no regression above 5%.
- **Outbox throughput** for one project: no regression above 5%.
- **Idle cost** at 1 and 10 projects:
  - RSS after start
  - RSS and CPU time over 10 idle minutes
  - startup time

  The target is linear growth with no idle CPU spinning. Investigate if one idle project costs more than 15 MB RSS.
- **Mixed load:** three projects sending at once at rate 14. Measure transactional start latency (p50, p99) and each project's share.

## 17. Tasks

One PR each, in the order listed. Each brief is written by the lead from this section, in the usual shape: Goal, Read first, Owns, Behavior, Acceptance, Out of scope.

Every task's acceptance includes:

- the full local checks from `AGENTS.md`
- its new tests
- invariant 2

| Task | Content | Owns | Depends on | Done when |
|---|---|---|---|---|
| **B138a** Composition extraction | Behavior-neutral: today's `main()` wiring becomes `createProject(…)` for one database. No instance, no routing, no new behavior | `src/main.ts`, new `src/projects/compose.ts` | — | Every existing suite passes with no test edited. Outbox and campaign throughput unchanged within noise |
| **B138b** Instance and routing | Sections 1–3: `instance.db` and its manifest, the registry, Host routing, primary and unclaimed hosts, refusal of the old layout, per-project logs and health, the unclaimed-host rule | `src/projects/**`, `src/main.ts`, `src/server/**` routing seam, `src/db/**` for the second manifest, `migrations/instance/`, tests | B138a | A fresh install runs as a primary project. Two projects registered by a test fixture are isolated on every route family. Every existing suite passes unchanged. Idle measurements for 1 and 10 projects recorded |
| **B139** Settings split | Section 4: instance settings store, the split settings APIs (project keys on project hosts, instance keys on `/api/instance/settings`), `ses.api_*` settings accepted, validated and masked (not yet used), settings UI split | `src/settings/**`, its admin views, tests | B140 ([D152](09-decisions.md#d152-b140-before-b139-lead-2026-11-24)) | The settings cases in `contract:projects` pass. The settings contract cases are updated for the split, and 07 lists it as a deliberate difference |
| **B140** One admin | Section 5: admin account in `instance.db`, copies, write-through of password and TOTP (all paths), protection, reserved username, instance login and session, handoff, Account page, CLI reset | `src/users/**` (copy flag, `createSession`, protection), `src/admin/` instance login and account views, `src/projects/` admin sync, tests | B138b | The admin cases pass. The user and role contract suites pass unchanged |
| **B141** Dispatcher | Section 7 up to "SES account": dispatcher, per-push context, classes, slots and round-robin, reserve before claim in the outbox (split claim) and campaign runner, removal of the campaign pacing keys (settings, runner, admin views), synchronous marketing tx, rate `0`, the in-flight bound | `src/messaging/**` (rate, email, outbox), `src/campaigns/runner/**` claim seam, `src/scheduler/**` claim seam, tests, `docs/perf/projects-B141.md` | B139 | All dispatcher tests pass, including crash and orderly stop mid-wait. The D92 and send-rate suites pass. Throughput and mixed-load measurements recorded. 04-sending updated |
| **B145** SES account and forecast | Section 7, "SES account and capacity planning": SigV4 signer, `GetAccount` snapshot, effective rate, forecast, `GET /api/sending/capacity` and its MCP tool, campaign-page forecast, guard | `src/messaging/**` (SES client), `src/campaigns/**` (planned-count function, page), `src/openapi/**`, `src/mcp/**` instructions, tests | B141 | The SES and forecast tests pass. The campaign page shows the forecast in an `agent-browser` pass. The campaign status contract suites pass unchanged |
| **B142** SES routing | Section 8 | `src/bounces/**` (the SES endpoint becomes an instance route), tests | B138b, B139 | The bounce cases pass. The existing bounce suites pass against a primary project |
| **B143** Lifecycle and instance UI | Sections 10 and 13: create, rename, extra hostnames and delete at runtime; Projects, Sending and Logs pages; the switcher; `/api/instance/**`; OpenAPI exclusions | `src/projects/**`, `src/admin/**` instance views, `src/maintenance/` logs aggregation, tests, e2e spec | B140, B142, B145 | The lifecycle cases and the e2e spec pass. The `agent-browser` pass is clean |
| **B144** Operations and docs | Section 12, `backup --project`, per-database restore hold, `operations.md`, README, and updates to 01, 02, 03, 04 and 07. D15 is marked superseded, and this document's status becomes "implemented" | `src/backup/**`, `docs/**`, tests | B143 | The CLI tests pass. The documents describe the shipped behavior. `bun run e2e` and the release pre-flight are green |

The release after B144 is a major version. There is no upgrade from earlier data directories, and start refuses them.

## 18. Definition of done for the feature

- **Invariants:** all ten in section 14 hold, and each has at least one test that would fail if it broke. The tests are named in the B144 PR body.
- **Day-to-day use:** an operator can:
  - run three projects on one host
  - set SES once
  - add a project in the UI without a restart
  - give an AI agent a token that works only on one project
  - see before scheduling whether a campaign fits the SES quota
  - rely on one queue that never sends faster than the SES account allows
- **Evidence:**
  - every check in `AGENTS.md`, plus `bun run contract:projects` and `bun run e2e`, passes on the merge head
  - measurements are stored
  - the design documents describe what shipped
  - `docs/status.md` lists anything left over as a backlog item with its reason

### Evidence (B144b)

Checked on `main` at 88c5328 by B144b ([D163](09-decisions.md#d163-projects-documentation-pass-and-definition-of-done-b144b-lead-2026-11-25)). Each test below exists under that file and name; `contract:projects` runs `test/projects`.

**Invariants (section 14): a test that fails if it breaks.**

| # | Invariant | Tests |
|---|---|---|
| 1 | Isolation | `test/projects/isolation.test.ts`: "A's API credential gets 401 or 403 on B's host for every route family", "A's session cookie gets 401 or 403 on B's host, and B's admin asks for a login", "B's rows never appear in A's responses, and A's never in B's", "an unclaimed host and the instance host reach only the primary project". `test/projects/bounces.test.ts`: "an extra hostname resolves, and the address fallback stays inside that project". `test/projects/capacity.test.ts`: "MCP tools/call of get_sending_capacity works with a project token and names no project" |
| 2 | One project behaves exactly as today | Every existing HTTP-level, contract and e2e suite runs unedited against the primary project, except the edits listed in each task's PR (07 lists the deliberate differences). `test/projects/instance.test.ts`: "a fresh install is an instance with one primary project, and behaves as one install" |
| 3 | At-most-once survives scheduling | `test/projects/dispatcher-crash.test.ts`: "SIGKILL mid-wait leaves unknown at most the horizon's slots plus SMTP flight; the rest is sent once", "SIGTERM mid-wait leaves no unknown row that never started; the rest is sent once". `test/tx/dispatcher.test.ts`: "a mixed batch claims transactional rows at once and marketing rows only against grants". `test/projects/shutdown-queued.test.ts`: "an orderly stop keeps a transactional send that waits for its SMTP connection queued, and sends it once after a reopen". `test/projects/delete-sending.test.ts`: "a delete waits at most 5 s for the project's send in SMTP flight, cuts no shared connection and never resends it" |
| 4 | Transactional never waits behind other work | `test/messaging/dispatcher.test.ts`: "priority and fairness: transactional first, marketing before campaign, campaigns take turns". `test/projects/guard.test.ts`: "guard, rate term: a 10,000 quota at rate 14 holds at 840 left and resumes at 841" (a synchronous transactional call goes out while the guard holds) |
| 5 | One configuration | `test/projects/settings.test.ts`: "an instance key in a project PUT is a 400 that names it, and nothing is written", "a project database holds no instance key", "the instance settings API takes the instance session and CSRF, never an API credential", "the admin's SMTP change is the one every project sends through" |
| 6 | No cross-file transactions | `test/projects/lifecycle.test.ts`: "a create that fails before its registry row leaves neither a row nor a directory", "a leftover directory is reported and never served; deleting the primary leaves none". `test/projects/admin.test.ts`: "the CLI resets the admin in the instance and every project; a restart repairs a stale copy". `test/backup/projects.test.ts`: "backup without --project holds instance.db and every project, checked as one" |
| 7 | Budgets do not multiply | `test/projects/budgets.test.ts`: "finished analytics responses of every project count against one egress budget". `test/projects/isolation.test.ts`: "the subscriber query runner's two children are one budget across projects". `test/messaging/dispatcher.test.ts`: "rate 0: grants follow class order, and reserved plus in-flight never exceeds 200" |
| 8 | No process-global state | `test/invariants/process-state.test.ts` (B149e, D168): two instances open at once in one process, each with its own data directory, clock (40 days apart), rate, SES keys and stand-in, and a project the other lacks: "each instance's routing table holds its own projects only", "each instance paces and forecasts with its own settings, SES account and clock", "data written in one instance is never seen in the other", "closing one instance leaves the other serving with its own state" (mutants: a module-level routing table, a module-level SES snapshot). `test/projects/instance.test.ts`: "a project added and removed while the instance runs is served, then answers as an unclaimed host". A module-level value that two instances never both touch is not detected by any test; review carries that part |
| 9 | No new runtime dependency | `test/invariants/runtime-dependencies.test.ts` (B149e, D168): "the runtime dependencies are exactly the design's list" (`package.json` `dependencies` against [02](02-architecture.md#dependencies)'s table; no optional, peer or bundled ones). The SigV4 signer uses Web Crypto (`test/messaging/sigv4.test.ts`, AWS's published vectors) |
| 10 | Old links keep working | `test/projects/lifecycle.test.ts`: "an extra hostname serves old unsubscribe links until it is removed" (the GET page and the RFC 8058 POST) |

**Day-to-day use: where each is done.**

| An operator can | Where |
|---|---|
| run three projects on one host | The Projects page (`/admin/instance/projects`) and the hostnames in DNS and the proxy ([operations](../operations.md#projects)); `contract:projects` runs a compiled instance with a primary and projects `a` and `b` |
| set SES once | The instance Settings page (`/admin/instance/settings`: SMTP, Performance's `messaging.max_send_rate`, Amazon SES, Bounces) or `/api/instance/settings`; a project's Settings page has none of these keys |
| add a project in the UI without a restart | Projects → New project (`POST /api/instance/projects`); `test/projects/lifecycle.test.ts` "a project created while running is served at once and sends a test from its own host" and `test/e2e/specs/projects.e2e.js` |
| give an AI agent a token that works only on one project | The project's Users page (an API user with a role), used against `https://<project host>/api/mcp`; `test/projects/isolation.test.ts` |
| see before scheduling whether a campaign fits the SES quota | The campaign page's "Fits / Over the quota" line, `GET /api/sending/capacity` and the MCP tool `get_sending_capacity`; the instance Sending page (`/admin/instance/sending`) for the next 24 hours |
| rely on one queue that never sends faster than the SES account allows | The dispatcher at the effective rate (the lower of `messaging.max_send_rate` and SES's `MaxSendRate`) and the quota guard, shown on the Sending page; `test/projects/guard.test.ts` "the effective rate is SES's MaxSendRate when it is lower than the setting, and follows a new snapshot" and `test/messaging/dispatcher.test.ts` "no double pacing: 60 s at rate 10 is 600 ± 1 starts, with no gap over two intervals" |

**Checks, measurements and documents.**

- **Checks on the merge head.** Each task ran its acceptance on its approved head; B144b's own acceptance is docs-only. `contract:projects` and `bun run e2e` on the release commit are part of the major release's gate, which runs everything again (D145).
- **Measurements** (section 16): campaign and outbox throughput in [projects-B138a](../perf/projects-B138a.md), [projects-B138b](../perf/projects-B138b.md), [projects-B139](../perf/projects-B139.md), [projects-B141](../perf/projects-B141.md) and [projects-B145b](../perf/projects-B145b.md); idle cost at 1 and 10 projects in [projects-B138b](../perf/projects-B138b.md) and for runtime-created projects in [projects-B143a](../perf/projects-B143a.md); mixed load, three projects at rate 14, in [projects-B141](../perf/projects-B141.md); the forecast in [projects-B145a](../perf/projects-B145a.md) and [projects-B143b](../perf/projects-B143b.md); backup in [projects-B144a](../perf/projects-B144a.md).
- **Documents.** README, [operations](../operations.md), [01](01-scope.md), [02](02-architecture.md), [03](03-data-model.md), [04](04-sending.md#dispatcher) and [07](07-api-and-ui.md#api-compatibility-policy) describe the shipped behaviour.
- **Left over** (in `docs/status.md`'s backlog, D163): the serve `--help` text still says the admin variables apply "only when no users exist", where they apply while `instance.db` has no admin account (D153); and the backlog items each task's merge line already lists. Invariant 9's test and invariant 8's two-instance test were added by B149e (D168).

## 19. Decided defaults and open questions

Decided here, so work is not blocked. Each can be revisited with a decision record.

- **Routing:** by hostname, not by path. Wildcard DNS makes extra projects free to add. Unclaimed hosts go to the primary project.
- **Hostnames:** a project's main hostname is fixed. Extra hostnames are added and removed explicitly.
- **Admin:** one account, copied into every project. Project login and users stay as today.
- **No import feature:** listmonk data is moved once by an agent outside the app ([section 11](#11-moving-data-from-listmonk)).
- **No upgrade from earlier iglo.email data.**
- **Transactional mail** is never delayed beyond the 2-second horizon. Only marketing and campaigns use the one-hour tolerance.
- **SES limits come from SES** (`GetAccount`), with read-only IAM credentials. The app keeps no quota counter and stores no snapshot.
- **The forecast warns and never refuses.** The guard only stops granting marketing and campaign slots while the remaining quota is under the hold line.
- **Deleted projects:** a final snapshot is kept. There is no "disable".

Open, with defaults:

1. **Weights per project in the dispatcher.** Default: equal. Add a weight only if a real project needs it.
2. **SES `SendingEnabled: false`** (the account paused by AWS). Default: shown on the Sending page and in the attention log only, because SES refuses the mail itself.
