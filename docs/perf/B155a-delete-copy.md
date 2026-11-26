# B155a: the deleted project's snapshot as a copy

[D176](../design/09-decisions.md#d176-bounce-attribution-project-lifecycle-and-campaign-waits-b155a-lead-2026-11-26) item 3 and review round 1. A project delete used to claim its final snapshot `backups/deleted/<slug>-<time>.db` with a hard link of the project's database; it now copies the database (`copyFile` with `COPYFILE_FICLONE`, a reflink clone where the filesystem supports one) to `<name>.db.partial`, syncs that copy, claims it with the hard link, and syncs `backups/deleted/`, `backups/` and the data directory before the project's directory is removed.

- Command: `bun test/projects/measure-delete-copy.ts [base directory]`. Each of 5 rounds makes a fresh data directory, migrates the primary project's database and seeds 300,000 subscribers with `seedSubscribers` (database 114.7 MiB), times one hard link of the database (before), then times `archiveDeleted` (after: the checkpoint, the copy, its sync, the claim, the directory syncs; no uploads, so no tarball). Medians.
- Host: `agents-workhorse-01` (Linux x86-64, 12 cores, 30 GB RAM, NVMe), 2026-11-26, Bun 1.4.5, other B155 workers running on the host.
- ext4: a 3 GiB image file on the xfs `$HOME` disk, made with `mkfs.ext4` (defaults, no reflink support: `FICLONE` answers `EOPNOTSUPP`), loop-mounted in a privileged `oven/bun:1.4.5` (linux/amd64) container that runs the script on it. The no-sync row is the same code with both sync calls taken out, for reference only.

| Data directory | Filesystem | Load average (start → end) | Hard link (before) | `archiveDeleted` with the syncs (after) | Without the syncs |
| --- | --- | --- | --- | --- | --- |
| loop-mounted image | ext4 (`0xef53`, plain copy) | 4.3 → 8.2 | 0.09 ms | 145.5 ms | 54.6 ms (load 7.9 → 7.2) |
| `$HOME` scratch | xfs (`0x58465342`, reflink) | 5.9 → 3.6 | 0.06 ms | 14.7 ms | 1.6 ms (B155a first measure, load 2.3 → 1.4) |

On xfs the copy is a clone, so its size does not matter; the syncs are the journal commits. On ext4 the copy is a plain one (`copy_file_range`), and the sync writes the 115 MiB to the disk: about 0.8 GB/s with the sync here. The delete needs free space for one more copy of the database until the directory is removed. A delete runs once per project, outside every request and loop, so neither number matters to sending.

## Ordering, checked with strace

One run of the script on the ext4 image under `strace -f -y -e trace=fsync,fdatasync,link,linkat,unlinkat,rmdir,copy_file_range,ioctl` shows, for each round, in this order:

```
ioctl(<…/backups/deleted/main-<time>.db.partial>, FICLONE, …) = -1 EOPNOTSUPP
copy_file_range(<…/projects/main/iglo-email.db>, …, <…/backups/deleted/main-<time>.db.partial>, …, 120258560, 0) = 120258560
fsync(<…/backups/deleted/main-<time>.db.partial>) = 0
link("…/backups/deleted/main-<time>.db.partial", "…/backups/deleted/main-<time>.db") = 0
fsync(<…/data/backups/deleted>) = 0
fsync(<…/data/backups>) = 0
fsync(<…/data>) = 0
unlinkat(<…/data/projects/main>, "iglo-email.db", 0) = 0
unlinkat(AT_FDCWD, "…/data/projects/main", AT_REMOVEDIR) = 0
```

The copy's data reaches the disk before the name that claims it, and the claimed name before the project's database is removed. No test pins this order (D176 review round 1): only a power loss shows a missing sync.
