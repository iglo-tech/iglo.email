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

## Current coverage and handoff (M0.6)

| Mode and profile         | Executed coverage                                                                                                                                                   | Pending production coverage                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `reference/upstream/all` | 43 pinned-upstream cases, including protected reads, public HTML 404 and asset boundaries, validation and D17/D18/D21                                               | Auth and list endpoints remain unported; public HTML 404 and embedded assets now have production coverage |
| `normal/production/core` | 21 compiled-production cases: `/health`, public HTML 404 and embedded assets, API fallback/method boundaries, malformed URI handling and unregistered `/api/health` | Protected health/auth (M1.3), domain validation/list CRUD (M1.5)                                          |
| `normal/fixture/staged`  | Synthetic auth gate and representative shared helpers, including the normal sides of D17/D18                                                                        | The corresponding production endpoints and auth                                                           |
| `normal/fixture/probe`   | Synthetic generated ID, relationship and timestamp normalization                                                                                                    | These probes do not represent upstream ports                                                              |

M1.3 must run and promote the same protected-health cases against real production
auth, removing that fixture-only gap. Domain workers promote their cases while
retaining the explicit D17/D18 results. A fixture pass never implies production
parity. M0.6 checks the rendered public HTML 404 structure, title, heading,
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
