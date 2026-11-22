# B136: backup snapshot before and after

Storage change on the backup path (`src/backup/snapshot.ts`, `createBackup`), measured as required by
AGENTS.md ("Changes to sending, scheduling or storage must include before/after measurements").

## What changed

- **Before:** the parent created an empty snapshot file with `openSync(snapshot, "wx", 0o600)` before it
  spawned the flush child and before `VACUUM INTO`. SQLite wrote into the existing file and kept its mode.
- **After:** `VACUUM INTO` creates the file, then `chmodSync(snapshot, 0o600)` makes it private. The flush
  child cannot open the file at spawn time any more, so it polls `open` every 10 ms (`openWhenCreated`)
  until the file exists or its stdin closes. The parent never waits for the child.
- **Otherwise the I/O path is the same:** `VACUUM INTO`, `sealSnapshot`, `sync(snapshot)`, the publish
  rename, and the flush child's periodic `fsync`. The added work per backup is one `chmod` and a child
  that polls `open` off the parent's path.

## Measurement

Setup:

- Host: Apple Silicon macOS. Containers ran in the Docker Desktop VM (aarch64, 8 CPUs, 8 GiB) from
  `oven/bun:1.4.5`. The work volume was a Docker named volume on the VM disk, not a macOS bind mount, so
  the backup I/O did not go through the host file-sharing layer.
- Executables: `bun run build` from `git archive origin/main` (`86c126c`, labelled **main**) and from
  the PR head (`549e2fc`, labelled **head**). Both compile to 115 985 400 bytes.
- Data: one data directory, seeded once with `seedSubscribers(dataDir, 300_000)` after one `serve` and
  stop, the same code path as `test/backup/interrupted.test.ts`. Database: 120 295 424 bytes, 115 MB in
  total. The seed is run from a source tree so the `@/` alias resolves.
- Each run: copy the seed directory (not timed), then time `iglo.email backup --data-dir … --output …`
  from spawn to exit with `PATH=""`, as the tests run it. Snapshot size is the byte total of the
  destination directory after the run. Runs alternate main and head, 5 pairs, one after another.

| Run | main wall (ms) | head wall (ms) |
|---|---:|---:|
| 1 | 3658 | 2459 |
| 2 | 2131 | 2127 |
| 3 | 2320 | 3824 |
| 4 | 3187 | 2405 |
| 5 | 3100 | 2446 |
| **median** | **3100** | **2446** |
| **min** | 2131 | 2127 |
| **max** | 3658 | 3824 |
| Snapshot bytes | 113 205 270 | 113 205 270 |

Host load (macOS `uptime`, other agents running on this machine): before the runs at 10:06, load
averages 10.11 10.83 13.22; after, at 10:06, 9.76 10.67 13.07. The VM's `/proc/loadavg` read 5.92 before
and 7.34 after.

The medians differ by 654 ms in head's favour, which is less than either set's spread (main 1527 ms,
head 1697 ms, and the ranges overlap). So the difference is within noise and the sets were not rerun.
The snapshots are the same size. Both binaries are the same code apart from this change, and the change
adds one syscall to the parent's path, so no slowdown is expected or seen.

## Why the file is 0644 for a moment

`VACUUM INTO` creates the file with the umask mode, 0644 under umask 022, and `chmod` follows at once.
That window lasts for the whole `VACUUM`, which can take seconds or minutes on a large database. It is
acceptable because the file sits only inside a fresh `mkdtemp` directory with mode 0700. Opening it by
path needs search permission on that directory. The random name and `O_EXCL` rule out a planted or
symlinked directory, and a default ACL on the parent cannot grant access, because the 0700 directory's
ACL mask clears the named entries' execute bit. So only root and the same uid can read it, and both
can already read the live database.

## Why it cannot be created 0600 from the start on both platforms

- **`modeof=` in a `file:` URI** (`VACUUM INTO 'file:…?modeof=<0600 file>'`) gives 0600 on macOS. On Linux
  it fails with "unable to open database", because Bun's embedded SQLite there does not enable URI
  filenames.
- **Pre-creating the file 0600** (the old code) works on Linux, where SQLite accepts an empty file. Apple's
  SQLite refuses it with "output file already exists", so the old code could not run on macOS.
- Setting a process-wide umask would avoid the window, but it is process-global state, which AGENTS.md
  forbids.

## Reproducing

Inside the container: `bun run build` in each source tree; `bun seed.ts <head-executable> <data-dir>`
(the snippet is `startServer`, `stop`, then `seedSubscribers(dataDir, 300_000)`, as in
`test/backup/interrupted.test.ts`); then for each run a fresh copy of the data directory and a timed
`backup`. The harness scripts are not committed, because they only drive the commands above.
