# Synthetic settings test data

Retained-human settings authorization cases use the disposable password
`m12-synthetic-human-password` and generated names, roles and cookies.

Settings tests use the synthetic bootstrap credentials in `test/users/fixtures.md`
and generated API tokens held only in memory. The secret value in the test is
synthetic and is never used to connect to any service. Addresses under
`example.test` and `example.invalid` are synthetic. The reference harness owns
its disposable PostgreSQL database, local Mailpit, and generated credentials.
No SMTP test in the native settings suite creates a network connection.

The settings measurement uses bootstrap username `m12-measure-admin` and password
`m12-measure-password` only inside a fresh synthetic temporary data directory.
