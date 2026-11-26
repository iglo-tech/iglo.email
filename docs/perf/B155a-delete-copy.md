# B155a: the deleted project's snapshot as a copy

[D176](../design/09-decisions.md#d176-bounce-attribution-project-lifecycle-and-campaign-waits-b155a-lead-2026-11-26) item 3. A project delete used to claim its final snapshot `backups/deleted/<slug>-<time>.db` with a hard link of the project's database; it now copies the database (`copyFile` with `COPYFILE_FICLONE`, a reflink clone where the filesystem supports one) to `<name>.db.partial` and claims that copy with the hard link.

- Command: `bun test/projects/measure-delete-copy.ts [base directory]`. Each of 5 rounds makes a fresh data directory, migrates the primary project's database and seeds 300,000 subscribers with `seedSubscribers` (database 114.7 MiB), times one hard link of the database (before), then times `archiveDeleted` (after: the checkpoint, the copy, the claim; no uploads, so no tarball). Medians.
- Host: `agents-workhorse-01` (Linux x86-64, 12 cores, 30 GB RAM), 2026-11-26, Bun 1.4.5. Load average 2.3 at the start and 1.4 at the end (other B155 workers on the host).

| Data directory | Filesystem | Hard link (before) | `archiveDeleted` with the copy (after) |
| --- | --- | --- | --- |
| `$HOME` scratch | xfs (`0x58465342`, reflink) | 0.05 ms | 1.6 ms |
| `/tmp` | tmpfs (`0x1021994`, plain copy) | 0.04 ms | 43.6 ms |

On xfs the copy is a clone, so neither time nor space grows with the database until one of the two files changes. On a filesystem without reflinks the copy is a plain one: about 2.6 GB/s here, and the delete needs free space for one more copy of the database until the directory is removed. A delete runs once per project, outside every request and loop, so neither number matters to sending.
