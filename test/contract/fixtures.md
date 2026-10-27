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
