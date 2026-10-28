# Synthetic M1.5 fixture data

The loopback fixture bootstraps `fixture-admin` with password
`fixture-admin-password`. Its generated API credentials, subscriber addresses,
UUIDs and campaign references are synthetic and exist only in each disposable
test directory. `/fixture/membership` and `/fixture/campaign` provision
subscriber and campaign records for tests; they are not production APIs.
The restart and measurement credentials are likewise disposable values in the
test programs and must never be reused for a deployed instance.

Other fixed, non-production values used by the tests are:

- Restart bootstrap: `m15-restart-admin` / `m15-restart-password`.
- Measurement bootstrap: `m15-measure-admin` / `m15-measure-password`.
- Session test: `session-fixture` / `fixture-password`.
