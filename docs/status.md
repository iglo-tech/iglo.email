# Status

Updated 2026-11-17. [Work plan](design/11-work-plan.md) · [Runbook](chief-of-staff.md)

## Active

All 44 plan tasks are merged. `v0.1.0` (B59 #110, tag on 1ac9f03) built, verified and pushed to GHCR by release run 42641174775 (2026-11-09); the owner published it and made the GHCR package public; the lead verified the download checksum and an anonymous pull and run of `:0.1.0` (amd64+arm64). Owner rule 2026-11-01: work continues until nothing remains that agents can do; see the [runbook](chief-of-staff.md#when-work-ends).
State-machine audit (B17–B22) and follow-ups B23–B32 (#75–#84, D86–D88) are merged; B33–B63 (#85–#114) merged: D89 scope (MCP, SES only, audit, send-rate cap, notifications, settings cleanup, deliverability docs) and the review hardening backlog. Owner widened the queue 2026-11-07 (D89). Recovery: ~/.local/state/iglo-email-cos/lock.json.
No owner items remain: phone PDF viewers need no check ([D95](design/09-decisions.md), after the owner's question). SES is the only provider (D89, B35 #87); the owner lists their SNS topic in `bounce.ses_topic_arns` (see operations.md).

## Work queue

**Resumed by the owner on 2026-11-12.** E2E plan done (B64–B71, B73–B75); release dry run 43319396254 green incl. hosted e2e (12.7 min). Owner chose a real SES check before 1.0.0; the lead ran it on 2026-11-13 with main 3074bb1 behind a temporary tunnel, SES us-east-1, test@igielski.dev: campaign sent over SES SMTP (Gmail: SPF, DKIM, DMARC pass; one-click List-Unsubscribe present), SNS subscription auto-confirmed, simulator hard bounce arrived signed via SNS and was recorded against the campaign and blocklisted the address, opens counted, no server errors. Account VDM engagement tracking rewrites links via awstrack.me (doc note in B76). All test AWS resources (IAM user and key, SNS topic, configuration set) deleted. B76 #127 merged 795e383 (r1 APPROVE); tag `v1.0.0` pushed; release run 43444099233 green (e2e 10.9 min, builds, image smoke, publish, image); lead verified the x64 download checksum and `--version` 1.0.0, and an anonymous pull and run of `:1.0.0` and `:latest` (same image, amd64+arm64). Published on the owner's instruction 2026-11-13 18:04Z (latest release; anonymous download 200).

Run in order, one at a time, through the normal stages. Write each brief from the lines below and remove a line when it merges. Decisions are never owner items (runbook): agents decide, log and continue. Owner direction 2026-11-07: [D89](design/09-decisions.md#d89-narrow-complete-product-scope-owner-2026-11-07), feature complete but not wide.

Owner goal 2026-11-09: Playwright e2e that makes 1.0.0 ready. Plan: [13-e2e-coverage.md](design/13-e2e-coverage.md) (B63 #114), one task per gap in order:
- v1.1.0 published 2026-11-13 (MCP widening, D98).
- Owner request 2026-11-16 (first adopter's integration report): B84 consent-safe list grant on events (D99, [brief](briefs/B84.md)) → B85 step event aggregates (D100, [brief](briefs/B85.md)) → B88 `number` Liquid filter (D102, [brief](briefs/B88.md), adopter follow-up) → B86 README, external-ID 404, test enrollment from an event (D101, [brief](briefs/B86.md)) → B87 version 1.2.0, tag and publish (owner authorized in the request). Runs on the owner's macOS workstation (no flock; serial roles).
- v1.2.0 published 2026-11-17 (B84–B90): tag on a469e40, release run 43993275535 green (e2e, builds, image smoke, publish, image); lead verified both checksums and `--version` 1.2.0, anonymous pull and run of `:1.2.0` (amd64+arm64), `:latest` same digest. Queue: backlog below, split by the lead 2026-11-17.
- v1.2.1 published 2026-11-17 (B91–B96): tag on ef3ed8a after the full CI/release pre-flight passed locally (e2e 457/0); release run 44047316056 green (e2e, builds, image smoke amd64+arm64, publish, image); lead verified both checksums, `--version` 1.2.1, anonymous pull and run of `:1.2.1` (amd64; arm64 in the manifest and its smoke job), `:latest` same digest. First tag on 17b945c failed a tx test race (B96), nothing published from it.
- Adopter report 2 (2026-11-17, via the integrating agent's thread; owner: decide everything, release when coherent): B97 merged (#149) → B98 merged (#150) → B99 merged (#151) → B101 merged (#152) → B102 merged (#153) → B100 merged (#154); tag `v1.3.0` on de36d91 (tree = pre-flight head c66bcbe), release run 44159976600 **failed** (x64: runner test, campaign finished 299/300 after ~27 h of fake time; arm64: media cache test; e2e passed; nothing published) → B103 merged (#155); found product defect: liquidjs wall-clock `renderLimit` (1 s) fails renders under host load, a campaign subscriber then marked failed (D110, removed in B103) → B104 merged (#156) → B105 Markdown cost model: ordinary Markdown campaigns over ~2–11 KiB refused by `reserve()` (pre-existing, major), block rescans and reflink search under-charged (D112, [brief](briefs/B105.md)); B105 merged (#157) after 3 rounds by lead decision (strictly better than main; remaining marked shapes → B106/D113 structural) → release gate on 5a20ac3 **failed**: c3e681c (direct push, Bun 1.4.5, not via Renovate/PR) leaves `scripts/release.ts` pinned to 1.4.4 and makes webhook `list_ids` serialize as a string on 1.4.5 → B107a merged (#158; revert + compiled fixture after B105; gate 10/10, full pre-flight green) → **v1.3.0 published 2026-11-19 21:44Z**: tag on 5902327, release run 44619584411 green (both builds, e2e, image smoke amd64+arm64, publish, image); lead verified both checksums, `--version` 1.3.0 on both binaries, anonymous pull and run of `:1.3.0` (`/health` true), `:latest` same digests (amd64+arm64), anonymous download 200. Adopter asked to verify on its dev instance. Adopter verified v1.3.0 2026-11-19 (8/8 pass); findings → B108 test-send trace: blocklisted 400 message, async SES bounce of a test logged via Message-ID, `get_logs` wording, proxy CIDR and `backup --verify` docs (D114, [brief](briefs/B108.md)) → B108 merged (#159) → B109 merged (#160) → **v1.3.1 published 2026-11-20**: tag on fa64c22 (tree = gated head d962ebb), release run 44652168410 green (both builds, e2e incl. first x64, image smoke amd64+arm64, publish, image); lead verified both checksums, `--version` 1.3.1 on both binaries, anonymous pull and run of `:1.3.1` (`/health` true), `:latest` same digests, anonymous download 200. Adopter recheck of v1.3.1 2026-11-20: 2a, 2b (bounce and complaint lines), 2c, 6 all PASS; follow-ups → B110 plain attention lines and Coolify network wording ([brief](briefs/B110.md)). B107 merged (#161) → B110 merged (#162) → then B106 (D113 parser). Then: B107 Bun 1.4.5 upgrade with the webhook `list_ids` root cause (via Renovate/PR), then B106 linear-time Markdown parser (D113). B107 (later): Bun 1.4.5 upgrade with the `list_ids` root cause. Then B106 replace marked with a linear-time CommonMark parser (D113, [brief](briefs/B106.md)). Common rules: [_B97-common](briefs/_B97-common.md). Runs on the owner's macOS workstation (serial roles); full checks run in a disposable Linux arm64 container (macOS fails 122 harness tests on /proc), lead decision 2026-11-17. Adopter verifies on its dev instance after release.
- **Current (2026-11-20):** v1.3.1 published and verified by the adopter. Since then merged B107 (#161, Bun 1.4.5), B110 (#162, plain attention lines), B106 (#163, `Bun.markdown`, D113). B111 merged (#164; release notes corrected after r1) → **v1.4.0 published 2026-11-20**: tag on 2283b90 (tree = gated head 318289a), release run 44709245137 green (both builds, e2e, image smoke amd64+arm64, publish, image); lead verified both checksums, `--version` 1.4.0 on both binaries, anonymous pull and run of `:1.4.0` (`/health` true), `:latest` same digests, anonymous download 200. Adopter verified v1.4.0 2026-11-20: webhook `list_ids` arrays on unsubscribed/blocklisted/deleted (incl. `[]`), one plain stderr line for a test bounce, regression flows (grants, idempotency, tx external, SES bounce linked), step preview/test all PASS; campaign Markdown N/A. Gmail end to end confirmed 2026-11-20 (`[Test]` subject, logo, untracked links after the adopter disabled SES VDM engagement tracking; checklist step 7 added to operations.md). Adopter report 2 complete. Adopter full Gmail pass of 10 sequences on 1.4.0: all render; test-send unsubscribe link 404 → B112 merged (#165) → B113 version 1.4.1: gate 10/10 and ci.yml job green, but `contract:settings:reference` failed (upstream SIGHUP restart races the next GET) → B114 merged (#166) → B113 merged (#167; release notes corrected after r1) → **v1.4.1 published 2026-11-20**: tag on 518df36, release run 44752829579 green (both builds, e2e, image smoke amd64+arm64, publish, image); lead verified both checksums, `--version` 1.4.1 on both binaries, anonymous pull and run of `:1.4.1` (`/health` true, test-send unsubscribe page 200), `:latest` same digests, anonymous download 200. Adopter verified v1.4.1 2026-11-20 (test page, manage, one-click no-op with 0 webhooks; matrix 41/0, consent 42/0, webhooks). B115 in progress. Remaining: Hardening backlog below.
- **Owner directive 2026-11-20 (via the adopter): no go-live while any known gap is open.** After v1.4.1, clear the whole Hardening backlog and both watch items; each ends fixed or as an accepted trade-off with a reason, none stays "backlog". Queue, in order, then v1.5.0:
  1. B115 merged (#168): campaign test sends are inert (reserved placeholder UUID `…0001`, untracked; D117).
  1b. B121 every public page honours the site's branding (`/m/` unsubscribe/manage/test pages render without `site`, so the default logo and no custom.css); empty public subscription form 200 not 500 ([brief](briefs/B121.md); adopter v1.4.1 finding, blocks its go-live).
  1c. B122 22 contract scripts are run by neither CI nor the release pre-flight (`contract:campaigns` fails `campaigns-status-pause` on main); run all, fix failures, wire them in, and a coverage test so scripts cannot drift again ([brief](briefs/B122.md)).
  2. B116 campaign consent skip carries a visible reason (sends journal / API), no attention line (it is normal).
  3. B117 input edges: `app.notify_emails` validated on save; root-url control characters escaped and specific wording for `host:00080`, `a.b:/c`; step preview/test revalidate permission before body validation (403 before 400).
  4. B118 test quality: restore the `disableTracking: true` cross-campaign redirect 404 check lost in B115; B108 `Bun.sleep(50)`; B110 stack test through the compiled server; B101 r1 items (document 2× `max_conns`, media cache asserts re-reads and restores the held-send check, "delivered test send logs nothing" waits for settlement, shutdown test name, runner per-message cost measured or accepted); B114 log scoping; watches: `release verify` dry-run failure, backup interrupted SIGKILL, the unattributed `toBe`.
  B118 also: under amd64 emulation (B113), timed-out test bodies keep running (bun does not abort them), so `cli.test.ts` loops hit killed children (empty stderr), and `query-limits.test.ts:53` asserts a child count the 1 s D62 deadline has already changed; make those tests abort their own work on timeout and assert the deadline outcome, not a count. Lead classified these as timeout-derived for the v1.4.1 gate (B113 PR).
  5. B119 media buffer reachable after GC under load: find the holder, fix or accept with evidence.
  Adopter 2026-11-20: bootstrap admin variables removed on its side; preview `context.trigger: null` accepted as intended; nothing from its reports open on its side.
  6. B120 generated text/plain alternative that drops hidden content and preheader padding (D118, [brief](briefs/B120.md); adopter 1.4.0 matrix finding: HTML-only mail, Mailpit's own text view showed the preheader).
- No owner items. Watch: `test/backup/interrupted.test.ts` SIGKILL case timed out once at load 13-15 on 6 cores (#144 review; passes alone; reopen on a second failure).
- Lead decided 2026-11-17 (not open work): archived lists stay grantable on events (as PUT); the event 403 names no internal ID (would leak it); native 404 punctuation kept; the test harness needs Linux /proc (D89).

## Owner decisions

[D89](design/09-decisions.md#d89-narrow-complete-product-scope-owner-2026-11-07) (owner, 2026-11-07): Linux x64+arm64 and a Docker image only; SES only; MCP template editing instead of a visual editor; no translations/OIDC now; feature complete, one way per job.
[D93](design/09-decisions.md#d93-haiku-55-replaces-gemini-as-the-worker-model-owner-2026-11-08) (owner, 2026-11-08): Claude Haiku 5.5 (effort high) workers/fixers/testers/helpers, replacing Gemini (D90); Opus 5.5 medium lead checks only; one Opus 5.5 high reviewer.
[D94](design/09-decisions.md) (agents, for owner review): sequence steps keep sending one transactional template; a step body on a campaign layout is dropped under D89.
[D68](design/09-decisions.md#d68-anthropic-models-only-opus-reviewer): Anthropic models only, no Fable; the reviewer is a fresh Opus5.5 xhigh delegate.
[D56](design/09-decisions.md#d56-owner-directed-models-review-and-local-verification): Opus5.5 medium work/lead; Haiku5.5 medium mechanical bulk only; one reviewer (Opus xhigh since D68); lead+reviewer council; fix-only later rounds; serial foreground local verification; manual-only CI.
[D57](design/09-decisions.md#d57-compatible-client-results-and-safe-input-hardening): realistic-client result compatibility; safe exotic-input response differences are backlog; formats, auth/permissions, atomicity and actual security stay mandatory.
[D67](design/09-decisions.md) (agents, for owner review): every backup carries a restore hold that stops all sending until released.
[D66](design/09-decisions.md) (agents, for owner review): authored HTML passes an allow-list before the admin editor; `style` is kept.
[D65](design/09-decisions.md) (agents, for owner review): `@playwright/test` as a dev dependency for adapted specs.
[D64](design/09-decisions.md) (agents, for owner review): the upload root must be inside the data directory; a bad root refuses media only.
[D63](design/09-decisions.md) (agents, for owner review): durable Mailgun receipts; rows no wipe reaches keep codes only.
[D62](design/09-decisions.md) (agents, for owner review): analytics reads run in a read-only helper process.
[D61](design/09-decisions.md#d61-outbound-webhook-delivery-and-privacy) (agents, for owner review): webhooks clear personal data on deletion; a public wipe keeps only numeric ID and UUID; bulk actions capped at 50,000 deliveries.
[D60](design/09-decisions.md#d60-explicit-trusted-proxies-for-client-addresses) (agents, for owner review): `security.trusted_proxies` for client addresses behind a reverse proxy, default empty.
[D59](design/09-decisions.md#d59-campaign-pacing-sleeps-only-the-rest-of-the-second) (agents, for owner review): campaign workers pace with a rolling one-second window per worker.
[D58](design/09-decisions.md#d58-stage-marketing-transactional-sends-until-m24) (agents, for owner review): tx marketing sends are journaled as skipped until M2.4.

## Automation and capacity

Schedule scheduled-task:9c337a51-67ec-4b34-adc4-9d033babc280 stays enabled and unbound. Continuous run starts2026-10-28T20:34:55.959528+00:00; no task/session cutoff.
Project default is Sonnet 5.5 medium (D73); Scheduler API has no per-task model selector; prompt/default can be aligned, separately pinned scheduler model cannot be claimed.
Host disk/memory are constrained; no protected cache/worktree/export cleanup or VM policy changes. One role verifies at a time. Healthy redundant check-ins settle only themselves.

## Done

| Task         | PR                                                     | Merge   | Result                                                                   |
| ------------ | ------------------------------------------------------ | ------- | ------------------------------------------------------------------------ |
| B115 | [#168](https://github.com/iglo-tech/iglo.email/pull/168) | be5c378 | Campaign test sends are inert: every subscriber-naming link uses a reserved placeholder campaign UUID (`…0001`; nil is live for opt-in), every route it reaches answers the test page before any lookup, untracked, no view pixel (D117; r1 APPROVE) |
| B113 | [#167](https://github.com/iglo-tech/iglo.email/pull/167) | 518df36 | Version 1.4.1; gate 10/10, both ci.yml jobs, release build, e2e 10.0 min, image smoke arm64; amd64 emulation timeouts classified (r1 CHANGES release notes only, lead corrected) |
| B114 | [#166](https://github.com/iglo-tech/iglo.email/pull/166) | 447da55 | Settings reference contract: upstream's SIGHUP 500 ms after an accepted write raced the next GET; the reference step accepts only a 500 or the refused read with the parse-error log line (mutation-checked, 20/20) (r1 APPROVE) |
| B112 | [#165](https://github.com/iglo-tech/iglo.email/pull/165) | b6ce822 | Test-send unsubscribe link (nil send UUID) opens a "test send" page on GET, form and one-click POST; reads and writes nothing, no existence oracle; real links unchanged (D116; r1 CHANGES docs split, fixer, lead-verified) |
| B111 | [#164](https://github.com/iglo-tech/iglo.email/pull/164) | 2283b90 | Version 1.4.0; release gate 10/10, full CI/release pre-flight (e2e 8.7 min, image smoke arm64); amd64 emulation 1 allowed timeout (r1 CHANGES release notes only, lead corrected the body) |
| B106 | [#163](https://github.com/iglo-tech/iglo.email/pull/163) | 452a92c | Markdown on `Bun.markdown` (CommonMark 652/652, linear; slowest 128 KiB shape 36 ms); `marked` and its patch removed; true pre-render output bound; bare-URL autolinks off (listmonk parity); fixes alt-text attribute injection; sequences e2e reload races (D113; r1 CHANGES bound, fixer, r2 APPROVE) |
| B110 | [#162](https://github.com/iglo-tech/iglo.email/pull/162) | 26d3eb8 | Attention lines: one plain stderr line and fixed `/api/logs` text through `ErrorLogger.attention`; unexpected errors keep stacks; Coolify shared-network docs (r1 CHANGES notify.ts, fixer, r2 APPROVE) |
| B107 | [#161](https://github.com/iglo-tech/iglo.email/pull/161) | 4515ac4 | Bun 1.4.5: SQLite 3.54.1 drops the JSON subtype of a subquery's `json_group_array`, so webhook `list_ids` became a string; wrapped in `json(...)`, array on every Bun; release pin and `@types/bun` 1.4.5 (D115; r1 CHANGES, fixer, r2 APPROVE) |
| B109 | [#160](https://github.com/iglo-tech/iglo.email/pull/160) | fa64c22 | Version 1.3.1; release gate 10/10, full CI/release pre-flight (e2e 9.0 min, image smoke arm64); amd64 emulation 1 allowed timeout (r1 APPROVE) |
| B108 | [#159](https://github.com/iglo-tech/iglo.email/pull/159) | dd8f98d | Test sends leave a trace: all-blocklisted step test 400 names the addresses; Message-ID recorded before send (no personal data, 7 days); an SES bounce/complaint of a test logs one attention line, records nothing; `get_logs`/MCP wording; proxy CIDR and `backup --verify` docs (D114; r1 CHANGES privacy, fixer, r2 APPROVE) |
| B107a | [#158](https://github.com/iglo-tech/iglo.email/pull/158) | 5902327 | Revert direct Bun 1.4.5 bump (release pin, webhook `list_ids` string on 1.4.5); compiled fixture aligned with B105; release gate 10/10, full CI/release pre-flight incl. e2e 457/0 (r1 APPROVE) |
| B105 | [#157](https://github.com/iglo-tech/iglo.email/pull/157) | ffddb5e | Markdown cost model: ordinary Markdown campaigns render to 64 KiB, 128 KiB post-Liquid cap, true `reserve()` bound, table/run charges (D112; r1–r3 CHANGES, merged by lead decision; remaining marked shapes → B106/D113) |
| B104 | [#156](https://github.com/iglo-tech/iglo.email/pull/156) | 1624873 | Markdown inline link-title scan linear (8 KiB `[](` 37.5 s → 39 ms; 11 families ≤68 ms at 64 KiB); glued titles with whitespace render as text like goldmark; `[x](<u>"t")` a listed difference (D111; r1 CHANGES, fixer, r2 APPROVE) |
| B103 | [#155](https://github.com/iglo-tech/iglo.email/pull/155) | e7fd58c | Wall-clock Liquid `renderLimit` removed (D110: a busy host failed campaign renders, the v1.3.0 run's 299/300); runner drive steps 0; media test counts distinct buffers (mutation-checked); send-rate failure shows state; release gate 10/10 valid arm64 (r1 CHANGES, fixer, r2 CHANGES wording, lead-verified) |
| B100 | [#154](https://github.com/iglo-tech/iglo.email/pull/154) | de36d91 | Version 1.3.0; full CI + release pre-flight green locally on arm64 (container) incl. reference job, e2e 9.9 min and image smoke; x64 not run natively (emulated: 2 timeouts), gated by the release run (r1 APPROVE) |
| B102 | [#153](https://github.com/iglo-tech/iglo.email/pull/153) | c9cfd59 | `messaging:tls` starts the host architecture's Mailpit and fails fast (arm64 pre-flight; r1 APPROVE) |
| B101 | [#152](https://github.com/iglo-tech/iglo.email/pull/152) | e5d938c | Test sends on their own SMTP pool (D109; a stalled test no longer cuts real sends); failed test sends logged and in `get_logs`; runner test bound 60 s (CPU-bound under load); media cache check after finish; agent wording (r1 APPROVE+backlog) |
| B99 | [#151](https://github.com/iglo-tech/iglo.email/pull/151) | 07e75f5 | MCP `instructions` on initialize (authoring loop, test sends checked in the inbox), `template_reference` pointers on every Liquid tool, README agent section with `.mcp.json`, REST/MCP split (D108; r1 CHANGES, fixer, r2 APPROVE) |
| B98 | [#150](https://github.com/iglo-tech/iglo.email/pull/150) | eb3c792 | Bootstrap API user/token from env (D106); root-url faults named, allow-listed `https://` suggestion, port 0 refused; one untrusted-XFF attention line; proxy/PaaS checklist and per-job API roles (D107; r1 CHANGES, fixer, r2 CHANGES, fixer, r3 APPROVE) |
| B97 | [#149](https://github.com/iglo-tech/iglo.email/pull/149) | c354bee | Step preview and test send with real or sample data, `sample` on template preview; one step-data builder shared with the scheduler (D105; r1 APPROVE+backlog, fixer, r2 APPROVE) |
| B96 | [#148](https://github.com/iglo-tech/iglo.email/pull/148) | f9e77bd | Tx tests wait for their deliveries under the fixture's dispatch stall (release-run flake; product 200 semantics confirmed) (r1 APPROVE+backlog, fixer, r2 APPROVE) |
| B95 | [#147](https://github.com/iglo-tech/iglo.email/pull/147) | 17b945c | Version 1.2.1; every CI/release step run locally first (owner rule) (r1 APPROVE) |
| B94 | [#146](https://github.com/iglo-tech/iglo.email/pull/146) | 79b6f51 | Code editors bind `$el.value`: fill/paste/search-box input no longer saves `undefined` or drops the body (6 bindings, 13 e2e cases); D104 wording (r1 CHANGES race, fixer, r2 APPROVE) |
| B93 | [#145](https://github.com/iglo-tech/iglo.email/pull/145) | 1674399 | E2E: step aggregates in the editor and the mail; Linux worst case 113.5 ms median; save→reload waits fixed (r1 CHANGES race, fixer, r2 APPROVE) |
| B92 | [#144](https://github.com/iglo-tech/iglo.email/pull/144) | f2b6d88 | CI steps green: a send shutdown cancels before it starts stays queued (D104); attachment fixture, production seed clock, arm64 `/lib64`, media test counts its own buffers (r1 APPROVE) |
| B91 | [#143](https://github.com/iglo-tech/iglo.email/pull/143) | 5906201 | `POST /api/enrollments` honours the caller's subscriber scope (unreadable = 404, no write); `fn: null` refused; B84/B86 tests (D103; r1 APPROVE) |
| B90 | [#142](https://github.com/iglo-tech/iglo.email/pull/142) | a469e40 | E2E: scheduled-campaign send_at never on a whole minute (Chrome drops `:00`; release gate flake) |
| B89 | [#141](https://github.com/iglo-tech/iglo.email/pull/141) | 7b19225 | E2E: settings accordion test waits for the stored state before reload (release gate flake) |
| B87 | [#140](https://github.com/iglo-tech/iglo.email/pull/140) | 7b21eef | Version 1.2.0; B86 regressions found by CI contract:subscribers fixed (numeric export stays 400; external rebind mid-request 404, D101) |
| B86 | [#139](https://github.com/iglo-tech/iglo.email/pull/139) | 23f3891 | README current; external-ID absent → 404; `trigger_event_id` on manual/test enroll, reschedule counts manual waits from creation (migration 21) (D101; r1 CHANGES reschedule, fixer, r2 APPROVE) |
| B88 | [#138](https://github.com/iglo-tech/iglo.email/pull/138) | d7ff8bc | `number` Liquid filter (en-US grouping, scalar, bounded); `default` unchanged, docs use `number \| default: 0` (D102; r1 CHANGES default, fixer, r2 APPROVE) |
| B85 | [#137](https://github.com/iglo-tech/iglo.email/pull/137) | b919ae8 | Step `aggregates` (count/sum/distinct over the subscriber's events) in step templates; reads at most 10,000 events per aggregate, else `aggregate_limit` skip (D100; bound by lead, r1 CHANGES, fixer, r2 APPROVE) |
| B84 | [#136](https://github.com/iglo-tech/iglo.email/pull/136) | 0f9a7a9 | `subscriber.grant_lists` on events: consent-safe grant before exit/trigger, `grants` in the response (D99; r1 CHANGES scope, fixer, r2 APPROVE) |
| B83 | [#135](https://github.com/iglo-tech/iglo.email/pull/135) | bad0ed8 | Version 1.1.0; tag v1.1.0, release run 43516269561 green; lead verified x64 checksum, `--version` 1.1.0, anonymous pull of `:1.1.0`/`:latest` (same digest, amd64+arm64); published as latest |
| B82 | [#134](https://github.com/iglo-tech/iglo.email/pull/134) | 60ebeb2 | Test: MCP default fallback when the read-back is refused (r1 APPROVE) |
| B81 | [#133](https://github.com/iglo-tech/iglo.email/pull/133) | ee33474 | B80 nits: admin sort indicator in any case, MCP template result read back, order tests for list roles and bounces, contract labels (r1 APPROVE) |
| B80 | [#132](https://github.com/iglo-tech/iglo.email/pull/132) | e9526b9 | `order` in any case on 8 endpoints (deliberate difference, contract-marked); MCP `is_default` sets the default; B79 nits (r1 APPROVE) |
| B79 | [#131](https://github.com/iglo-tech/iglo.email/pull/131) | 44d56e5 | Hand-written MCP tools take every field; `list_campaigns` sort and `send_campaign_test` template fixed; cap test catches a leaked slot (r1 APPROVE) |
| B78 | [#130](https://github.com/iglo-tech/iglo.email/pull/130) | 3dc9ca1 | MCP: 105 tools generated from the API document, 37 dangerous ops excluded with a coverage test, annotations, path-value checks, 1 MiB answer cap (D98; r1, r2 CHANGES, fixers, r3 APPROVE) |
| B77 | [#128](https://github.com/iglo-tech/iglo.email/pull/128) | df57a7d | SES note: Open/Click event destinations, `--https-policy`, VDM/FAQ refs |
| B76 | [#127](https://github.com/iglo-tech/iglo.email/pull/127) | 795e383 | Version 1.0.0; MCP serverInfo from package.json; SES engagement-tracking note; tag v1.0.0 |
| B75 | [#126](https://github.com/iglo-tech/iglo.email/pull/126) | cf329e4 | Runner wakes on start, resume and due schedule (D97); start 4.9 s to 0 on the test clock |
| B74 | [#125](https://github.com/iglo-tech/iglo.email/pull/125) | 712c2f0 | Analytics dashboard counts as digits; e2e traces kept on timeout |
| B71 | [#124](https://github.com/iglo-tech/iglo.email/pull/124) | b2998b9 | Release gate: e2e job before publish and image (D96, no retries); dashboard counts compared as digits; 3 full runs green |
| B70 | [#123](https://github.com/iglo-tech/iglo.email/pull/123) | e5e56df | E2E sequence lifecycle: re-entry, triggers, where, pause, archive, on_false, reschedule, timeline (r1 CHANGES race, fixer, r2 APPROVE) |
| B69 | [#122](https://github.com/iglo-tech/iglo.email/pull/122) | c98115e | E2E analytics from real mail events: clicks, links, bounces, unique, intervals, ranges, dashboard, individual tracking |
| B68 | [#121](https://github.com/iglo-tech/iglo.email/pull/121) | e4cf655 | E2E public archive, feed, web view, open pixel, tracked links and privacy settings |
| B67 | [#120](https://github.com/iglo-tech/iglo.email/pull/120) | 1593552 | E2E webhooks (events, signature, disabled, retry, budget, private addresses) and bounce ingress |
| B66 | [#119](https://github.com/iglo-tech/iglo.email/pull/119) | 72a29a3 | E2E operations: admin notifications, auto-pause, restore hold on a restored instance and release, GDPR export and wipe |
| B73 | [#118](https://github.com/iglo-tech/iglo.email/pull/118) | a356b13 | Consent spec: sequence exits proven to fail (frequency cap waived), form helper ticks named lists only, unsubscribe GET is safe |
| B65 | [#117](https://github.com/iglo-tech/iglo.email/pull/117) | 5712986 | E2E consent from the mail: opt-in link, unsubscribe link, one-click POST, blocklist, re-subscribe, sequence exits (12 tests) |
| B64 | [#115](https://github.com/iglo-tech/iglo.email/pull/115) | 192aee6 | E2E sending lifecycle to the sink: 9 tests (send, dedupe, pause/resume, cancel, schedule, tx, test send) |
| B72 | [#116](https://github.com/iglo-tech/iglo.email/pull/116) | e988cf7 | Runner tracked-link test: 15 s drive bound, 30 s test timeout (arm64 slack) |
| B61 | [#112](https://github.com/iglo-tech/iglo.email/pull/112) | 52fd05a | Post-release Unverified docs; 27 oxlint warnings to 0 |
| B60 | [#111](https://github.com/iglo-tech/iglo.email/pull/111) | fbe9c5e | Hostile PDF in desktop Chromium/Firefox: no origin access |
| B59 | [#110](https://github.com/iglo-tech/iglo.email/pull/110) | 1ac9f03 | Version 0.1.0; tag v0.1.0 released |
| B58 | [#109](https://github.com/iglo-tech/iglo.email/pull/109) | 14aac56 | Two micro nits (docs label, outbox wait order) |
| B57 | [#108](https://github.com/iglo-tech/iglo.email/pull/108) | 9ff7bd2 | Last nits: auth `""` SMTP-only, shared SMTP-test handler, API-based outbox wait, timings |
| B53 | [#107](https://github.com/iglo-tech/iglo.email/pull/107) | fd2e361 | Final nits sweep: 14 review-backlog items |
| B55 | [#106](https://github.com/iglo-tech/iglo.email/pull/106) | b060149 | Backup residuals: removal by dev/ino, changed-meanwhile, shared parent, failed post-publish sync keeps the old backup |
| B56 | [#105](https://github.com/iglo-tech/iglo.email/pull/105) | 9874d7f | Settings secrets: auth `none` keeps no password, duplicate uuids refused, disabled server takes a password |
| B54 | [#104](https://github.com/iglo-tech/iglo.email/pull/104) | 5a4dd18 | Test reliability: wall-bounded waits, port-safe restarts, reaping, two coverage gaps; cli SIGTERM flake attributed to the B50 port race |
| B52 | [#103](https://github.com/iglo-tech/iglo.email/pull/103) | 7ef4779 | Port bound before background loops start; a failed start claims nothing (no measurement: per-message work unchanged) |
| B51 | [#102](https://github.com/iglo-tech/iglo.email/pull/102) | 4f32b88 | New settings items never inherit another item's secret; provider template asks for the password again |
| B50 | [#101](https://github.com/iglo-tech/iglo.email/pull/101) | b57478e | Race-free test ports: shared `test/serve-port.ts` in 11 fixtures |
| B48 | [#100](https://github.com/iglo-tech/iglo.email/pull/100) | 0e70a82 | Leftovers: unused `lang` removed, contract runs skip the SNS tunnel, MCP hint names list roles |
| B46 | [#99](https://github.com/iglo-tech/iglo.email/pull/99) | 7a706fe | Bounce test polish: real settings in tx fixture, compiled upgrade test, SES compiled contract cases |
| B47 | — | D94 | Decision: steps keep transactional templates; step body on a campaign layout dropped (D89) |
| B45 | [#98](https://github.com/iglo-tech/iglo.email/pull/98) | d014479 | Backup polish: no leftover folders, clear parent errors, realpath re-check, dev/ino guard on --force |
| B44 | [#97](https://github.com/iglo-tech/iglo.email/pull/97) | d19f3dd | MCP polish: read-permission error, clear send_at, no-op step edit refused, coverage tests |
| B49 | [#96](https://github.com/iglo-tech/iglo.email/pull/96) | 028345f | `drive` bounded by 3 s wall time; fixes media test broken by B42 |
| B43 | [#95](https://github.com/iglo-tech/iglo.email/pull/95) | be0e0ab | Sending polish: 11 items from the #89/#90 reviews |
| B42 | [#94](https://github.com/iglo-tech/iglo.email/pull/94) | ead051f | Runner flake not reproduced; `drive` now fails fast with the stuck state |
| B41 | [#93](https://github.com/iglo-tech/iglo.email/pull/93) | 4b5411c | Deliverability docs: one SES path (Easy DKIM, MAIL FROM/SPF, DMARC, send rate, sandbox) |
| B40 | [#92](https://github.com/iglo-tech/iglo.email/pull/92) | 0707e37 | Inert settings controls removed (S3, Messengers, update check, SMTP retries, language); values still round-trip |
| B39 | [#91](https://github.com/iglo-tech/iglo.email/pull/91) | c850cc6 | MCP completeness: 20 tools (create_campaign, lists, media, sequences, update_sequence_step); first Haiku worker (D93) |
| B38 | [#90](https://github.com/iglo-tech/iglo.email/pull/90) | 0803f41 | Admin notification mails (campaign finished/cancelled/auto-paused, import finished/failed) |
| B37 | [#89](https://github.com/iglo-tech/iglo.email/pull/89) | e7af5ed | Shared SES send-rate cap `messaging.max_send_rate` (D92), outbox priority |
| B36 | [#88](https://github.com/iglo-tech/iglo.email/pull/88) | 2774f53 | Completeness audit ([12-completeness-audit.md](design/12-completeness-audit.md)); B37–B41 queued, drops in D89 |
| B35 | [#87](https://github.com/iglo-tech/iglo.email/pull/87) | 2ae7e56 | SES only: Mailgun removed (migration 0019), inert providers hidden; receipts kept for SNS |
| B34 | [#86](https://github.com/iglo-tech/iglo.email/pull/86) | 464474c | MCP endpoint `/api/mcp`, 14 tools, agent template reference (D91) |
| B33          | [#85](https://github.com/iglo-tech/iglo.email/pull/85) | 46ee9f4 | linux-arm64 + multi-arch GHCR image; VmRSS watchdogs; backup makes parents |
| B32          | [#84](https://github.com/iglo-tech/iglo.email/pull/84) | 3158880 | Settings fold map and row-identical cache; event p95 about 58 to 33 ms   |
| B31          | [#83](https://github.com/iglo-tech/iglo.email/pull/83) | c964261 | D88: event tail is commit fsync plus `settings.read()` CPU; opt-in probe |
| B30          | [#82](https://github.com/iglo-tech/iglo.email/pull/82) | 2565852 | Migration 18 TOTP test that fails without the fix                        |
| B29          | [#81](https://github.com/iglo-tech/iglo.email/pull/81) | eb5ff4c | Post-pool sync throw is `unknown`; migration 18 skips non-object rules   |
| B28          | [#80](https://github.com/iglo-tech/iglo.email/pull/80) | 5b8e3d7 | 40 x 4 MiB tx burst 265-302 to 212-254 MiB; three copies released        |
| B27          | [#79](https://github.com/iglo-tech/iglo.email/pull/79) | 97d92b7 | Six intermittent lines closed (70 runs, 0 failures); serial harness      |
| B26          | [#78](https://github.com/iglo-tech/iglo.email/pull/78) | cc7f009 | D87: base64 decode 147 to 16 MiB; 128 MiB measured tx budget             |
| B25          | [#77](https://github.com/iglo-tech/iglo.email/pull/77) | 645b901 | D86: keep `synchronous = FULL` (second-send and lost-ack risk)           |
| B24          | [#76](https://github.com/iglo-tech/iglo.email/pull/76) | 66e7003 | OpenAPI path types; migration 18 (bounce `count: 0`, stale TOTP)         |
| B23          | [#75](https://github.com/iglo-tech/iglo.email/pull/75) | f559d00 | Unsent push not `unknown`; live pushes keep their lease (D80)            |
| B16          | [#67](https://github.com/iglo-tech/iglo.email/pull/67) | 2511c76 | Click on a linked banner keeps visible spaces (D79)                      |
| B15          | [#66](https://github.com/iglo-tech/iglo.email/pull/66) | cfd6798 | Banner Backspace, `<br>` cleanup narrowed to banners (D79)               |
| B14          | [#65](https://github.com/iglo-tech/iglo.email/pull/65) | 1d7a72f | Linked held-image caret rule (D79), Backspace and click tests            |
| B13          | [#64](https://github.com/iglo-tech/iglo.email/pull/64) | c0536b9 | Held-image caret (D79); flaky tests diagnosed, not reproduced            |
| B12          | [#63](https://github.com/iglo-tech/iglo.email/pull/63) | 9b10ec6 | Build lock, no-undef, editor fixes, bounded tx overtaking (D78)          |
| B11          | [#62](https://github.com/iglo-tech/iglo.email/pull/62) | 8d28d54 | Event latency measured; D22 and process model left to owner (D77)        |
| E2e speed    | [#61](https://github.com/iglo-tech/iglo.email/pull/61) | 8aeb257 | Parallel e2e stacks, default 2 (17→~10 min)                              |
| Test speed   | [#60](https://github.com/iglo-tech/iglo.email/pull/60) | 893c85f | Parallel `bun run test`, one build, `bun check` (547→~145 s)             |
| B10          | [#59](https://github.com/iglo-tech/iglo.email/pull/59) | edcebf7 | Backlog defects; lead decided after round 3 (held styles)                |
| B8           | [#58](https://github.com/iglo-tech/iglo.email/pull/58) | ae83f35 | Intermittent fixes, contract and lock tests, settings ref fixed          |
| B7           | [#57](https://github.com/iglo-tech/iglo.email/pull/57) | fb7ea5a | Analytics egress budget, WAL gap, disk-staged selections                 |
| B9           | [#56](https://github.com/iglo-tech/iglo.email/pull/56) | 6669094 | SES/SNS bounces, topic allowlist (D75)                                   |
| B6           | [#55](https://github.com/iglo-tech/iglo.email/pull/55) | 33d8e65 | Tx attachment budget, finishAll tests, paced events (D74)                |
| B5           | [#54](https://github.com/iglo-tech/iglo.email/pull/54) | 92c5d90 | Reschedule, live condition validation, activity tab                      |
| B4           | [#53](https://github.com/iglo-tech/iglo.email/pull/53) | 785594f | ALTCHA and hCaptcha on public forms (D72)                                |
| B3           | [#52](https://github.com/iglo-tech/iglo.email/pull/52) | 5dfea64 | Admin CSP, nosniff, editor containment (D71)                             |
| B2           | [#51](https://github.com/iglo-tech/iglo.email/pull/51) | c4a24a5 | Retention of sessions, webhook rows and send bodies (D70)                |
| B1           | [#50](https://github.com/iglo-tech/iglo.email/pull/50) | 07e3ace | One process per data directory (D69)                                     |
| M6.3         | [#48](https://github.com/iglo-tech/iglo.email/pull/48) | 2013ada | Release workflow, version, verification, packaging                       |
| M6.4         | [#49](https://github.com/iglo-tech/iglo.email/pull/49) | 21e5bea | OpenAPI, subscriber export and activity routes                           |
| M6.2         | [#47](https://github.com/iglo-tech/iglo.email/pull/47) | e191856 | Backup, restore hold (D67), reset-password, operations guide             |
| M5.5         | [#45](https://github.com/iglo-tech/iglo.email/pull/45) | 25bf1f4 | Sequence screens, subscriber tabs, test mode                             |
| M4.6         | [#44](https://github.com/iglo-tech/iglo.email/pull/44) | bbb6570 | Analytics, maintenance, logs; log buffer holds safe fields               |
| M4.5         | [#43](https://github.com/iglo-tech/iglo.email/pull/43) | 6481e54 | Bounces, media, import, forms screens                                    |
| M4.4         | [#42](https://github.com/iglo-tech/iglo.email/pull/42) | 39e710c | Settings, users, roles, profile; usable last admin                       |
| M4.3         | [#41](https://github.com/iglo-tech/iglo.email/pull/41) | e54fe8c | Templates and campaigns screens; HTML allow-list D66                     |
| M4.2         | [#40](https://github.com/iglo-tech/iglo.email/pull/40) | b7ab730 | Subscribers and lists screens                                            |
| M4.1         | [#39](https://github.com/iglo-tech/iglo.email/pull/39) | 68defb0 | Admin shell, auth screens, dashboard, e2e harness; D65                   |
| M1.9         | [#38](https://github.com/iglo-tech/iglo.email/pull/38) | 7a21684 | CSV import; log holds no personal data; D61 revised                      |
| M3.5         | [#37](https://github.com/iglo-tech/iglo.email/pull/37) | 8b38fba | Media, attachments, data-embed; storage boundary D64                     |
| M3.4         | [#36](https://github.com/iglo-tech/iglo.email/pull/36) | 6375f5c | Bounces, actions, signed Mailgun webhook; D63                            |
| M3.3         | [#35](https://github.com/iglo-tech/iglo.email/pull/35) | a69abd7 | Analytics through a killable read-only child process (D62)               |
| M2.6         | [#34](https://github.com/iglo-tech/iglo.email/pull/34) | 3b99900 | Signed outbound webhooks; wipe clears personal data                      |
| M5.4         | [#25](https://github.com/iglo-tech/iglo.email/pull/25) | b934fb2 | Sequence scheduler                                                       |
| Test hygiene | [#24](https://github.com/iglo-tech/iglo.email/pull/24) | a74c4c9 | Ignore host loopback port probes (lead-merged, test-only)                |
| M5.3         | [#23](https://github.com/iglo-tech/iglo.email/pull/23) | 8bd33f6 | Sequences and enrollments                                                |
| M5.2         | [#22](https://github.com/iglo-tech/iglo.email/pull/22) | 8b328c8 | Sequence conditions                                                      |
| M1.7         | [#21](https://github.com/iglo-tech/iglo.email/pull/21) | 0d40045 | Subscriber query/search/export                                           |
| M5.1         | [#20](https://github.com/iglo-tech/iglo.email/pull/20) | 4232631 | Subscriber events API                                                    |
| M2.4         | [#19](https://github.com/iglo-tech/iglo.email/pull/19) | 5368d30 | Unsubscribe/cap/tracking                                                 |
| M2.3         | [#18](https://github.com/iglo-tech/iglo.email/pull/18) | 7a56cb7 | Transactional API                                                        |
| M1.8         | [#17](https://github.com/iglo-tech/iglo.email/pull/17) | 17eaf1c | Templates/bounded Liquid                                                 |
| M2.2         | [#16](https://github.com/iglo-tech/iglo.email/pull/16) | 4328bf0 | Durable journal/outbox                                                   |
| M2.1         | [#15](https://github.com/iglo-tech/iglo.email/pull/15) | 542bf92 | SMTP/outcomes                                                            |
| M1.2         | [#14](https://github.com/iglo-tech/iglo.email/pull/14) | 043973d | Settings/session lifetime                                                |
| M1.6         | [#13](https://github.com/iglo-tech/iglo.email/pull/13) | 7764c13 | Subscribers/external IDs                                                 |
| M1.5         | [#12](https://github.com/iglo-tech/iglo.email/pull/12) | da66ca0 | Lists CRUD/counts                                                        |
| M1.4         | [#11](https://github.com/iglo-tech/iglo.email/pull/11) | b60a0e8 | Roles/TOTP                                                               |
| M1.3         | [#10](https://github.com/iglo-tech/iglo.email/pull/10) | 76122c0 | Users/authentication                                                     |
| M1.1         | [#9](https://github.com/iglo-tech/iglo.email/pull/9)   | 34a246f | v1 schema                                                                |
| M0.8         | [#8](https://github.com/iglo-tech/iglo.email/pull/8)   | 5c048d1 | SMTP/Liquid spikes                                                       |
| M0.7         | [#7](https://github.com/iglo-tech/iglo.email/pull/7)   | 8a0b3bf | SQLite load spike                                                        |
| M0.6         | [#6](https://github.com/iglo-tech/iglo.email/pull/6)   | 986e3ed | JSX/page shell/assets                                                    |
| M0.5         | [#5](https://github.com/iglo-tech/iglo.email/pull/5)   | 1147650 | Contract suite                                                           |
| M0.4         | [#4](https://github.com/iglo-tech/iglo.email/pull/4)   | a988c62 | SQLite and loop primitives                                               |
| M0.3         | [#3](https://github.com/iglo-tech/iglo.email/pull/3)   | cb41fd6 | HTTP/app contracts                                                       |
| M0.2         | [#2](https://github.com/iglo-tech/iglo.email/pull/2)   | 2946b45 | Pinned reference harness                                                 |
| M0.1         | [#1](https://github.com/iglo-tech/iglo.email/pull/1)   | 7dffb86 | Skeleton                                                                 |

## Hardening backlog

- B114: `invalidSettingsReadEnd` searches the whole reference log; record the log size before the write and search only after it (optional hardening, B114 review).

- Campaign test sends link the real campaign and subscriber UUIDs (and one-click headers when `privacy.unsubscribe_header` is on), so clicking Unsubscribe in a campaign test mail unsubscribes that real subscriber and fires the webhook (B112 review). Predates B112; check against pinned listmonk before deciding.

- Settings: `app.notify_emails` is saved without address validation (B110 review); invalid entries are skipped at send time with an attention line.
- B110 tests: the "unexpected error keeps its stack" case checks the logger directly, not a handler on the compiled server.

- B108 tests: the two record-failure 500 tests use `Bun.sleep(50)` to show nothing was sent (AGENTS: no sleeping; wait on the sink/clock instead) and would not catch a single leaked in-flight slot.

- Campaign consent skip is journaled `skipped` with no reason or log line and is not visible in the product (B103 fault injection).
- Media: under parallel load one extra campaign attachment buffer stays reachable after GC; holder unidentified (product cache keeps only the newest in isolation; B103).

- B101 r1: a server can see up to 2× `max_conns` (real + test pool), document in D109/operations; media cache test should assert re-reads directly and restore the held-send check once the 1-in-6 failure is explained; "delivered test send logs nothing" tests do not await settlement; shutdown test name; runner ~9 ms/message product cost.
- Watch: `release verify > passes on a tag that matches and on a dry run` failed once in 6 extra runs (B101 review; passes in check).

- Root-url message prints control characters of a path raw; `host:00080` and `a.b:/c` get generic wording (B98 r3, operator's own env).

- Step preview/test: a body both invalid and revoked mid-upload answers 400 rather than 403 (B97 r2; nothing read or sent).

- New safe exotic-response differences go here by PR link; actual safety/auth/data defects never become backlog merely by relabelling.

## Accepted trade-offs

- GET-then-PUT lost update in MCP read-modify-write tools and the admin UI (#86, #91): two concurrent edits of one campaign or sequence can overwrite each other. Endpoints have no version check; the agent or admin re-reads before a change it depends on (D91). A version column is not worth it for a single-owner instance (lead, 2026-11-08).

- A hand-typed host change on a saved SMTP server keeps its stored password (lead, B51 #102): editing a host is deliberate, only `settings:manage` admins can, and upstream does the same. A provider template, which swaps the host as a side effect, clears it instead.

- Enrollment listing and delete show numeric subscriber IDs outside the caller's lists (lead, B91 #143): IDs only, no address; a sequence manager needs the whole progress of its sequence. D103 revisit.

Decided by agents and logged; not open work. Reopen only on a new failure or a new realistic client.

- Role numeric JSON IDs above JavaScript safe integer range: safe rejection remains (D34). B10 left it: IDs are allocated from 1 by AUTOINCREMENT, so a list ID above 9007199254740991 needs about 9e15 inserts and exists only when a test advances the allocator; a lossless parse of numeric JSON would touch every JSON body reader for no realistic client.
- Paced event retention drains about 380 rows/s (the price of not holding back sends, [D74](design/09-decisions.md#d74-synchronous-attachment-sends-share-a-memory-budget-event-retention-joins-the-paced-loop)).
- B7 staging ([#57](https://github.com/iglo-tech/iglo.email/pull/57)): a read queued during a forced WAL gap can wait the full 30 s and get 429 (the gap is D62's price for restarting the WAL under continuous polling; a long read holds it open, and an earlier admission would block the checkpoint); analytics responses over 64 KiB are chunked with no Content-Length (B10 tried an explicit header: Bun ignores it on streamed bodies, and sending the bytes whole would drop the egress accounting that releases when the client has read them).
- Wiped sends ([#74](https://github.com/iglo-tech/iglo.email/pull/74)): D85 also silences `send.failed` for admin deletes without a wipe.
- Event latency tail: commit fsync waits only after B32 ([evidence](perf/B31-event-tail.md), [D88](design/09-decisions.md)); D86 accepts them and keeps FULL.
- Settings fold map ([#84](https://github.com/iglo-tech/iglo.email/pull/84)): a module-level `WeakMap` memo over the static shapes, filled on first use, instead of a load-time constant; it holds only derived constants.
- Tx burst ([#80](https://github.com/iglo-tech/iglo.email/pull/80)): 40 x 4 MiB gated peaks 212-254 MiB against D87's 256 MiB, a thin margin; if a later run exceeds it, lower `MAX_ATTACHMENT_SENDS` or the budget (do not re-measure until a run passes). The gate still charges for the copies B28 releases (stricter than needed, safe).
