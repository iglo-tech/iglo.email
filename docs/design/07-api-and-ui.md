# API and admin UI

## API compatibility policy

The listmonk HTTP API is worth keeping where it is sound: there are SDKs, an n8n node and scripts written against it. Compatibility is the default, not a goal in itself. When listmonk's behavior comes from a poor design decision and makes the API awkward or wrong for its callers, iglo.email fixes it in the port instead of copying it. Each such fix is a deliberate difference: listed below with its reason, and marked in the contract suite.

For every **ported** endpoint, unless a difference below says otherwise, iglo.email keeps:

- the path and method;
- request field names and types;
- the `{ "data": … }` response envelope and `{ "message": "…" }` errors;
- pagination (`page`, `per_page`, `per_page=all`), with `total`, `per_page` and `page` in responses;
- authentication: `Authorization: token <api_user>:<token>` and HTTP Basic auth.

Deliberate differences:

| Area | Difference | Why |
|---|---|---|
| SQL in `query` parameters (`/api/subscribers?query=…`, `/api/subscribers/query/*`) | SQLite dialect, not Postgres | Different database |
| Overflowing numeric route IDs | Positive IDs above `9223372036854775807` return HTTP 400 with `{"message":"invalid ID"}` before storage access, instead of upstream's saturated ID and database-error 500 | Invalid input should be a client error; avoid exposing database internals or issuing a query for an unrepresentable ID ([D17](09-decisions.md#d17-reject-positive-route-id-overflow-before-storage)) |
| List IDs within signed 64-bit range but above PostgreSQL integer range | SQLite accepts these identities: a missing list GET/PUT returns 400 List not found and DELETE returns success; pinned PostgreSQL returns a database-error 500 | The storage engine supports 64-bit identities, and valid SQLite identities should not be artificially capped at PostgreSQL integer width. Paired cases record the exact behavior; accepted under [D34](09-decisions.md#d34-native-list-identity-width-and-the-separate-role-input-limit). The existing role-child JSON input still rejects IDs above JavaScript's safe integer range. D17 handles values beyond signed 64-bit range |
| Request-path normalization | Bun removes literal or encoded `.` / `..` segments and rewrites literal backslashes to slashes before routing; the canonical target determines the response. In the shared-contract fixture, `/api/lists/%2E` and `/api/lists/%2E%2E` reach the API fallback rather than upstream's 400 `invalid ID`, and `/fixture/id\12` reaches ID 12 where upstream treats the backslash as a literal segment character. Exact `/public/static/%2e%2e/style.css` leaves the static prefix after Bun normalization and returns the public HTML 404 instead of upstream's plain-text static 404; both refuse the resource | Keep the required `Bun.serve` transport and one URL interpretation for routing and route middleware, rather than introduce a second HTTP parser for spellings the runtime does not expose ([D18](09-decisions.md#d18-use-buns-normalized-request-path)) |
| Embedded static asset methods | HEAD returns the corresponding GET resource metadata without a body (200 for an existing asset, 404 for a missing one), instead of upstream's 405. OPTIONS and 405 responses advertise `OPTIONS, GET, HEAD`, while upstream advertises `OPTIONS, GET` | Inspect existence/type/size/cache metadata without downloading resources; advertise the methods actually implemented ([D21](09-decisions.md#d21-support-head-for-embedded-assets)) |
| Explicit API credentials with a session cookie | A nonempty Authorization header selects the API identity and never falls back to the cookie on failure | The upstream v3 compatibility shim ignores explicit credentials whenever a session cookie is present; stale cookies must not break API calls or silently select another principal ([D26](09-decisions.md#d26-authentication-bootstrap-and-credential-boundaries)) |
| Password login | Passwords keep their exact contents, including surrounding spaces, consistently with creation | Upstream stores the created password unchanged but trims login input, so accepted passwords can become unusable (D26) |
| Cookie-backed mutations and password login | Require session-bound CSRF / pre-login nonce protection, reject foreign Origin on unsafe requests, and rate-limit password-login POSTs by transport peer IP | Enforce the security boundary required by this design; Basic/token clients remain supported without cookie CSRF tokens (D26) |
| Initial administrator setup | Provision only from the explicit bootstrap environment pair when there are no users; no unauthenticated first-account claim form | Follow D14, keep first-account ownership at the server and preserve existing users (D26) |
| Session revocation | Disabling/deleting/changing authentication identity revokes retained sessions; re-enabling does not revive them | A previously issued session must not regain access after an account is disabled and later restored (D26) |
| Header-only API logout | Return the ordinary success envelope without claiming token revocation when no cookie session exists | Avoid upstream's cookie-session dereference failure for an otherwise authenticated API call (D26) |
| Invalid user/list role on user creation or update | Return HTTP 400 with a safe invalid-role message before writing | The reference API-user failure returns a database error containing the generated token digest; client validation must not disclose credential material ([D27](09-decisions.md#d27-safe-user-role-validation-and-credential-type-changes)) |
| Human/API account type conversion | Password-login humans require a fresh password when converted from API type; conversion to API clears the human credential and disables password login | Argon2id password hashes and SHA-256 token digests serve distinct authentication paths and must not be retained as one another; no token-rotation endpoint is added (D27) |
| API-user profile updates | A name-only PUT /api/profile succeeds without human email/password; supplied email/password and account-control fields cannot change its API credential or account identity | Upstream projects any stored credential as password login, requires an irrelevant email and can overwrite an API digest with a human password hash; display-name updates must keep credential types separate ([D28](09-decisions.md#d28-api-profile-updates-and-preserving-a-human-administrator)) |
| Last human Super Admin type conversion | Reject converting the last enabled human Super Admin to API type with the existing needSuper error | Upstream's update guard checks replacement role/status but omits type, allowing the last human administrator to disappear; preserve a usable human administration path (D28) |
| Partial updates to the sole human Super Admin | Omitted/zero user_role_id and omitted/empty status retain stored values before the administrator guard; a safe ordinary update succeeds | Upstream tests raw defaults and returns needSuper even though its SET expressions would preserve the same authority. Callers should not have to resend unchanged role/status fields; explicit removal of the final human administrator remains rejected ([D29](09-decisions.md#d29-apply-the-administrator-guard-to-the-resulting-account-state)) |
| Wrong-kind role update | User/list role update routes reject a target of the other type or a child role with 400 invalid ID | Prevent cross-kind permission changes; upstream update-role omits the type check ([D30](09-decisions.md#d30-role-mutations-and-the-totp-authentication-boundary)) |
| Assigned-role deletion | Reject deletion of roles assigned as either user or list roles with 400 cantDeleteRole | Avoid the upstream list-role cascade deleting users and potentially the final human administrator (D30) |
| Role writes with list permissions | Commit the parent and child permission replacement atomically | Invalid child entries must not leave a partial role or changed authority (D30) |
| TOTP challenge and factor changes | Extend D26 nonce/Origin, peer limits, revocation and live-state rechecks through bounded single-use five-minute challenges | Prevent second-factor guessing or completion after account/credential/factor revocation; no authenticated session before both factors (D30) |
| Role-name search | Case-insensitive literal substring after upstream whitespace normalization; no PostgreSQL dictionary stemming or SQL wildcard expansion | Predictable punctuation and language-independent label matching without database text-search configuration; concrete shared expectations required ([D31](09-decisions.md#d31-literal-role-name-search-and-safe-role-diagnostics)) |
| Role error diagnostics | Keep error status and localized field/operation context, but omit submitted invalid permission strings and storage-engine details | Identify the bad field or operation without reflecting pasted secrets or database internals (D31) |
| Missing/null user-role permissions | POST/PUT user-role requests return 400 Invalid fields: permissions without writing, rather than upstream's constraint-error 500; explicit [] remains valid | Prevent a missing replacement from silently revoking grants and identify incomplete client input safely ([D32](09-decisions.md#d32-require-explicit-user-role-permission-replacement)) |
| List-name query search/deletion | Use the normalized case-insensitive literal substring policy for both collection search and query deletion; no PostgreSQL dictionary stemming or wildcard expansion | Predictable name selection and identical read/delete predicates ([D33](09-decisions.md#d33-list-name-search-explicit-description-clearing-and-owner-boundaries)) |
| List description update | An explicitly supplied empty description clears the field; omission/null retains it | Upstream's CASE expression cannot remove previously stored text (D33) |
| Overlong list tags | After compatible normalization, reject tags longer than 100 Unicode characters with 400 Invalid fields: tags and no write on POST/PUT | Avoid upstream POST storage-error 500 and PUT silent truncation ([D35](09-decisions.md#d35-list-request-decoding-and-tag-bounds)) |
| XML list request resources | Keep XML writes, but reject DTD/custom/external entity declarations and nesting beyond 64 levels with safe 400 under the existing body limit | Bound parsing without external resolution or entity expansion (D35) |
| Read-only list input metadata | Ignore response-only and unknown fields in JSON/XML list writes; validate only the writable fields and the document/resource boundary | Accept list snapshots without incidental Go read-model date/map/int validation; discarded fields cannot assign identity, generated metadata or authority ([D36](09-decisions.md#d36-list-writes-accept-only-writable-fields)) |
| NUL in writable subscriber names or attributes | Final bound names and recursive attribute keys/string values containing U+0000 return safe HTTP 400 before any write; upstream returns database-error 500 | Predictable validation and unchanged subscriber/membership state; avoid storing text that native consumers can truncate or reject. Discarded metadata and overwritten values absent from final writable input are unaffected ([D43](09-decisions.md#d43-reject-nul-in-writable-subscriber-names-and-attributes)) |
| Subscriber/membership ID width | Signed-64-bit native selectors and ordinary missing results instead of PostgreSQL int32 width errors; missing create/update list IDs retain normal selection semantics | Native SQLite identities must stay exact and usable; paired cases distinguish successful writable changes from upstream errors ([D40](09-decisions.md#d40-native-subscriber-and-membership-selector-width)). D34 role-child JSON limit remains |
| Subscriber duplicate-email update | PUT/PATCH and external PUT return safe 409 E-mail already exists. with no write, consistent with POST | Avoid fabricated PostgreSQL constraint/SQLSTATE diagnostics for a predictable conflict ([D41](09-decisions.md#d41-subscriber-conflicts-and-duplicate-bulk-selectors)) |
| Duplicate subscriber membership selectors | Apply an explicit authorized action once per unique subscriber/list pair | Repeated selectors need not cause PostgreSQL duplicate-tuple 500/no write; precise paired state tests are required (D41) |
| Subscriber writable input | Ignore read-only/unknown metadata and validate the writable DTO; resolve PATCH omissions at commit time | Avoid incidental model validators and lost concurrent untouched fields ([D38](09-decisions.md#d38-subscriber-scope-writable-input-and-external-identity)) |
| Single subscriber membership action | The path ID is sufficient; body ids need not repeat it | Remove the catch-all request struct's redundant ID requirement (D38) |
| Session duration changes | New sessions capture an immutable expiry; retained/expired sessions keep their original lifetime. Invalid or unrepresentable configured durations return safe 400/no write rather than accepted data with an implicit seven-day auth fallback | Apply operator intent without retroactive extension, shortening or revival; legacy rows retain their original seven-day policy ([D45](09-decisions.md#d45-capture-each-session-lifetime-at-creation)) |
| NUL in final writable settings | After binding/normalization, reject NUL-bearing strings/map keys with safe 400/no write rather than upstream database-error 500 | Keep invalid text/credentials out of downstream native consumers; preserve atomic state and ignore discarded metadata/overwritten inputs ([D46](09-decisions.md#d46-reject-nul-in-final-writable-settings-values)) |
| Settings bootstrap root URL | GET projects the effective bootstrap root; full snapshot PUT ignores this read-only field and per-key mutation returns safe 400/no write | Preserve flag/environment ownership and authentication/public-link consistency (D14/[D44](09-decisions.md#d44-settings-ownership-safe-per-key-updates-and-in-process-activation)) |
| Per-key settings updates | Recognized writable keys receive full-candidate typed/invariant validation; unknown/read-only or invalid values fail safely without mutation | Avoid upstream raw per-key writes corrupting later reads or bypassing full-PUT validation (D44) |
| Settings application | Supported policy changes take effect in-process; successful update envelope remains data:true | Avoid upstream delayed SIGHUP/request interruption; later-owner settings do not claim an implemented sender/loop (D44) |
| Settings SMTP test before M2.1 | Authenticated, authorized mutation returns explicit 501; no connection/send/queue | M1.2 stores configuration; M2.1 owns delivery. No fake success (D44) |
| Dropped update-check setting | Native app.check_updates stays false/no-op and cannot be enabled | GitHub update polling is dropped in scope; no external update process is installed (D44) |
| Template bodies | Liquid, not Go templates | [D9](09-decisions.md#d9-liquid-for-user-authored-templates) |
| `POST /api/tx` response | Returns the created sends instead of `true` | Callers need the send IDs and message IDs |
| `POST /api/tx` recipients | Any email address can receive a transactional email. It does not have to be a subscriber first; listmonk's default mode rejects unknown addresses ([Sending](04-sending.md#transactional-api)) | A one-off email to someone is not a subscription. Forcing callers to create a subscriber first, or to know about `subscriber_mode`, is bookkeeping with no benefit |
| Dropped features | Their endpoints return 404: `/api/admin/reload`, OIDC routes, update checks, and anything listed as dropped in [Scope](01-scope.md) | Not built |

Upstream's OpenAPI file (`docs/swagger/collections.yaml`) is the starting reference. iglo.email publishes its own `GET /api/openapi.json`, with the new endpoints included.


## New endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/subscriber-events`, `POST /api/subscriber-events/batch` | Record events, upsert subscribers, start and end sequences |
| `GET /api/subscribers/:id/subscriber-events` | A subscriber's events |
| `GET/PUT/DELETE /api/subscribers/external/:external_id` | Address a subscriber by a path-safe opaque app ID; dot IDs use the query-selector form (D39) |
| `GET/PUT/DELETE /api/subscribers/external?external_id=…` | Address every valid opaque app ID, including . and .., with exactly one decoded query selector (D39) |
| `GET/POST /api/sequences`, `GET/PUT/DELETE /api/sequences/:id`, `PUT /api/sequences/:id/status` | Manage sequences |
| `GET /api/enrollments`, `GET /api/enrollments/:id`, `POST /api/enrollments` (manual enroll), `DELETE /api/enrollments/:id` (cancel) | Inspect and control enrollments |
| `GET /api/sends`, `GET /api/sends/:id`, `POST /api/sends/:id/resend` | Send log |
| `GET/POST /api/webhooks`, `PUT/DELETE /api/webhooks/:id`, `GET /api/webhooks/:id/deliveries` | Outbound webhooks |
| `POST /webhooks/bounce/mailgun` | Mailgun bounce webhook |

`GET /api/events` keeps its listmonk meaning (the admin's live log stream). That is why subscriber events use a different path.

## Authentication and permissions

- **Admin users:** username and password (hashed with `Bun.password`, argon2id), sessions in SQLite, `HttpOnly` + `SameSite=Lax` cookies, and CSRF tokens on state-changing cookie requests. TOTP uses a bounded, single-use password challenge and the functional second-factor form under D30.
- **API users:** same model as listmonk (`type = 'api'`, token per user).
- **Roles:** listmonk's user roles and list roles, with the same permission names. New permissions:
  - `sequences:get`, `sequences:manage`;
  - `subscriber_events:create`, `subscriber_events:get`;
  - `sends:get`, `sends:manage`;
  - `webhooks:manage`.
- **Rate limits:** login and public endpoints (subscribe, opt-in, unsubscribe) are rate-limited per IP in memory. M1.3 login uses the explicit injected policy and transport peer address under D26; M1.2 supplies persisted configuration later.

M1.3's `GET /admin/login` supplies a pre-login nonce in the form and a host-only
HttpOnly cookie; `POST /admin/login` requires both. A successful login issues a
new seven-day session cookie and a readable host-only `csrf` cookie, both with
`Path=/` and `SameSite=Lax`; HTTPS root URLs add `Secure`. Cookie-authenticated
unsafe API requests, including logout, send the `csrf` cookie value as
`X-CSRF-Token`. A supplied foreign `Origin` is rejected. Header-authenticated
API clients do not need CSRF cookies. The default login limit is 20 POSTs per
transport peer per minute, with at most 4,096 live peer records. Forwarded IP
headers are ignored. Invalid explicit Authorization never falls back to a cookie.
Public `/health` remains public; `/api/health` requires a real identity.

## Admin UI

- **v7's server-rendered admin is ported view by view to TSX** ([Templates](06-templates.md)). Alpine.js handles interactivity; Oat, CodeMirror, Squire and Chart.js are reused as bundled assets.
- **Assets are built with `Bun.build`,** like v7's `static/admin/build.mjs`, and embedded in the executable.
- **New screens:**
  - sequences (list, editor);
  - enrollments (explorer, timeline);
  - sends (log, resend);
  - webhooks (configure, deliveries);
  - subscriber page tabs for events, enrollments and sends.
- **Dropped screens:** none in v1 beyond the dropped features. OIDC settings stay hidden until OIDC is built.

M1.5 implements the authenticated lists API with live membership counts. M1.6 implements numeric/external subscriber lifecycle and ID-selected bulk actions; collection/search/export and campaign APIs remain later work. M1.3 adds the functional password-login form and real auth boundary under D26; M1.4 adds the second-factor form under D30. Full admin screens, dashboard and password reset remain their later tasks. M0.6 serves embedded static assets and the public HTML 404. Unmatched `/admin/*` currently uses that public 404; the upstream admin-specific error view remains pending M4.1. The compiled admin shell fixture is not a production admin route.

## Public pages

Kept with listmonk's URL shapes, so the behavior people know stays the same:

- `/subscription/form` and `/api/public/subscription`: subscribe;
- `/subscription/optin/:subUUID`: confirm opt-in;
- `/subscription/:campUUID/:subUUID`: unsubscribe and manage preferences for campaigns;
- `/subscription/export/:subUUID` and `/subscription/wipe/:subUUID`: data export and wipe, if enabled;
- `/link/:linkUUID/:campUUID/:subUUID`: tracked links;
- `/campaign/:campUUID/:subUUID`: view in browser;
- `/campaign/:campUUID/:subUUID/px.png`: view pixel.

New, for sends (transactional and sequence messages):

- `/m/:sendUUID/unsubscribe`: page and one-click `POST`;
- `/m/:sendUUID/link/:linkUUID`: tracked links;
- `/m/:sendUUID/px.png`: view pixel.


M1.5 list writes accept JSON and XML through the bounded list decoder. XML
field names follow the Go model's case-sensitive local names, with repeated
`Tags` elements; JSON uses Go's case-insensitive field aliases and ordered
repeated writable fields. D36 ignores response-only and unknown metadata in
both formats; those fields cannot assign identity, timestamps or counts. D35's
declaration, depth, body and normalized tag limits and XML character/reference
integrity are covered by paired cases; the suite does not claim complete XML parity.

D37 replaces the XML implementation with a strict streaming parser. XML UTF-8,
syntax and characters are validated only through the consumed first root;
unconsumed suffix bytes are ignored as in pinned encoding/xml.Decode. The
64 KiB body, 64-level depth and no-DTD bounds remain. JSON retains its existing
replacement decoding. This corrects compatibility defects, not a new API exception.

M1.6 implements numeric-ID subscriber CRUD and ID-selected bulk actions. Collection/
search/SQL/query-selected bulk/export remain M1.7. Automatic/explicit opt-in
mail awaits M2.5; M1.6 stores actual membership state without delivery claims.
D38 defines the normal-only external_id field and GET/PUT/DELETE lookup routes,
exact nullable identity, safe conflict/no-write and current-scope behavior.

D39 adds a query-selector external route for every D38 opaque ID. Bun-normalized
dot path segments cannot encode those identities; . and .. remain valid and
use the query form. Selector values are decoded exactly once, never recursively.
The path convenience form and query form share permissions and atomic behavior.

M1.2 supplies persisted settings and authenticated routes, including
the D44 SMTP-test staging boundary. Newly issued sessions capture their expiry;
legacy sessions retain the original seven-day policy. Subscriber mutations use
the current domain policy. `app.lang` is retained as configuration, but the
current runtime translation remains English; changing it does not hot-switch the
language. Later-owner settings do not implement their engines.

D47 pins native cron location validation to the complete case-sensitive
identifier set in Go 1.27.2's IANA 2026c archive, plus Go's empty/UTC/Local
special names. Valid aliases such as US/Eastern work without a production
timezone file. Names outside that set, including host-only extensions, return
the safe unknown-location error with no write. The reference runner supplies
the same checksum-pinned archive through ZONEINFO to make named-zone cases
reproducible; the earlier unaligned host lacked US/Eastern and rejected it.
This does not add a cron or timezone-offset engine.

Shared compiled and reference corpora exercise binding, safe error envelopes,
numeric ranges, supported document and per-key types, address and cron cases.
This finite coverage is representative; reproduced unlisted differences must
still be corrected. Secret retention is visible through masked projections
until M2.1 verifies actual authentication and delivery with Mailpit.

D46 rejects NUL in final normalized writable settings strings and map keys
atomically with native HTTP 400 `Invalid data.` and no write; pinned PostgreSQL
returns HTTP 500 with no write. Ignored, overwritten and legitimately normalized
input retains its documented behavior. This settings-specific decision is
separate from subscriber D43 and requires no pending policy disposition.
