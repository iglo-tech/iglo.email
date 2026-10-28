# Decisions

Short records. Each one says what was decided, why, and what was considered instead. Change a decision by editing its record and noting the date.

## D1. Independent rewrite derived from listmonk v7

Decided 2026-10-27.

- **Decision:** port listmonk v7.0.0-beta.1 to TypeScript and own the result. Do not track upstream.
- **Why:** the needed features (sequences, events, transactional unsubscribe) are out of scope upstream and touch the data model, sending and admin UI, so carrying them as patches would cost more than owning the code. The stack also differs: Go and Postgres upstream, Bun and SQLite here.
- **Considered:**
  - using listmonk unchanged and building sequences in each app, which repeats the same work per app;
  - a Go fork of listmonk, which keeps Postgres and a second language;
  - a hosted lifecycle tool, ruled out because the project must be self-hosted at no subscription cost.

## D2. AGPL-3.0

- **Decision:** license iglo.email under AGPL-3.0.
- **Why:** it is a derivative work of listmonk, which is AGPL-3.0, so the license is required, not chosen. Apps that talk to iglo.email over its HTTP API are separate programs and are not affected. A modified iglo.email that serves users over a network must offer its source to them; the public repository does that.

## D3. Bun, TypeScript, one executable

- **Decision:** Bun ≥ 1.4 and TypeScript, shipped as one compiled executable. Until 1.0, the executable is the only release artifact. After 1.0, an official Docker image that wraps the same executable is added (updated 2026-10-27).
- **Why:** the same stack and release model as iglo.monitor. Bun's built-in server, SQLite, password hashing and bundler remove most of the dependencies a Node port would need. The owner runs services in containers, so an image is wanted, but it only wraps the executable and does not hold up the first release.

## D4. SQLite only

- **Decision:** `bun:sqlite`, WAL mode, one database file, one process.
- **Why:** the expected load (thousands to hundreds of thousands of subscribers, tens of messages per second) fits SQLite with batched writes. No database server to run or back up separately.
- **Considered:** keeping Postgres. Rejected, because it adds an external service for no needed capability.

## D5. Durable work is rows plus in-process loops

- **Decision:** every kind of background work (campaigns, outbox, sequences, webhooks) is a table with a status, a due time and a lease, processed by a loop in the same process.
- **Why:**
  - restarts lose nothing;
  - state can be queried and shown in the admin UI;
  - edits to sequences apply immediately;
  - no external services are needed.

  The scheduling logic is small. The value is in conditions and permissions, which no engine provides.
- **Considered:**
  - BullMQ or Redis, which needs an external service;
  - Effect Workflow, unstable APIs and replay-based versioning trouble with long waits;
  - DBOS, Workflow DevKit, Temporal, Restate, Inngest and Hatchet, which need Postgres or a separate server;
  - bunqueue, a young project with a single maintainer that solves only the queue part.

## D6. No Effect in v1

- **Decision:** plain TypeScript with small explicit helpers (retry with backoff, timeouts, resource cleanup).
- **Why:** the port translates Go code, which maps directly to plain async TypeScript. A second paradigm would make the port and its review slower. It can be revisited after 1.0 if the iglo.\* projects adopt it together.

## D7. Keep listmonk's HTTP API for ported endpoints, unless it is badly designed

Updated 2026-10-27.

- **Decision:** same paths, fields, envelope, pagination and auth by default. New features get new endpoints. Where listmonk's behavior follows from a poor design decision, fix it during the port instead of copying it. Every such fix is a deliberate difference listed in [API and admin UI](07-api-and-ui.md#api-compatibility-policy) with its reason and marked in the contract suite. A difference needs a concrete benefit for callers or for correctness, not a matter of taste.
- **Why:** existing SDKs, the n8n listmonk node and scripts keep working, and upstream can serve as the reference in contract tests. But iglo.email is owned, not tracked (D1), so carrying a bad contract forever costs more than one documented break now. Example: listmonk's `/api/tx` rejects any recipient who is not already a subscriber, so a one-off email needs a subscriber created first; iglo.email sends to any address.

