# B129 template credit migration (0027)

Migration 0027 on a `templates` table holding the three seeded bodies of an earlier release took 0.17 ms (one run, in-memory SQLite under `bun` 1.4.5 on macOS arm64) and rewrote exactly those three rows.

Before and after the `updated_at` change on the transactional UPDATE (the file as committed at `1fa432d` against `aca1f60`): 30 runs each, every run on fresh in-memory SQLite holding the two seeded rows (the archive layout and the sample transactional template, bodies read from the migration's own WHERE literals) plus one unrelated campaign row, `bun` 1.4.5 on macOS arm64.

| Version | Median | p95 | Rows with `updated_at` set |
|---|---|---|---|
| `1fa432d` (before) | 0.040 ms | 0.062 ms | 1 (the archive layout) |
| `aca1f60` (after) | 0.036 ms | 0.039 ms | 2 |

The difference is within noise. The change adds one assignment to a statement that runs once per upgrade, on the same three rows.
