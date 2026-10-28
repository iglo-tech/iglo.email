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
| Wrong-kind role update | User/list role update routes reject a target of the other type or a child role with 400 invalid ID | Prevent cross-kind permission changes; upstream update-role omits the type check ([D30](09-decisions.md#d30-role-mutations-and-the-totp-authentication-boundary), implementation pending M1.4) |
| Assigned-role deletion | Reject deletion of roles assigned as either user or list roles with 400 cantDeleteRole | Avoid the upstream list-role cascade deleting users and potentially the final human administrator (D30) |
| Role writes with list permissions | Commit the parent and child permission replacement atomically | Invalid child entries must not leave a partial role or changed authority (D30) |
| TOTP challenge and factor changes | Extend D26 nonce/Origin, peer limits, revocation and live-state rechecks through bounded single-use five-minute challenges | Prevent second-factor guessing or completion after account/credential/factor revocation; no authenticated session before both factors (D30) |
| Role-name search | Case-insensitive literal substring after upstream whitespace normalization; no PostgreSQL dictionary stemming or SQL wildcard expansion | Predictable punctuation and language-independent label matching without database text-search configuration; concrete shared expectations required ([D31](09-decisions.md#d31-literal-role-name-search-and-safe-role-diagnostics), acceptance pending M1.4) |
| Role error diagnostics | Keep error status and localized field/operation context, but omit submitted invalid permission strings and storage-engine details | Identify the bad field or operation without reflecting pasted secrets or database internals (D31, acceptance pending M1.4) |
| Missing/null user-role permissions | POST/PUT user-role requests return 400 Invalid fields: permissions without writing, rather than upstream's constraint-error 500; explicit [] remains valid | Prevent a missing replacement from silently revoking grants and identify incomplete client input safely ([D32](09-decisions.md#d32-require-explicit-user-role-permission-replacement)) |
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
| `GET/PUT/DELETE /api/subscribers/external/:external_id` | Address a subscriber by the app's ID |
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

M1.3 adds the functional password-login form and real auth boundary under D26; M1.4 adds the second-factor form under D30. Full admin screens, dashboard and password reset remain their later tasks. M0.6 serves embedded static assets and the public HTML 404. Unmatched `/admin/*` currently uses that public 404; the upstream admin-specific error view remains pending real authentication and M4.1. The compiled admin shell fixture is not a production admin route.

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
