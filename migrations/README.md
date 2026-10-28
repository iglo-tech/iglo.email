# Migrations

The production manifest in `src/db/migrations.ts` embeds `0001_init.sql`, the
first full v1 schema. Future numbered
SQL files are imported as text into that explicit manifest and compiled into the
executable. Startup never scans this directory.

Versions start at 1, are ordered and contiguous. A source contains SQL schema and
data statements only; transaction control and all PRAGMAs are owned by the
connection and runner. Each file and its version update commit together. Before a batch on
a nonempty database, the runner takes one verified SQLite `VACUUM INTO` snapshot
in the data directory's `backups/` folder. An unsuccessful snapshot prevents the
batch. Nothing pending and a fresh empty installation need no snapshot.
