# B129 template credit migration (0026)

Migration 0026 on a `templates` table holding the three seeded bodies of an earlier release took 0.17 ms (one run, in-memory SQLite under `bun` 1.4.5 on macOS arm64) and rewrote exactly those three rows.
