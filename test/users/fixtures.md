# Synthetic user and authentication fixtures

These credentials are used only for disposable loopback test instances. The
reference harness installs its own admin credentials from
`test/reference/fixtures.md`; generated API tokens and session cookies are
held in memory and are never written to a report.

```dotenv
IGLO_EMAIL_ADMIN_USER=m13-bootstrap-admin
IGLO_EMAIL_ADMIN_PASSWORD=m13-bootstrap-password
M13_BROWSER_WRONG_PASSWORD=m13-wrong-password
```

The user contract creates uniquely named disposable users with the synthetic
passwords `m13-contract-password` and `  m13-spaced-password  `, then removes
only the users created by that invocation.

The labelled loopback owner fixture uses `fixture-admin` /
`fixture-admin-password` and test accounts with the password
`fixture-user-password`. Password-change cases use `  fixture-changed-password  `
and `  fixture-admin-reset-password  ` with the surrounding spaces. The fixture
never connects to an external service.

The deterministic concurrent-target cases use fixture-concurrent-new-password.
A labelled /fixture/gated-user/:id route gates completion of production password
hashing through the fixture auth object; /fixture/gate-entered and
/fixture/gate-release coordinate HTTP requests without sleeps. Production main
has none of these routes or controls. Reader/list roles are provisioned through
fixture-owned public helpers while role administration remains M1.4.
