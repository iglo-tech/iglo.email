# Synthetic template fixtures

The template contract and renderer fixtures use only generated names and local
HTTP servers. `example.invalid` and `example.test` are reserved synthetic
addresses. The contract harness provisions a disposable API credential in
memory; it does not print or persist that credential. The compiled renderer
fixture creates a canary in its own temporary directory and a loopback-only
trap, then removes both.

The opt-in compiled API measurement bootstraps the disposable administrator
`m18-measure-admin` with password `m18-measure-password`; its generated API
credential is kept in memory. The workload creates and removes synthetic lists,
subscribers and templates on its own temporary database.

The held-session tests create disposable users with password
`m18-fixture-password` and keep session and CSRF values only in memory.