## D8. Server-side TSX for the admin UI

- **Decision:** port v7's Go-template views to TSX rendered on the server with an in-house JSX runtime that escapes by default. Reuse v7's Alpine.js, Oat, CodeMirror, Squire and Chart.js assets.
- **Why:**
  - typed view props;
  - no client framework;
  - markup stays close to v7's, so its CSS, JS and Playwright tests carry over.
- **Considered:** a Vue 3 single-page app like iglo.monitor's. Rejected, because it means rewriting every screen instead of porting it.

## D9. Liquid for user-authored templates

- **Decision:** LiquidJS replaces Go `html/template` and Sprig.
- **Why:** it is sandboxed, has resource limits and is widely known. Reimplementing Go template semantics in TypeScript is not worth it, and there are no existing templates to keep compatible.

## D10. nodemailer for SMTP

- **Decision:** use nodemailer for connection pooling, MIME building, attachments and DKIM.
- **Why:** a correct SMTP client and MIME encoder is a lot of edge cases to own for no product benefit.

## D11. Sequences are data, conditions are a JSON predicate language

- **Decision:**
  - sequence definitions and enrollments live in tables;
  - conditions are `all`/`any`/`not` over `event`, `attr`, `list` predicates;
  - raw SQL is allowed as a permission-gated escape hatch.
- **Why:** safe to evaluate, easy to show and edit in a form, and compiles to one indexed query.

## D12. Marketing delivery is at-most-once

- **Decision:** a crash may skip a marketing email (send marked `unknown`, campaign batch skipped and logged). It never sends one twice. Transactional sends retry only on errors that prove the message was not accepted.
- **Why:** a duplicate marketing email harms trust and deliverability more than a missed one, and missed ones are visible in the send log.

## D13. Outbound webhooks for subscriber state

- **Decision:** signed, retried webhooks for unsubscribes, blocklisting, deletion, bounces and failed sends.
- **Why:** apps keep consent in their own database and must learn about unsubscribes. Without this, every app polls.

## D14. Bootstrap from flags and environment, everything else in settings

- **Decision:** port, host, data directory, root URL and the first admin user come from flags and environment variables. All other configuration lives in the `settings` table. No `config.toml`.
- **Why:** listmonk already keeps most configuration in the database. One source of truth per setting.

## D15. One instance per product

- **Decision:** each product runs its own iglo.email instance and database.
- **Why:** the subscriber table, `external_id`, lists, unsubscribes and the frequency cap all assume one audience. Sharing an instance across products would mix consent and IDs. An instance is one executable and one file, so running several is cheap.
- **Considered:** multi-tenant workspaces. Rejected for v1 as a large change to every table and query.

## D16. Agents do the work, the owner reviews later

Decided 2026-10-27. Model assignments updated by the owner on 2026-10-27.

- **Decision:** the port is split into tasks ([Work plan](11-work-plan.md)) that agents do one at a time. A scheduled lead (GPT-6.1 Sol at xhigh reasoning; the chief of staff, [runbook](../chief-of-staff.md)) briefs a worker per task. All implementation, fixes and mechanical work use GPT-6.1 Terra at max reasoning. Every PR is reviewed by a two-model council (Claude Opus 5.5 at medium effort and a fresh GPT-6.1 Sol at xhigh reasoning) and merges only when both approve the same commit. Claude Opus 5.5 is used only on the council. Agents decide design questions themselves and record them here as "decided by agents, for owner review". The owner is not asked for approvals.
- **Why:** the owner sets direction and is away for long stretches. Two independent reviewers and upstream as the reference catch mistakes before merge, which matters more than speed: one task at a time, a paced schedule, and a pause on usage limits instead of retries.
- **Considered:** owner approval per PR or per wave, which stalls work while the owner is away; several workers in parallel from the start, which spends the usage limit fast and multiplies conflicts in shared contracts before they are stable.

