# Synthetic reference fixtures

The harness creates a fresh database on every run. These values are synthetic,
local-only test credentials; they are never used for a real service.

- Admin username: `reference-admin`
- Admin password: `reference-admin-password`
- API username: `reference-api`
- API token: generated independently by listmonk at installation; available only
  to the test command as `REFERENCE_API_TOKEN`, never committed or logged.
- Postgres database and username: `reference`
- Postgres password: `reference-db-password`
- Smoke recipient: `recipient@example.test`
- Smoke order: `fixture-123`, shipping date `2026-01-01`

listmonk's fresh installer also creates its own synthetic sample lists,
subscribers, templates, and draft campaign.
