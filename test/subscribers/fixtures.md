# M1.6 contract fixtures

The subscriber contracts create invocation-owned synthetic email addresses under
`example.test` and random names, lists, roles and users. They delete each created
record by its returned numeric ID. The reference harness uses an isolated fresh
installation and its generated credentials. The normal corpus uses an isolated
compiled process and a synthetic admin provisioned by `test/contract/owned.ts`.
No real mail is delivered by these tests.

`dot-path-observe.ts` sends raw requests to a temporary loopback Bun server and
prints only the normalized paths. `external.ts` is a compiled-production-only
D38/D39 specification: query selectors support every valid opaque ID, while raw
dot paths observe D18 normalization. The compiled corpus uses real subscriber
writes to check list counts; the separate pre-M1.6 list-count fixture remains
labelled synthetic evidence. D40 cases distinguish native signed-64-bit IDs
from the reference's PostgreSQL integer-width errors.
