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

## Coverage examples and handoff

| Mode and profile         | Executed coverage                                                                                         | Pending production coverage                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `reference/upstream/all` | 31 pinned-upstream cases, including Basic, token and bad-token protected reads, validation and D17/D18    | Auth and list endpoints are not yet ported; public HTML 404 body is deferred                               |
| `normal/production/core` | Compiled `/health`, API fallback/method boundaries, malformed URI handling and unregistered `/api/health` | Protected health/auth (M1.3), domain validation/list CRUD (M1.5), public HTML 404 body (M0.6/public pages) |
| `normal/fixture/staged`  | Synthetic auth gate and representative shared helpers, including both sides of D17/D18                    | The corresponding production endpoints and auth                                                            |
| `normal/fixture/probe`   | Synthetic generated ID, relationship and timestamp normalization                                          | These probes do not represent upstream ports                                                               |

M1.3 must run and promote the same protected-health cases against real production
auth, removing that fixture-only gap. Domain workers promote their cases while
retaining the explicit D17/D18 results. A fixture pass never implies production
parity. The reference HTML 404 case checks status and content type only; its
body is explicitly pending, not a deliberate API difference.
