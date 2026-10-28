# Synthetic user and authentication fixtures

These credentials are used only for disposable loopback test instances. The
reference harness installs its own admin credentials from
`test/reference/fixtures.md`; generated API tokens and session cookies are
held in memory and are never written to a report.

```dotenv
IGLO_EMAIL_ADMIN_USER=m13-bootstrap-admin
IGLO_EMAIL_ADMIN_PASSWORD=m13-bootstrap-password
```

The user contract creates uniquely named disposable users with the synthetic
passwords `m13-contract-password` and `  m13-spaced-password  `, then removes
only the users created by that invocation.
