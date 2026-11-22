// The deliberate differences from listmonk, one per row of docs/design/07-api-and-ui.md, with the
// documented operations each changes. `applies` entries select one "METHOD /path", every path that
// contains a text, `*id` (a numeric path ID) or `*secured` (every authenticated operation).
export interface Difference {
  area: string;
  summary: string;
  applies: Array<string>;
}

export const differences: Array<Difference> = [
  {
    area: "Admin Content-Security-Policy (B3)",
    summary:
      "Every /admin HTML response has the D71 policy, and every response has `nosniff`; upstream has neither. Script is same-origin assets only, Alpine is its CSP build, and an appearance script is held to the same limits.",
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
    area: "Blocklisted subscribers (D81, B19)",
    summary:
      "Every way into blocklisted unsubscribes all memberships, and no add or confirm gives a blocklisted subscriber a live one. Upstream leaves memberships confirmed.",
    applies: [
      "PUT /api/subscribers/{id}",
      "PATCH /api/subscribers/{id}",
      "PUT /api/subscribers/lists",
      "/api/subscribers/query/lists",
    ],
  },
  {
    area: "List opt-in change (D82, B19)",
    summary:
      "A change of optin from double to single is refused with 400 while the list has unconfirmed members; single to double is allowed. Upstream changes it freely.",
    applies: ["PUT /api/lists/{id}"],
  },
  {
    area: "Archived lists on the public form (D82, B19)",
    summary:
      "The public subscription endpoints ignore archived lists; upstream subscribes to them by UUID.",
    applies: ["POST /api/public/subscription"],
  },
  {
    area: "Empty public subscription form (D119, B121)",
    summary:
      'GET /subscription/form with no public list answers 200 with the branded "No lists available to subscribe." message. Upstream answers 500, which pages the operator for a configuration state.',
    applies: [],
  },
  {
    area: "Privacy and blocklist need a paired send or campaign (D126, B123)",
    summary:
      "`/subscription/export/:subUUID` and `/subscription/wipe/:subUUID` are 404: a subscriber UUID alone reaches no privacy action. Export, wipe and blocklist act only through a send or campaign that paired the subscriber (`/m/:sendUUID/…`, `/subscription/:campUUID/…`), and an unpaired path answers 404 and writes nothing. Upstream acts on the subscriber UUID alone.",
    applies: [],
  },
  {
    area: "Suppression after a self-wipe (B124, D125)",
    summary:
      "A self-wipe leaves a keyed-hash suppression of the address and external ID. While it stands, a create or import takes no list, a public signup joins only double opt-in lists (unconfirmed, with its opt-in mail), and an event's grant answers `suppressed` and grants nothing. Only the person's own confirmation clears it, or an operator's `DELETE /api/suppressions`. A transactional sequence still starts. Upstream has no such state: the next create re-opts the person.",
    applies: [
      "POST /api/subscribers",
      "POST /api/import/subscribers",
      "POST /api/public/subscription",
    ],
  },
  {
    area: "Placeholder, transactional and view links (D126, r1)",
    summary:
      "The placeholder campaign's manage page and save change pending opt-ins only: no name, no confirmed list, no blocklist. A transactional send's manage link names its own paired send path, which manages confirmed lists and the name, and blocklist and privacy are refused there. A transactional mail carries no unsubscribe_url. View in browser answers only a subscriber the campaign was delivered to. Upstream acts on the subscriber UUID alone.",
    applies: [],
  },
  {
    area: "View pixel pairing (D126, r2)",
    summary:
      "The view pixel records a view only for a campaign the runner delivered: with individual tracking, to the subscriber it names; without it, the dummy-subscriber pixel of a campaign with any delivery, and a pixel naming a subscriber the campaign was delivered to, recorded with no subscriber. Every other request gets the same image and records nothing. Upstream counts every pixel.",
    applies: [],
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
    area: "Secrets of new settings items (B51)",
    summary:
      "A new SMTP server, bounce mailbox or messenger never takes another item's password, and a new SMTP server never takes a DKIM key from a stored item without a uuid. Upstream copies a stored password or DKIM key into any new item whose uuid is blank. Seeded SMTP and bounce defaults carry fixed uuids. B56: an SMTP server or bounce mailbox with auth none stores no password, typed or stored (upstream keeps the stored one), and so does an SMTP server with an empty auth protocol, which sends without login. A save with two items of one list sharing a uuid is refused with 400 (upstream keeps both secrets). B57: a bounce mailbox with an empty auth protocol keeps its password, since upstream's POP login runs for it.",
    applies: ["PUT /api/settings", "PUT /api/settings/{key}"],
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
      "`POST /api/campaigns/:id/content` uses Bun's built-in Markdown API (D113): no goldmark automatic heading IDs or typographer.",
    applies: ["POST /api/campaigns/{id}/content"],
  },
  {
    area: "Markdown task list markup (B106)",
    summary:
      'Task items write Bun\'s markup: `<li class="task-list-item">` and `<input type="checkbox" class="task-list-item-checkbox" disabled checked>`, where goldmark writes the checkbox without classes. The same checkbox and text.',
    applies: [
      "GET /api/campaigns/{id}/preview",
      "POST /api/campaigns/{id}/preview",
      "POST /api/campaigns/{id}/content",
      "POST /api/campaigns/{id}/test",
    ],
  },
  {
    area: "Markdown table width (B106)",
    summary:
      "A table wider than 128 columns is not a table: its rows render as a paragraph of pipes, because Bun's Markdown API recognizes at most 128 columns.",
    applies: [
      "GET /api/campaigns/{id}/preview",
      "POST /api/campaigns/{id}/preview",
      "POST /api/campaigns/{id}/content",
      "POST /api/campaigns/{id}/test",
    ],
  },
  {
    area: "Markdown table header rule (GFM, unchanged)",
    summary:
      "A table whose header row and delimiter row differ in cell count is not a table, as GFM says; goldmark builds one with an empty header cell.",
    applies: [
      "GET /api/campaigns/{id}/preview",
      "POST /api/campaigns/{id}/preview",
      "POST /api/campaigns/{id}/content",
      "POST /api/campaigns/{id}/test",
    ],
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
    area: "Markdown link titles (D111, B104)",
    summary:
      'A link title must follow whitespace, as in CommonMark and in listmonk\'s goldmark v1.8.6, so `[x](u"a b")` and `[x](u(a b))` are text, not links with a title. Deliberate difference: `[x](<u>"t")`, an angle-bracket destination glued to its title, is text here, where goldmark makes a link with a title. A glued title without whitespace inside a plain destination stays part of the URL, as before. The scan is linear per link attempt (B104); the rows affect previews, content conversion and test sends.',
    applies: [
      "GET /api/campaigns/{id}/preview",
      "POST /api/campaigns/{id}/preview",
      "POST /api/campaigns/{id}/content",
      "POST /api/campaigns/{id}/test",
    ],
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
    area: "Campaign test links (D117)",
    summary:
      "A campaign test message is untracked, with plain target links and no view pixel. Its unsubscribe, manage, `List-Unsubscribe`, message and opt-in links name the test placeholder `00000000-0000-0000-0000-000000000001`, which answers the test page and changes nothing. Upstream tracks a test's links, and its unsubscribe link acts on the recipient.",
    applies: ["POST /api/campaigns/{id}/test"],
  },
  {
    area: "Campaign test subject (D124)",
    summary:
      "A campaign test message's subject starts with `[Test] `, as a step test's does. Upstream sends the subject as given, so a test reads like a real send.",
    applies: ["POST /api/campaigns/{id}/test"],
  },
  {
    area: "Campaign runner delivery (M3.2)",
    summary:
      "At-most-once: the cursor and a per-subscriber claim commit before a batch is sent; a crash skips at most that batch and logs its range.",
    applies: ["PUT /api/campaigns/{id}/status"],
  },
  {
    area: "Campaign cancel notification (B38)",
    summary:
      "`PUT /api/campaigns/:id/status` to `cancelled` sends `campaign-status` notification to `app.notify_emails` when configured. Upstream sends no notification on manual API cancel (`cmd/campaigns.go:571`, `pipe.go:273`), mailing `cancelled` only if a cancel races the pipe's last fetch (`pipe.go:281-300`).",
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
    area: "Public captcha (B4)",
    summary:
      "ALTCHA challenges and solutions keep upstream's wire format; the HMAC key is per process, as upstream, so a restart refuses earlier challenges. The served widget is in-house (D72). An hCaptcha siteverify answer that is not a 2xx JSON `success: true` within 5 s and 64 KiB is refused; upstream accepts an unparsable one. The JSON subscription API takes no captcha, as upstream.",
    applies: ["GET /api/public/captcha/altcha"],
  },
  {
    area: "Public CORS (M2.5, B4)",
    summary:
      "Origins of `security.trusted_urls` get upstream's CORS and preflight on `/api/public/*` and the ALTCHA widget script only: same origin matching, methods and headers, no credentials.",
    applies: ["/api/public/"],
  },
  {
    area: "`POST /api/tx` response",
    summary: "Returns the created sends instead of `true`.",
    applies: ["POST /api/tx"],
  },
  {
    area: "`POST /api/tx` memory budget (B6, [D74](09-decisions.md#d74-synchronous-attachment-sends-share-a-memory-budget-event-retention-joins-the-paced-loop))",
    summary:
      "Multipart bodies and synchronous sends with attachments share a 64 MiB per-process budget; a request that finds no room within 2 seconds gets 429 with Retry-After: 1 before anything is journaled.",
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
      "`order_by=campaign_name` sorts, and `type` outside the enum matches nothing, where upstream answers 500 from a missing column and a failed cast. `POST /webhooks/service/ses` believes only the SNS topics listed in `bounce.ses_topic_arns` and records at most 50 recipients, where upstream believes any signed message. Its certificate and confirmation URLs must name a real AWS region (`sns.eu-west-1.amazonaws.com`); upstream's pattern also matches the S3 bucket host `sns.s3.amazonaws.com`. Provider webhooks have a budget of 6,000 POSTs per client per minute, apart from the public forms, so a bounce burst is not refused at 300.",
    applies: ["/api/bounces", "/bounces", "POST /webhooks/service"],
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
    summary:
      "The extension decides the type, never the type sent at upload. A JavaScript extension is `application/octet-stream`, so an upload cannot pass the admin's `script-src 'self'` (D71).",
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
      "`POST /api/import/subscribers` takes at most 100 MiB (the request may add 256 KiB of framing), else 413, and one upload at a time, else 400 as for a running import. A bad CSV that fails the import sends the `import-status` `failed` mail to `app.notify_emails` when configured: upstream's `LoadCSV` errors set `failed` without notifying (B38).",
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
    area: "Bounce action settings (B21)",
    summary:
      "`bounce.actions` refuses a `count` outside 1 to 1000 and an `action` other than `none`, `unsubscribe`, `blocklist` or `delete` with 400, where upstream stores them. Turning `password_login` off or making a user an API user clears their TOTP.",
    applies: [],
  },
  {
    area: "Inert bounce provider settings (B35, D89)",
    summary:
      "`bounce.sendgrid_enabled`, `bounce.sendgrid_key`, `bounce.postmark`, `bounce.forwardemail`, `bounce.lettermint`, `bounce.azure` and `bounce.mailboxes` are accepted and stored by the settings API for listmonk API compatibility; no effect; SES is the only provider (D89). The admin UI Bounces tab shows only Amazon SES.",
    applies: ["/api/settings"],
  },
  {
    area: "Inert admin settings (B40, D89)",
    summary:
      "`upload.s3.*`, `messengers`, `app.lang`, and the SMTP `max_msg_retries` and `msg_retry_delay` are accepted and stored by the settings API for listmonk API compatibility; no effect; no admin control (D89).",
    applies: ["/api/settings"],
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
    area: "Sort direction (`order`)",
    summary:
      "`order` takes `asc`, `ASC` or `Asc` (any case) on every endpoint that documents it. Upstream's documented `ASC` sorts descending, so a client that reads the enum gets the wrong order there.",
    applies: [
      "GET /api/lists",
      "GET /api/templates",
      "GET /api/campaigns",
      "GET /api/subscribers",
      "GET /api/users",
      "GET /api/roles/users",
      "GET /api/roles/lists",
      "GET /api/bounces",
    ],
  },
  {
    area: "Public export mail budget (D122, B125)",
    summary:
      "The data mail is throttled per subscriber, one in ten minutes, on the opt-in mail's window and allowance; a request inside the window gets the same page and sends nothing. Upstream mails on every request.",
    applies: [],
  },
  {
    area: "Personal page headers (D122, B125)",
    summary:
      "Every HTML answer under /m/, /subscription/ and /campaign/ sends no-store caching, no-referrer, X-Frame-Options DENY and frame-ancestors 'none' (merged into a page's own CSP), except the signup form at /subscription/form, which sends no-store and no-referrer only and may be framed. Upstream sends none.",
    applies: [],
  },
  {
    area: "Private webhook targets (D122, B125)",
    summary:
      "webhooks.block_private_addresses is on by default, refusing private, loopback, link-local and unique-local targets at delivery, with no redirects. An upgrade turns a stored false on once, and at every start while the block is on the log names each enabled webhook it refuses. Outbound webhooks are native.",
    applies: [],
  },
  {
    area: "Generated text alternative (D118, B120)",
    summary:
      "An HTML message with no explicit alt body is sent as multipart/alternative, with a text/plain part generated from the HTML: hidden and invisible content is dropped and links read `text <URL>`, with `<URL>` alone when the text is the URL. An explicit altbody is sent unchanged. Upstream sends the HTML part alone.",
    applies: [],
  },
  {
    area: "Public page copy (B126, D123)",
    summary:
      "The public pages say what happened: an invalid link reads 'This link is not valid.', an old link after a wipe reads 'This link has expired or the data was removed.', an unknown page is 'Page not found' with no footer, every result, error and missing page links back to app.site_url when it is set, and a disabled subscription form answers the branded 'Page not found'. The header logo links to app.site_url, else the subscription page, else nowhere. The API's messages are unchanged. Upstream names a missing record and links a logo to an empty href.",
    applies: [],
  },
  {
    area: "Wipe confirmation (B126, D123)",
    summary:
      "A wipe takes two POSTs: the first answers a confirmation page that deletes nothing, and the page's button posts confirm=true to the same path, which deletes. A wipe POST without confirm=true changes nothing. No browser dialog. Upstream deletes on the first POST behind a confirm() dialog.",
    applies: [],
  },
  {
    area: "Already unsubscribed links (B126, D123)",
    summary:
      "A marketing link revisited after the person is unsubscribed from every list it covers says so, with no form. It names only public lists, decided by membership whatever the list's type, and keeps the privacy forms and the manage link. The manage view still lists what remains. Upstream shows the unsubscribe form again.",
    applies: [],
  },
  {
    area: "Transactional link states (B126 r2, D123 item 8)",
    summary:
      "A transactional send's unsubscribe link reads its subscriber's memberships. An open opt-in gets a form that names only public lists and cancels only pending opt-ins; with no open membership it says already unsubscribed; a confirmed membership gets the manage view, or with preferences off a pointer to a marketing link. Its privacy forms act through its own paired path, and blocklist is refused. The form never offers to unsubscribe from a list the person is still on.",
    applies: [],
  },
  {
    area: "Mail branding (B126, D123)",
    summary:
      "The data mail's subject is 'Your data from <site>', with a generated text part, the site's logo or name and the wording 'the data this mailing service holds about you'. The opt-in mail is branded the same way, and the admin's system mails name the site. No mail or public page carries a product credit. Upstream uses listmonk's default look and the subject 'Your data'.",
    applies: [],
  },
  {
    area: "Brand settings and no credit (B129, D127)",
    summary:
      "appearance.brand.accent (hex only), appearance.brand.font (system-sans, system-serif, system-mono or a Google Fonts family name) and appearance.brand.header (auto, logo, name or logo_and_name) are native settings, validated when saved. The public pages apply them as custom properties, and the subscriber mails as inline styles. The public pages and the campaign and sample templates carry no 'Powered by listmonk' footer, and the admin's sidebar links the source. With no logo URL the header is the site name, never a bundled image. A new install's sender and return path are placeholders that name no product. Upstream has neither the settings nor the credit-free output.",
    applies: [],
  },
  {
    area: "Public manage link and all-lists option (B130, D128)",
    summary:
      "The unsubscribe page offers 'Manage preferences' and the manage view a preference form only when the subscriber has a public list to manage; with none, the manage view keeps the privacy actions only. privacy.allow_preferences stays the explicit switch. The public option 'Unsubscribe from all mailing lists' unsubscribes from every list and records a marketing suppression (the one a self-wipe leaves, D125), so no marketing mail and no marketing enrollment follows, while transactional mail and transactional sequence steps keep flowing. It is not a blocklist: the status stays enabled, the webhook is subscriber.unsubscribed, and the admin blocklist still stops every mail. Upstream's box blocklists the subscriber, and upstream always shows the manage link and an empty form.",
    applies: [],
  },
  {
    area: "Transactional template data carries the brand (B130, D128)",
    summary:
      "A transactional template's data, for POST /api/tx, a sequence step and their previews, carries the eight brand values a campaign's data carries (logo_url, site_name, site_url, brand_accent, brand_link, brand_on_accent, brand_font, brand_header), at the top level beside subscriber and data. They are additive: no existing key moves. Upstream's transactional data has none of them.",
    applies: ["POST /api/tx"],
  },
  {
    area: "Site URL setting (B126, D123)",
    summary:
      "app.site_url is a native setting for the operator's own site, empty by default, validated like the D107 root URL, except that a query string is allowed. The logo and back links point to it. The root URL is iglo.email's own address and cannot serve. Upstream has no such setting.",
    applies: [],
  },
  {
    area: "Dropped features",
    summary:
      "Their endpoints return 404: `/api/admin/reload`, OIDC routes, update checks, and anything listed as dropped in Scope.",
    applies: [],
  },
  {
    area: "Stable error `code` and Retry-After (B131, D129)",
    summary:
      "Every API error keeps listmonk's `message` and adds a `code` from one fixed snake_case list (`src/server/error-codes.ts`), listed per response in this document. Every 429 and 503 sends `Retry-After` in seconds, 1 s and 30 s where the route names no wait. Both are additive, so no client that reads `message` breaks. Upstream has neither.",
    applies: ["/api/"],
  },
  {
    area: "Address conflicts name the holder (B131, D129)",
    summary:
      "A write that names an e-mail another subscriber holds answers 409 `email_conflict` and writes nothing. The body names that subscriber's `conflict.external_id` only when the holder has one and the caller manages one of its lists, so a scoped caller learns nothing of a subscriber it cannot see. The event API also claims such an address for an event's external ID when its holder has no external ID and the caller manages the holder: the holder keeps its lists and history, and nothing is created. Upstream answers 409 with its message only.",
    applies: [
      "POST /api/subscribers",
      "PUT /api/subscribers/{id}",
      "PUT /api/subscribers/external",
      "PUT /api/subscribers/external/{external_id}",
      "POST /api/subscriber-events",
      "POST /api/subscriber-events/batch",
    ],
  },
];
