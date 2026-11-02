// The deliberate differences from listmonk, one per row of docs/design/07-api-and-ui.md, with the
// documented operations each changes. `applies` entries select one "METHOD /path", every path that
// contains a text, `*id` (a numeric path ID) or `*secured` (every authenticated operation).
export interface Difference {
  area: string;
  summary: string;
  applies: string[];
}

export const differences: Difference[] = [
  {
    area: "Admin Content-Security-Policy (B3)",
    summary:
      "Every /admin HTML response has the D71 policy; upstream has none. Script is same-origin assets only, Alpine is its CSP build, and an appearance script is held to the same limits.",
    applies: [],
  },
  {
    area: "Remote images in the rich-text editor (B3)",
    summary:
      "Not requested until the operator asks, which reloads that campaign with ?remote_images=1 (D71). Upstream loads them on open. The stored body is unchanged.",
    applies: [],
  },
  {
    area: "Templates (M1.8 in progress)",
    summary:
      "D54 validates final stored type/candidate, preserves the old default on invalid set-default, uses literal case-insensitive name search and signed 64-bit IDs, omits the visual sample, and applies a scriptless CSP to previews.",
    applies: ["/api/templates"],
  },
  {
    area: "SQL in `query` parameters (`/api/subscribers?query=…`, `/api/subscribers/query/*`)",
    summary: "SQLite dialect, not Postgres.",
    applies: [
      "GET /api/subscribers",
      "/api/subscribers/query/",
      "GET /api/subscribers/export",
      "DELETE /api/subscribers",
      "PUT /api/subscribers/blocklist",
      "PUT /api/subscribers/lists",
    ],
  },
  {
    area: "Raw subscriber SQL safety (M1.7)",
    summary:
      "Fragments with `;`, comments, unterminated quotes or parentheses that close the wrapper are refused with 400 (upstream accepts e.g.",
    applies: ["GET /api/subscribers", "/api/subscribers/query/", "GET /api/subscribers/export"],
  },
  {
    area: "Bulk subscriber actions with webhooks (M2.6)",
    summary:
      "`PUT /api/subscribers/blocklist`, `DELETE /api/subscribers`, `PUT /api/subscribers/lists` (`unsubscribe`, or `add` with status `unsubscribed`) and `/api/subscribers/query/{delete,blocklist,lists}` return 400 with a message to narrow the selection, and write nothing, when the selection times the matching enabled…",
    applies: [
      "PUT /api/subscribers/blocklist",
      "DELETE /api/subscribers",
      "PUT /api/subscribers/lists",
      "/api/subscribers/query/",
    ],
  },
  {
    area: "Subscriber search (M1.7)",
    summary:
      "`search` matches whole words, word prefixes and e-mail addresses case-insensitively through FTS5; a substring that starts inside a word (`lice` for `Alice`) does not match.",
    applies: ["GET /api/subscribers", "GET /api/subscribers/export"],
  },
  {
    area: "Subscriber export attributes (M1.7)",
    summary:
      "A subscriber stored without attributes exports `{}`; upstream exports `null` when attributes were omitted at creation.",
    applies: ["GET /api/subscribers/export"],
  },
  {
    area: "Overflowing numeric route IDs",
    summary:
      'Positive IDs above `9223372036854775807` return HTTP 400 with `{"message":"invalid ID"}` before storage access, instead of upstream\'s saturated ID and database-error 500.',
    applies: ["*id"],
  },
  {
    area: "List IDs within signed 64-bit range but above PostgreSQL integer range",
    summary:
      "SQLite accepts these identities: a missing list GET/PUT returns 400 List not found and DELETE returns success; pinned PostgreSQL returns a database-error 500.",
    applies: ["/api/lists/{id}"],
  },
  {
    area: "Request-path normalization",
    summary:
      "Bun removes literal or encoded `.` / `..` segments and rewrites literal backslashes to slashes before routing; the canonical target determines the response.",
    applies: [],
  },
  {
    area: "Embedded static asset methods",
    summary:
      "HEAD returns the corresponding GET resource metadata without a body (200 for an existing asset, 404 for a missing one), instead of upstream's 405.",
    applies: [],
  },
  {
    area: "Explicit API credentials with a session cookie",
    summary:
      "A nonempty Authorization header selects the API identity and never falls back to the cookie on failure.",
    applies: ["*secured"],
  },
  {
    area: "Password login",
    summary:
      "Passwords keep their exact contents, including surrounding spaces, consistently with creation.",
    applies: [],
  },
  {
    area: "Cookie-backed mutations and password login",
    summary:
      "Require session-bound CSRF / pre-login nonce protection, reject foreign Origin on unsafe requests, and rate-limit password-login POSTs by transport peer IP.",
    applies: ["*secured"],
  },
  {
    area: "Initial administrator setup",
    summary:
      "Provision only from the explicit bootstrap environment pair when there are no users; no unauthenticated first-account claim form.",
    applies: [],
  },
  {
    area: "Session revocation",
    summary:
      "Disabling/deleting/changing authentication identity revokes retained sessions; re-enabling does not revive them.",
    applies: ["/api/users"],
  },
  {
    area: "Header-only API logout",
    summary:
      "Return the ordinary success envelope without claiming token revocation when no cookie session exists.",
    applies: ["POST /api/logout"],
  },
  {
    area: "Invalid user/list role on user creation or update",
    summary: "Return HTTP 400 with a safe invalid-role message before writing.",
    applies: ["POST /api/users", "PUT /api/users/{id}"],
  },
  {
    area: "Human/API account type conversion",
    summary:
      "Password-login humans require a fresh password when converted from API type; conversion to API clears the human credential and disables password login.",
    applies: ["PUT /api/users/{id}"],
  },
  {
    area: "API-user profile updates",
    summary:
      "A name-only PUT /api/profile succeeds without human email/password; supplied email/password and account-control fields cannot change its API credential or account identity.",
    applies: ["PUT /api/profile"],
  },
  {
    area: "Last human Super Admin type conversion",
    summary:
      "Reject converting the last enabled human Super Admin to API type with the existing needSuper error.",
    applies: ["PUT /api/users/{id}"],
  },
  {
    area: "Last usable administrator",
    summary:
      "An update or delete that would leave no enabled human Super Admin with password login and a password is refused with the usual `needSuper` 400.",
    applies: ["PUT /api/users/{id}", "DELETE /api/users"],
  },
  {
    area: "Partial updates to the sole human Super Admin",
    summary:
      "Omitted/zero user_role_id and omitted/empty status retain stored values before the administrator guard; a safe ordinary update succeeds.",
    applies: ["PUT /api/users/{id}"],
  },
  {
    area: "Wrong-kind role update",
    summary:
      "User/list role update routes reject a target of the other type or a child role with 400 invalid ID.",
    applies: ["PUT /api/roles/users/{id}", "PUT /api/roles/lists/{id}"],
  },
  {
    area: "Assigned-role deletion",
    summary:
      "Reject deletion of roles assigned as either user or list roles with 400 cantDeleteRole.",
    applies: ["DELETE /api/roles/{id}"],
  },
  {
    area: "Role writes with list permissions",
    summary: "Commit the parent and child permission replacement atomically.",
    applies: ["POST /api/roles/lists", "PUT /api/roles/lists/{id}"],
  },
  {
    area: "TOTP challenge and factor changes",
    summary:
      "Extend D26 nonce/Origin, peer limits, revocation and live-state rechecks through bounded single-use five-minute challenges.",
    applies: ["/api/users/{id}/twofa"],
  },
  {
    area: "Role-name search",
    summary:
      "Case-insensitive literal substring after upstream whitespace normalization; no PostgreSQL dictionary stemming or SQL wildcard expansion.",
    applies: ["GET /api/roles/users", "GET /api/roles/lists"],
  },
  {
    area: "Role error diagnostics",
    summary:
      "Keep error status and localized field/operation context, but omit submitted invalid permission strings and storage-engine details.",
    applies: ["/api/roles/"],
  },
  {
    area: "Missing/null user-role permissions",
    summary:
      "POST/PUT user-role requests return 400 Invalid fields: permissions without writing, rather than upstream's constraint-error 500; explicit [] remains valid.",
    applies: ["POST /api/roles/users", "PUT /api/roles/users/{id}"],
  },
  {
    area: "List-name query search/deletion",
    summary:
      "Use the normalized case-insensitive literal substring policy for both collection search and query deletion; no PostgreSQL dictionary stemming or wildcard expansion.",
    applies: ["GET /api/lists", "DELETE /api/lists"],
  },
  {
    area: "List description update",
    summary: "An explicitly supplied empty description clears the field; omission/null retains it.",
    applies: ["PUT /api/lists/{id}"],
  },
  {
    area: "Overlong list tags",
    summary:
      "After compatible normalization, reject tags longer than 100 Unicode characters with 400 Invalid fields: tags and no write on POST/PUT.",
    applies: ["POST /api/lists", "PUT /api/lists/{id}"],
  },
  {
    area: "XML list request resources",
    summary:
      "Keep XML writes, but reject DTD/custom/external entity declarations and nesting beyond 64 levels with safe 400 under the existing body limit.",
    applies: ["POST /api/lists", "PUT /api/lists/{id}"],
  },
  {
    area: "Read-only list input metadata",
    summary:
      "Ignore response-only and unknown fields in JSON/XML list writes; validate only the writable fields and the document/resource boundary.",
    applies: ["POST /api/lists", "PUT /api/lists/{id}"],
  },
  {
    area: "NUL in writable subscriber names or attributes",
    summary:
      "Final bound names and recursive attribute keys/string values containing U+0000 return safe HTTP 400 before any write; upstream returns database-error 500.",
    applies: ["POST /api/subscribers", "PUT /api/subscribers/{id}", "PATCH /api/subscribers/{id}"],
  },
  {
    area: "Subscriber/membership ID width",
    summary:
      "Signed-64-bit native selectors and ordinary missing results instead of PostgreSQL int32 width errors; missing create/update list IDs retain normal selection semantics.",
    applies: ["/api/subscribers"],
  },
  {
    area: "Subscriber duplicate-email update",
    summary:
      "PUT/PATCH and external PUT return safe 409 E-mail already exists. with no write, consistent with POST.",
    applies: [
      "PUT /api/subscribers/{id}",
      "PATCH /api/subscribers/{id}",
      "PUT /api/subscribers/external",
    ],
  },
  {
    area: "Duplicate subscriber membership selectors",
    summary: "Apply an explicit authorized action once per unique subscriber/list pair.",
    applies: ["PUT /api/subscribers/lists", "/api/subscribers/query/lists"],
  },
  {
    area: "Subscriber writable input",
    summary:
      "Ignore read-only/unknown metadata and validate the writable DTO; resolve PATCH omissions at commit time.",
    applies: ["POST /api/subscribers", "PUT /api/subscribers/{id}", "PATCH /api/subscribers/{id}"],
  },
  {
    area: "Single subscriber membership action",
    summary: "The path ID is sufficient; body ids need not repeat it.",
    applies: ["PUT /api/subscribers/lists/{id}"],
  },
  {
    area: "Session duration changes",
    summary:
      "New sessions capture an immutable expiry; retained/expired sessions keep their original lifetime.",
    applies: ["PUT /api/settings"],
  },
  {
    area: "NUL in final writable settings",
    summary:
      "After binding/normalization, reject NUL-bearing strings/map keys with safe 400/no write rather than upstream database-error 500.",
    applies: ["PUT /api/settings"],
  },
  {
    area: "Settings bootstrap root URL",
    summary:
      "GET projects the effective bootstrap root; full snapshot PUT ignores this read-only field and per-key mutation returns safe 400/no write.",
    applies: ["/api/settings"],
  },
  {
    area: "Per-key settings updates",
    summary:
      "Recognized writable keys receive full-candidate typed/invariant validation; unknown/read-only or invalid values fail safely without mutation.",
    applies: ["PUT /api/settings/{key}"],
  },
  {
    area: "Settings application",
    summary:
      "Supported policy changes take effect in-process; successful update envelope remains data:true.",
    applies: ["PUT /api/settings"],
  },
  {
    area: "Settings SMTP test",
    summary:
      "Authorized sends return data:[] on SMTP acceptance, safe error categories on failure, and 429 at capacity.",
    applies: ["POST /api/settings/smtp/test"],
  },
  {
    area: "Dropped update-check setting",
    summary: "Native app.check_updates stays false/no-op and cannot be enabled.",
    applies: ["/api/settings"],
  },
  {
    area: "Template bodies",
    summary: "Liquid, not Go templates.",
    applies: ["/api/templates"],
  },
  {
    area: "Template updates",
    summary:
      "Resolve omission against stored state and immutable type; explicit valid empties/null body_source clear fields; reject conflicting type and final writable NUL safely.",
    applies: ["PUT /api/templates/{id}"],
  },
  {
    area: "Template default target",
    summary: "Invalid/missing/non-campaign target fails400 without changing the current default.",
    applies: ["PUT /api/templates/{id}/default"],
  },
  {
    area: "Template search/identity",
    summary: "Normalized literal case-insensitive substring and exact native signed64-bit IDs.",
    applies: ["GET /api/templates"],
  },
  {
    area: "Template resources and lookup",
    summary:
      "Finite input/output/intermediate/work budgets and documented reviewed Liquid capabilities; bounded serialized render context, embedded own-name allowlist, no file/URL fallback.",
    applies: ["/api/templates"],
  },
  {
    area: "Template previews and diagnostics",
    summary:
      "Scriptless sandbox, no popups/forms/base navigation, inline styles/data images only; safe localized field/compile/render categories without source/data/library details.",
    applies: ["GET /api/templates/{id}/preview", "POST /api/templates/preview"],
  },
  {
    area: "Deferred visual templates",
    summary: "Reject campaign_visual writes with safe400 and omit its bootstrap sample.",
    applies: ["POST /api/templates", "PUT /api/templates/{id}"],
  },
  {
    area: "Campaign content (M3.1)",
    summary:
      "Subjects, bodies, alt bodies, `from_email` and header values are Liquid (D9); the generated opt-in body links `{{ optin_url }}`.",
    applies: ["POST /api/campaigns", "PUT /api/campaigns/{id}"],
  },
  {
    area: "Campaign search (M3.1)",
    summary:
      "`query` (collection and bulk deletion) is a literal case-insensitive substring of `name subject` (Unicode case variants, as subscriber search, so `KRAKÓW` finds `Kraków`), without PostgreSQL text-search stemming.",
    applies: ["GET /api/campaigns", "DELETE /api/campaigns"],
  },
  {
    area: "Campaign Markdown conversion (M3.1)",
    summary:
      "`POST /api/campaigns/:id/content` uses local `marked`: no goldmark automatic heading IDs or typographer.",
    applies: ["POST /api/campaigns/{id}/content"],
  },
  {
    area: "Campaign archive slug conflicts (M3.1)",
    summary:
      "A duplicate `archive_slug` on create, update or `PUT /:id/archive` returns 409 `Archive slug already exists.` with no write, instead of the database-error 500.",
    applies: ["POST /api/campaigns", "PUT /api/campaigns/{id}"],
  },
  {
    area: "Campaign JSON fields (M3.1)",
    summary:
      "`archive_meta` null or omitted keeps the stored object (upstream stores JSON `null`); a non-object is 400.",
    applies: ["POST /api/campaigns", "PUT /api/campaigns/{id}"],
  },
  {
    area: "Campaign link redirect (M3.1)",
    summary:
      "`GET /link/:linkUUID/:campUUID/:subUUID` redirects only a link registered by that campaign's own rendered content (`campaign_links`); any other registered link is a 404, also with `privacy.disable_tracking`.",
    applies: [],
  },
  {
    area: "Campaign previews (M3.1)",
    summary:
      "The scriptless sandbox CSP of template previews (D54), not upstream's `allow-scripts allow-popups`.",
    applies: ["/api/campaigns/{id}/preview", "POST /api/campaigns/{id}/text"],
  },
  {
    area: "Campaign running stats (M4.3)",
    summary:
      "`GET /api/campaigns/running/stats` lists only running campaigns the caller may read, by the collection's list scope, where upstream lists them all to anyone with `campaigns:get`.",
    applies: ["GET /api/campaigns/running/stats"],
  },
  {
    area: "Campaign test sends (M3.1)",
    summary:
      "Blocklisted subscribers are skipped (all blocklisted → `No known subscribers to test.`); the server's `email_headers` Cc/Bcc copies are not applied; at most 1,000 addresses per request and four concurrent test requests (429); all rendered parts of one message (subject, body, `from_email`, alt body, headers) share one…",
    applies: ["POST /api/campaigns/{id}/test"],
  },
  {
    area: "Campaign runner delivery (M3.2)",
    summary:
      "At-most-once: the cursor and a per-subscriber claim commit before a batch is sent; a crash skips at most that batch and logs its range.",
    applies: ["PUT /api/campaigns/{id}/status"],
  },
  {
    area: "Campaign runner notifications (M3.2)",
    summary: "No admin notification email when a campaign finishes or is paused by errors.",
    applies: ["PUT /api/campaigns/{id}/status"],
  },
  {
    area: "Public signup answers (M2.5)",
    summary:
      "`has_optin` is true whenever a requested list is double opt-in and `app.send_optin_confirmation` is on.",
    applies: ["POST /api/public/subscription"],
  },
  {
    area: "Public opt-in (M2.5)",
    summary:
      "Only a POST confirms: `GET ?confirm=true` and `app.show_optin_page=false` still show the page. A POST confirms memberships that are `unconfirmed` only, so a forged `l` can't reverse an unsubscribe. `privacy.record_optin_ip` stores the client address from D60, so `X-Forwarded-For` counts only from a configured proxy.",
    applies: [],
  },
  {
    area: "Public view and archive pages (M2.5)",
    summary:
      "`/campaign/:campUUID/:subUUID` and archive pages render without view pixel or tracked links, and are served with a scriptless sandbox CSP.",
    applies: [],
  },
  {
    area: "Public export (M2.5)",
    summary:
      "The mailed `data.json` adds `sends` (newest 1,000 journal rows, no message bodies), shown when `privacy.exportable` has `campaign_views`, and `events` (first 1,000, at most 2 MiB), shown with `link_clicks`.",
    applies: [],
  },
  {
    area: "Public opt-in mail budget (M2.5)",
    summary: "One opt-in mail per address in ten minutes, whatever its pending lists.",
    applies: ["POST /api/public/subscription"],
  },
  {
    area: "Public rate limits (M2.5)",
    summary:
      "Per client per minute, from `security.public_rate_limit`: 30 `subscribe`, 60 `optin`, 300 `unsubscribe` POSTs (one budget for the campaign and `/m/` forms; mail providers post one-click from shared addresses), 10 `privacy` (export or wipe) POSTs by default; each is 1 to 1,000,000 and applies at once.",
    applies: ["POST /api/public/subscription"],
  },
  {
    area: "Public captcha (M2.5)",
    summary:
      "ALTCHA and hCaptcha are not implemented: the ALTCHA widget and its v2 proof library are neither small nor native.",
    applies: ["GET /api/public/captcha/altcha", "POST /api/public/subscription"],
  },
  {
    area: "Public CORS (M2.5)",
    summary:
      "Origins of `security.trusted_urls` get upstream's CORS and preflight on `/api/public/*` only: same origin matching, methods and headers, no credentials.",
    applies: ["/api/public/"],
  },
  {
    area: "`POST /api/tx` response",
    summary: "Returns the created sends instead of `true`.",
    applies: ["POST /api/tx"],
  },
  {
    area: "`POST /api/tx` recipients",
    summary: "Any email address can receive a transactional email.",
    applies: ["POST /api/tx"],
  },
  {
    area: "`POST /api/tx` atomic recipients",
    summary:
      "Every recipient is resolved and rendered before any write; an unknown `subscriber_id`/`subscriber_external_id` or a render failure returns 400 with no rows and no SMTP. listmonk sends to the found recipients and then returns 400.",
    applies: ["POST /api/tx"],
  },
  {
    area: "`POST /api/tx` blocklist",
    summary:
      "Blocklisted subscribers, and addresses that belong to one in any mode, get a `skipped` row (`subscriber_blocklisted`) and no mail, also when blocklisted after queueing; blocklisted `Cc`/`Bcc` mailboxes are removed and counted (`copies_blocklisted:<n>`) while the rest send; listmonk sends to them.",
    applies: ["POST /api/tx"],
  },
  {
    area: "`POST /api/tx` bounds",
    summary:
      "At most 100 recipients, 10 files, 4 MiB of attachments and a 5 MiB request (the M2.2 payload bounds).",
    applies: ["POST /api/tx"],
  },
  {
    area: "`POST /api/tx` idempotency conflict",
    summary:
      "A reused `idempotency_key` with a different request (any field except `async`) returns 409 with no write.",
    applies: ["POST /api/tx"],
  },
  {
    area: "`POST /api/tx` Message-ID",
    summary: "A caller `Message-ID` header is replaced by the journal ID (D53).",
    applies: ["POST /api/tx"],
  },
  {
    area: "`POST /api/tx` marketing copies (M2.4)",
    summary:
      '`kind: "marketing"` with a `Cc` or `Bcc` header returns 400 with no rows and no SMTP; server `email_headers` copies are not applied to marketing sends. listmonk sends copies without checking their consent.',
    applies: ["POST /api/tx"],
  },
  {
    area: "`POST /api/tx` marketing (M2.4)",
    summary:
      '`kind: "marketing"` requires `list_id` consent (`confirmed`, or `unconfirmed` on a single opt-in list) and the `marketing.min_interval` cap, else a `skipped` row (`not_subscribed`, `unconfirmed`, `unsubscribed`, `list_unavailable`, `frequency_cap`).',
    applies: ["POST /api/tx"],
  },
  {
    area: "`POST /api/tx` tracking (M2.4)",
    summary:
      "`track_link` and `track_view` in tx templates (both kinds) produce `/m/:sendUUID` tracked links and the view pixel, following `privacy.disable_tracking` and `privacy.individual_tracking`; listmonk's tx templates have no tracking functions.",
    applies: ["POST /api/tx"],
  },
  {
    area: "`marketing.min_interval` setting",
    summary:
      "Native key in GET/PUT `/api/settings` and `PUT /api/settings/marketing.min_interval`: an ISO 8601 duration (default `P7D`, empty disables), invalid values 400 with no write.",
    applies: ["/api/settings"],
  },
  {
    area: "Analytics (M3.3)",
    summary:
      "`from` and `to` accept ISO dates and date-times with an optional offset, read as UTC; any other Postgres spelling (`Jan 1 2026`, `yesterday`) is a 400 with `analytics.invalidDates`, where upstream's 500 is for unparsable text.",
    applies: ["/analytics/", "/api/dashboard/"],
  },
  {
    area: "Maintenance (M4.6)",
    summary:
      "Deletes run as many short transactions with the event loop free between them, not one statement.",
    applies: ["/api/maintenance/"],
  },
  {
    area: "Bounces (M3.4)",
    summary:
      "`order_by=campaign_name` sorts, and `type` outside the enum matches nothing, where upstream answers 500 from a missing column and a failed cast.",
    applies: ["/api/bounces", "/bounces", "POST /webhooks/bounce"],
  },
  {
    area: "Media uploads (M3.5)",
    summary:
      "At most 25 MiB per file (the request may add 64 KiB of multipart framing) and eight uploads in progress; over these, 413 and 429 with nothing stored.",
    applies: ["POST /api/media"],
  },
  {
    area: "Media search and deletion (M3.5)",
    summary: "`query` is a literal case-insensitive substring, as campaign search.",
    applies: ["GET /api/media", "DELETE /api/media/{id}"],
  },
  {
    area: "Media storage paths (M3.5)",
    summary: "A relative `upload_path` is under the data directory, not the working directory.",
    applies: ["POST /api/media"],
  },
  {
    area: "Media serving (M3.5)",
    summary: "The extension decides the type, never the type sent at upload.",
    applies: [],
  },
  {
    area: "Media thumbnails (M3.5)",
    summary:
      "Not generated (01-scope.md). For PNG, GIF and JPEG, `thumb` and so `thumb_url` are the file itself, which renders in the admin UI; SVG as upstream; others `thumb_url: null`.",
    applies: ["/api/media"],
  },
  {
    area: "Media providers (M3.5)",
    summary:
      "Only `filesystem`. With `upload.provider: s3`, `POST /api/media` returns 400 and no file is stored or served, and a campaign with media pauses. All `upload.s3.*` settings still round-trip.",
    applies: ["POST /api/media"],
  },
  {
    area: "Campaign attachments (M3.5)",
    summary:
      "A campaign's media goes with every message, loaded for each batch through one instance-wide cache of 64 MiB by media ID, never inside a claim transaction; a pipe keeps IDs and no bytes.",
    applies: ["PUT /api/campaigns/{id}/status", "POST /api/campaigns/{id}/test"],
  },
  {
    area: "Inline images (M3.5)",
    summary:
      "`<img data-embed>` in a campaign's body and template becomes an inline part with a Content-ID and a `cid:` source in campaign and test sends, and in a transactional template, found by the file name of `src`, as upstream.",
    applies: ["POST /api/campaigns/{id}/test", "POST /api/tx"],
  },
  {
    area: "CSV import (M1.9)",
    summary:
      "`POST /api/import/subscribers` takes at most 100 MiB (the request may add 256 KiB of framing), else 413, and one upload at a time, else 400 as for a running import.",
    applies: ["/api/import/subscribers"],
  },
  {
    area: "Password reset (M4.1)",
    summary:
      "A user with TOTP continues to the factor challenge after a reset instead of being logged straight in.",
    applies: [],
  },
  {
    area: "Subscriber activity (M6.4)",
    summary:
      "`GET /api/subscribers/:id/activity` adds views and clicks of transactional and sequence sends, which upstream does not have, as rows whose campaign fields are null, and each array stops at 5,000 rows. `DELETE /api/subscribers/:id/activity/:type` clears those rows too.",
    applies: ["/api/subscribers/{id}/activity"],
  },
  {
    area: "Subscriber data export (M6.4)",
    summary:
      "`GET /api/subscribers/:id/export` adds the native sections of the mailed export: `sends` and `bounces` with `campaign_views`, `events` with `link_clicks`, under the same limits. A subscriber that does not exist is a 400 instead of upstream's 500.",
    applies: ["GET /api/subscribers/{id}/export"],
  },
  {
    area: "Dropped `GET /api/config`",
    summary:
      "404. The admin pages get what they need in the `window._LM_CONFIG` of each page, and each setting has its own API.",
    applies: [],
  },
  {
    area: "Dropped `GET /api/lang/:lang`",
    summary:
      "404. Translations are rendered on the server, and a page embeds the keys its scripts use as `window._LM_I18N`.",
    applies: [],
  },
  {
    area: "Dropped `GET /api/about`",
    summary:
      "404. Its Go runtime report and update information mean nothing for this executable: `GET /api/health` answers for liveness and `GET /api/openapi.json` names the version.",
    applies: [],
  },
  {
    area: "Dropped `GET /api/events`",
    summary:
      "404. The stream of live errors gives way to polling the sanitized `GET /api/logs`, which the logs page does.",
    applies: [],
  },
  {
    area: "Dropped features",
    summary:
      "Their endpoints return 404: `/api/admin/reload`, OIDC routes, update checks, and anything listed as dropped in Scope.",
    applies: [],
  },
];
