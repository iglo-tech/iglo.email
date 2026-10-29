# Synthetic SMTP fixtures

These credentials are generated for loopback-only tests and are never used with
an external server: username `m21-fixture-user`, password
`m21-fixture-password`. RSA signing keys are generated afresh in memory for
each invocation and are not production keys. The relay authenticates these
values locally and forwards messages only to the invocation-owned Mailpit.
