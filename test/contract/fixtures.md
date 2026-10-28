# Synthetic contract fixtures and reference-first evidence

All credentials and data in this suite are synthetic and local-only. The live
reference creates `reference-api` and an independent token for every run; the
runtime token is supplied through `REFERENCE_API_TOKEN` and is never recorded.
The intentionally invalid token is `invalid-synthetic-token`.

## Reference-first baseline

Before building the M0.5 runner or its fixture, `bun run server:reference` ran
against the M0.2 disposable upstream on 2026-10-27. It used listmonk
v7.0.0-beta.1 at `6fcd95f32bb633d3a62a06c383c0b3322eecc898` and passed the
28 existing M0.3 observations plus these new protected-read assertions:

| Request                               | Result                                                             |
| ------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/health`, valid Basic        | 200, `application/json`, `{"data":true}\n`                         |
| `GET /api/health`, valid token scheme | 200, `application/json`, `{"data":true}\n`                         |
| `GET /api/health`, invalid token      | 403, `application/json`, `{"message":"invalid API credentials"}\n` |

The run also verified the reference sides of D17 and D18. This is upstream
behavior evidence, not production authentication coverage.

## M1.3 reference-first observations

On 2026-10-28, before production users or authentication were implemented,
these commands ran against the pinned disposable upstream:

```sh
bun run reference:run -- bun test/contract/cli.ts run --mode reference --target upstream --profile all
bun run reference:run -- bun test/contract/auth.ts reference
```

The first command passed 52 cases, including nine new user validation and
unauthenticated cases. The second uses only HTTP, creates uniquely named users,
and removes only those users. It confirmed Basic and token authentication,
login, profile and user reads, creation, update, batch deletion, token secrecy,
disabled-token denial, and restricted profile updates. The generated credentials
and cookies remain in memory. The checked-in fixture passwords are synthetic.

The reference outcomes underlying D26 were observed as follows:

| Case                                                   | Pinned upstream                                        | D26 production expectation                    |
| ------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------- |
| Invalid explicit header with a valid session cookie    | Cookie wins; protected health succeeds                 | Header wins; request is denied                |
| Valid API header with a different valid session cookie | Profile identifies the cookie user                     | Profile identifies the API user               |
| Password POST without the login nonce                  | Login succeeds                                         | Login is denied                               |
| Human created with spaces around the password          | Exact submitted password is trimmed on login and fails | Exact submitted password succeeds             |
| Header-only `POST /api/logout`                         | Connection is closed after the session assertion fails | Success envelope; API token remains valid     |
| Session logout without a CSRF token                    | Logout succeeds                                        | Logout is denied without changing the session |

Malformed authorization schemes, invalid Base64, missing pairs, and empty keys
return 403 with an embedded `code=400, message=...` error string. A disabled
API credential is rejected on the next request. These observations are
reference evidence only; they are not a claim of compiled-production coverage.

D27 accepts two additional reference observations: converting an API
user to a password-login human without supplying a password succeeds and keeps
the API-token digest as that user's stored credential; converting a human to an
API user with `password_login=true` retains the human password hash, although
the old human password is not accepted as an API token. The shared corpus marks
the approved D27 production behavior explicitly: require a new password for the
first conversion and clear the credential for the second. This prevents one
credential type from being persisted as another, satisfies the task's Argon2id
and SHA-256 storage requirements, and does not invent a token-rotation API.

A create request for an API user with an invalid role returned 500 upstream and
its database error contained a 64-character SHA-256 credential digest. The
corpus checks this without printing the error or digest. The D27 normal
result is 400 with a safe invalid-role message and no digest. This narrow error
change is recorded in D27. Duplicate usernames separately retain upstream's
500 error shape without exposing a credential.

The reference run also provisions and removes one invocation-owned empty list
role and user through upstream HTTP. User detail returns that role with
`lists: null`, while the user list returns a single empty list projection
(`id: 0`, `name: ""`, empty permissions). The labelled normal fixture supplies
the same role through the role owner; the production role-management API is
still deferred to M1.4.

Additional email observations confirm acceptance of an IPv4 address literal,
and rejection of consecutive dots, quoted local parts, non-IP literals, invalid
IPv4 literals and the tested IPv6 literal spellings. These are exercised in
both modes through user creation.
The user-list reference also confirms PostgreSQL's null placement for
`loggedin_at`: nulls follow timestamps in ascending order and precede them in
descending order.

The user route also follows D17 for positive 64-bit overflow. A role ID JSON
token with a fractional value that would round to an integer in JavaScript is
rejected in both modes instead of silently binding the rounded ID.

## Round-1 corrections and D28 observations

On 2026-10-28 the lead extended the same stateful corpus, then ran
`bun run reference:run -- bun test/contract/auth.ts reference` before changing
production redirect code. All 59 reference assertions passed. The new normal
case failed at `login-escaped-destination-canonical` on the reviewed code:
`next=/api/%70rofile` must redirect to `/api/profile`, and that destination must
return the authenticated identity. This is compatible behavior, not a new
API difference.

D28 marks two precise differences. An API name-only profile PUT returns
upstream 400 `Invalid fields: email` and normal 200. A profile PUT with a valid
human password/email returns 200 in both modes, with secrets omitted and
account-control fields ignored. An ordinary admin update then refreshes the
reference's API cache: the original token stops working upstream because the
profile query replaced its persisted digest with a password hash. The normal
original token must still work; the supplied password must never work as an API
token in either mode. No digest, generated credential or response diagnostic is
printed.

After cleaning all invocation-created users, the common corpus verifies the
owned bootstrap account is the sole enabled human Super Admin. Its conversion
to API type returns upstream 200 and normal 400 with the existing needSuper
error. The reference bootstrap account is restored in a finally block through
the independent API administrator, using the known synthetic bootstrap password;
password login is verified again in both modes. This probe is for these
invocation-owned disposable targets only. It never alters a real account or
leaves the harness bootstrap account converted.

## Round-2 corrections and D29 observations

The common corpus now also submits trailing slash/dot, literal/encoded parent,
embedded parent text, absolute and scheme-relative paths, encoded final dot and
query-only dots. Pinned upstream cleans valid destinations to `/api/profile`
and rejects parent text to `/`. Each Location header is exact and the issued
identity is checked through the actual protected profile. The root page itself
is not ported and its response is not compared. The first draft expected a root
404 in both modes; upstream's root redirect exposed that overly broad test
assumption, which was removed before the reference specification was committed.
The extended reference corpus passes, while the reviewed production code fails
`login-next-trailing-slash` before the correction.

D29's six marked sole-admin PUT cases cover omitted role/status, explicit zero
role plus empty status, and either field omitted/defaulted independently. Each
uses the existing username/name/email and preserves password login. Upstream
returns its exact needSuper 400; production succeeds with the same enabled
human Super Admin identity and no secret. A subsequent GET checks that authority
is retained. The D28 conversion rejection, reference restoration in finally and
last-admin password login still follow these cases. This is existing safe
production behavior made explicit, not a new storage implementation.

## Normal fixture credentials and probe data

The test-only auth gate accepts only the following synthetic credentials. It is
not the production authentication implementation.

```text
CONTRACT_API_USER=contract-fixture-user
CONTRACT_API_TOKEN=contract-fixture-token
```

The normalization probe generates two distinct positive numeric IDs and UTC
ISO timestamps independently for each fixture run. Its label is `synthetic 101`
and its unrelated nested `id` is `77`; neither is normalized. No probe is a
ported upstream domain endpoint.

## Historical coverage and handoff (M0.6)

| Mode and profile         | Executed coverage                                                                                                                                                   | Pending production coverage                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `reference/upstream/all` | 43 pinned-upstream cases, including protected reads, public HTML 404 and asset boundaries, validation and D17/D18/D21                                               | Auth and list endpoints remain unported; public HTML 404 and embedded assets now have production coverage |
| `normal/production/core` | 21 compiled-production cases: `/health`, public HTML 404 and embedded assets, API fallback/method boundaries, malformed URI handling and unregistered `/api/health` | Protected health/auth (M1.3), domain validation/list CRUD (M1.5)                                          |
| `normal/fixture/staged`  | Synthetic auth gate and representative shared helpers, including the normal sides of D17/D18                                                                        | The corresponding production endpoints and auth                                                           |
| `normal/fixture/probe`   | Synthetic generated ID, relationship and timestamp normalization                                                                                                    | These probes do not represent upstream ports                                                              |

M1.3 has promoted the same protected-health cases to real compiled-production
authentication, removing the fixture-only gap. `contract:normal` now reports
38 compiled core cases, including user-validation cases; `contract:auth`
and its matching reference invocation exercise the stateful user/auth corpus.
The empty-list-role and lower-permission normal cases remain labelled fixture
evidence because role-management endpoints are deferred. Domain workers
promote their helper cases while retaining the explicit D17/D18 results. A
fixture pass never implies production parity. M0.6 checks the rendered public HTML 404 structure, title, heading,
message, local assets and attribution with explicit per-target branding. The
route-backed D18 helper cases assert the actual HTML fallback after Bun removes
encoded dot segments; the upstream invalid-ID expectations remain intact. The
reference-first baseline above records M0.5 history, not current coverage.

M0.6's method correction records D21: static HEAD resolves the same embedded
resource as GET and returns its metadata without bytes; OPTIONS and rejected
methods advertise `OPTIONS, GET, HEAD`. The source-first reference still asserts
upstream's HEAD 405 and `OPTIONS, GET` advertisement. Declared response headers
are compared explicitly, including missing or incorrect Allow values.

The core D18 `public-static-dot-escape` case sends the exact encoded target to
both upstream and actual compiled production. It requires upstream's plain-text
404 and the normal public HTML 404, and a synthetic plain-text normal response
fails. Unmatched non-static admin paths still use the public error page until
M4.1 supplies the authenticated admin error view.

Equivalent static spellings now run through the core corpus in both modes:
`%73tyle.css`, `style%2ecss` and a redundant separator resolve to the same public
stylesheet. The reference observation and compiled-production HTTP tests also
verify the escaped Geist font name and WOFF2 signature. Asset lookup decodes once
and cleans POSIX separators inside the original embedded namespace. It never
uses the request path for filesystem access.

The HTML CLI rejects newline/tab/carriage-return executable URL schemes after
browser-compatible URL parsing, hidden headings and ancestors, inline visibility
styles and unrecognized stylesheets. These checks remain specific to the fixed
public 404 layout; wire and JSON comparisons are unchanged.

The fixed-page HTML contract now allows only the known 404 tags, attributes and
layout classes, requires the heading directly under the body wrapper, and checks
stylesheet links in all locations while rejecting body assets and document bases.
Its fixed URL contexts reject character-reference/control spellings instead of
treating HTMLRewriter's raw attribute values as browser-decoded strings. The
reference-only archive RSS title/link is explicitly expected; production does not
claim archive functionality. Seven additional CLI negatives first passed
incorrectly, then failed correctly after the shape checks were tightened.

Round 3 adds explicit parents for every allowed element and checks all document
text, including text outside the normal selectors and after the closing tags.
All images must occupy the one logo slot. Footer text and ordered link targets
and labels are exact per target; arbitrary suffixes are not normalized away.
Nine public CLI regressions first exposed false passes for misplaced images,
sibling/bare/trailing text and a changed attribution link. Correct real upstream
and compiled-production pages still pass this bounded default-page schema.

M1.5 D35 cases use invocation-owned lists to distinguish ordered JSON aliases,
null tag elements and XML binding from declaration/depth/body restrictions.
Overlong normalized tags are deliberately rejected before either write on normal
production, while reference POST fails with 22001 and PUT truncates. The corpus
checks stored fields and exact tag filtering; a labelled synthetic campaign
fixture also checks unchanged snapshots, timestamps and grants after rejection.