## D17. Reject positive route ID overflow before storage

Decided by agents on 2026-10-27, for owner review.

- **Decision:** positive numeric route IDs above the signed 64-bit maximum (`9223372036854775807`) return HTTP 400 with `{"message":"invalid ID"}` before storage access. This is a deliberate API difference under D7, listed in [API and admin UI](07-api-and-ui.md#api-compatibility-policy) and marked in the focused reference and HTTP fixture cases. M0.5 carries that marker into the general contract suite.
- **Evidence:** pinned upstream `cmd/handlers.go:hasID` ignores the error from `strconv.Atoi`. The live reference request `GET /api/lists/9223372036854775808` saturates to `9223372036854775807`, reaches storage, and returns a 500 exposing a Postgres integer-range error. The iglo.email ID helper rejects the original value as invalid input.
- **Why:** callers get an accurate client-error status, no database implementation details are exposed, and an invalid ID causes no unnecessary database work.
- **Considered:** reproducing the ignored conversion error and resulting database failure. Rejected because it adds no useful contract for callers and conflicts with the SQLite signed 64-bit ID boundary.

## D18. Use Bun's normalized request path

Decided by agents on 2026-10-27, for owner review.

- **Decision:** route the normalized URL supplied by `Bun.serve`. Literal and percent-encoded dot segments are removed, and literal backslashes become slashes, before application handlers see `Request.url`; the canonical target determines the response. Route middleware, including future authentication and permissions, applies to that selected target. Other escaped parameter spellings keep the default Go/Echo behavior where the runtime exposes them. Malformed percent-escape syntax that remains visible is rejected with the upstream transport's plain-text 400 response.
- **Evidence:** exact HTTP request targets `/api/lists/%2E` and `/api/lists/%2E%2E`, sent without client URL normalization, return upstream 400 `invalid ID`. Bun presents their paths to handlers as `/api/lists/` and `/api/`, which currently return the API 404 fallback. Upstream `/api/lists\1` returns JSON 404 because it retains the literal backslash; Bun rewrites it to `/api/lists/1`. The test-only `/fixture/id\12` therefore reaches ID 12 and `/fixture\items\x` reaches item x. The focused reference and normal HTTP fixture cases mark these as D18 and use an exact-target HTTP client. M0.6 additionally records exact `GET /public/static/%2e%2e/style.css`: upstream retains the static path and returns plain-text 404, while Bun exposes `/public/style.css`, which returns the public HTML 404. Both refuse the resource; the general corpus marks the reference and actual compiled-production results as D18.
- **Why:** the required transport is `Bun.serve`, which does not expose the original pre-normalization spelling to handlers. Using its canonical URL keeps routing and middleware on one interpretation and avoids owning a second HTTP transport/parser solely for noncanonical path spellings. Ordinary URL-based clients already normalize these targets.
- **Considered:** restoring the original request target in the application router. It is unavailable at that boundary. Replacing the HTTP transport or adding a raw-socket front end would violate the chosen stack and add substantial protocol code for no supported identifier use case.

## D19. Durable database primitives and module-owned lease policy

Decided by agents on 2026-10-27, for owner review.

- **Decision:** file-backed bun:sqlite connections use WAL, foreign_keys=ON, synchronous=FULL and busy_timeout=5000 ms. Write helpers use synchronous BEGIN IMMEDIATE callbacks without automatic replay; nested or async use fails clearly. Integer handling must preserve signed 64-bit IDs.
- **Why:** a committed send cursor must survive storage recovery before an external marketing send can be treated as started. [SQLite documents](https://www.sqlite.org/pragma.html#pragma_synchronous) that WAL with NORMAL can lose a commit on power loss, while FULL adds a commit sync. Prefer durability and measure its cost rather than weaken the at-most-once foundation.
- **Migrations:** validate an explicit embedded numbered catalog and apply each file and its user_version change in one transaction. Before a batch with pending migrations on a database with a prior version or user schema, save one SQLite-consistent snapshot beneath the data directory's backups folder. A snapshot failure prevents migration; a file failure retains the previous successful version. No ordinary copy of a live database file. M0.4's production catalog stays empty; M1.1 supplies the first full schema, not a placeholder migration.
- **Loop boundary:** the helper owns injected-clock waiting, lifecycle and the immediate transaction around an owning store's synchronous claim callback. The owning module owns its SQL, statuses, lease eligibility, recovery and finalization; processing runs outside the transaction. Expiry alone never authorizes a marketing retry, and the helper never automatically requeues or replays work.
- **Considered:** NORMAL for faster commits, implicit nested transactions, generic retry/requeue after expiry, a central jobs table and a dummy v1 migration. Rejected because they weaken durability or blur module ownership and delivery decisions. The bounded M0.4 measurements compare equivalent native SQLite primitives with the new helpers; sustained workload validation remains M0.7.

## D20. Separate production and fixture contract coverage until auth is ported

Decided by agents on 2026-10-27, for owner review.

- **Decision:** M0.5 runs the actually ported core corpus against upstream and the compiled production executable. Its authenticated-read and unported shared-helper cases also run against an explicit test-only normal fixture, labelled separately from production coverage. M1.3 must promote the protected read to actual production auth; later domain tasks promote their helper cases.
- **Evidence:** pinned listmonk cmd/handlers.go registers /api/health in the authenticated group and /health publicly. iglo.email intentionally has no production /api/health or auth store yet. M1.3 depends on the M0.5 harness, so requiring production auth in M0.5 would create an ordering cycle or invite a placeholder endpoint.
- **Why:** build and verify the harness's authenticated transport now without weakening the production boundary or overstating parity. Fixture auth is a tiny synthetic request gate, not the later auth implementation.
- **Coverage rules:** target/profile is explicit; reports separate production execution, fixture evidence and pending production groups. Unsupported requested production cases fail clearly, never silently skip or fall back to fixture behavior. D17/D18 retain precise reference/normal expectations; this staging is not a permanent API difference.
- **Considered:** implementing a temporary public/protected production stand-in, treating an Authorization header on public /health as proof of auth, or moving the entire harness behind M1.3. Rejected because they misstate coverage or create an avoidable dependency cycle.

## D21. Support HEAD for embedded assets

Decided by agents on 2026-10-28, for owner review.

- **Decision:** embedded `/admin/static/` and `/public/static/` assets support GET and HEAD. HEAD resolves the same manifest entry and returns its status, MIME type, cache policy and content length without the bytes. A missing resource is 404. OPTIONS returns 204, and OPTIONS/405 responses advertise `Allow: OPTIONS, GET, HEAD`.
- **Evidence:** the pinned live reference returns 405 for static HEAD (including missing files), 204 for OPTIONS, and 405 for POST. Those responses advertise `Allow: OPTIONS, GET`; its static file server is registered only with Echo GET. M0.6's initial port additionally omitted OPTIONS and Allow, which is a bug, not a policy difference.
- **Why:** callers can inspect resource existence and metadata without downloading CSS, JavaScript, images or fonts. The method advertisement matches what the server actually supports. Resolving the existing immutable asset manifest requires no additional handler side effects or filesystem discovery.
- **Contract:** HEAD status/type/body and OPTIONS/405 Allow differences are explicitly marked D21 in the shared reference/production/fixture corpus. Reference expectations preserve the real upstream responses. Ordinary non-asset HEAD behavior is unchanged.
- **Considered:** copying the GET-only framework registration and rejecting metadata-only probes. Rejected because it forces unnecessary resource downloads without providing a benefit.
