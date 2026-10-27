# API and admin UI

## API compatibility policy

The listmonk HTTP API is a contract worth keeping: there are SDKs, an n8n node and scripts written against it. For every **ported** endpoint, iglo.email keeps:

- the path and method;
- request field names and types;
- the `{ "data": … }` response envelope and `{ "message": "…" }` errors;
- pagination (`page`, `per_page`, `per_page=all`), with `total`, `per_page` and `page` in responses;
- authentication: `Authorization: token <api_user>:<token>` and HTTP Basic auth.

Deliberate differences:

| Area | Difference |
|---|---|
| SQL in `query` parameters (`/api/subscribers?query=…`, `/api/subscribers/query/*`) | SQLite dialect, not Postgres |
| Template bodies | Liquid, not Go templates |
| `POST /api/tx` response | Returns the created sends instead of `true` |
| Dropped features | Their endpoints return 404: `/api/admin/reload`, OIDC routes, update checks, and anything listed as dropped in [Scope](01-scope.md) |

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

- **Admin users:** username and password (hashed with `Bun.password`, argon2id), optional TOTP 2FA, sessions in SQLite, `HttpOnly` + `SameSite=Lax` cookies, and CSRF tokens on every state-changing admin form.
- **API users:** same model as listmonk (`type = 'api'`, token per user).
- **Roles:** listmonk's user roles and list roles, with the same permission names. New permissions:
  - `sequences:get`, `sequences:manage`;
  - `subscriber_events:create`, `subscriber_events:get`;
  - `sends:get`, `sends:manage`;
  - `webhooks:manage`.
- **Rate limits:** login and public endpoints (subscribe, opt-in, unsubscribe) are rate-limited per IP in memory.

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
