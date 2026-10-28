# M1.6 contract fixtures

The subscriber contracts create invocation-owned synthetic email addresses under
`example.test` and random names, lists, roles and users. They delete each created
record by its returned numeric ID. The reference harness uses an isolated fresh
installation and its generated credentials. The normal corpus uses an isolated
compiled process and a synthetic admin provisioned by `test/contract/owned.ts`.
No real mail is delivered by these tests.

`dot-path-observe.ts` sends raw requests to a temporary loopback Bun server and
prints only the normalized paths. `external.ts` is a production-only D38
specification; it is expected to fail until the feature and the dot-segment
contract conflict are resolved. The existing subscriber list-count fixture is
synthetic and is not evidence of a production subscriber API.
