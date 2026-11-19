# B97–B100 common rules

Source: the first production adopter's second report, 2026-11-17 (v1.2.1 in Docker behind a PaaS's Traefik, SES, ten sequence step templates and one transactional template, built entirely through the REST API with scripts). Keep any adopter or product name out of code, docs, commits and PRs; describe use cases generically.

Repository https://github.com/iglo-tech/iglo.email. One worker per task, one PR, no helpers. In your supplied isolated checkout, fetch origin/main and create the branch named in your brief from it. Run `bun install --frozen-lockfile` first.

## This host

The work runs on the owner's macOS workstation (Apple silicon). Its test harness needs Linux (`/proc`; D89), so **every full check and acceptance command runs in a disposable Linux arm64 container** (OrbStack Docker, the platform of CI's arm64 job), as the non-root `bun` user (root defeats the permission-based failure tests). Lead decision 2026-11-17: on macOS, 122 of 1193 tests fail on host limits; in this container `bun run check` was 1259 pass / 0 fail on B97's head. Edit and commit in your checkout as usual; to verify, export the exact commit and run inside the container (one role at a time, foreground, Bash timeout 600000 ms):

```sh
D=$(mktemp -d); git archive HEAD | tar -x -C "$D"
docker run --rm -u bun -e HOME=/tmp -v "$D":/work -w /work oven/bun:1.4.4 bash -lc 'bun install --frozen-lockfile >/dev/null && bun run check 2>&1 | tail -30'
# then each acceptance command the same way, e.g. bash -lc 'bun run contract:normal'
```

The first `bun install` in a fresh export needs to be run once as root if the `bun` user cannot write the directory: `docker run --rm -v "$D":/work -w /work oven/bun:1.4.4 bash -lc 'bun install --frozen-lockfile && chown -R 1000:1000 /work'`. Remove the export afterwards.

**Reference-harness commands** (`reference:*`, `contract:*:reference`, `sends:production`, `messaging:fixture`, anything through `reference:run`) need Docker for Postgres. They run in the same container as root with host networking and the Docker socket (lead probe 2026-11-17: `reference:prepare` and `reference:smoke` pass this way, upstream linux/arm64):

```sh
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v "$D":/work -w /work oven/bun:1.4.4 bash -lc 'apt-get -qq update >/dev/null && apt-get -qq install -y docker.io git >/dev/null 2>&1 && bun install --frozen-lockfile >/dev/null && bun run reference:prepare && bun run sends:production'
```

The harness labels and removes its own containers and volumes; touch no other Docker object. No other Docker use (no `bun run e2e` unless the brief says so, no prune). On macOS itself, quick focused `bun test <dir>` runs are fine while iterating. These are native features with no upstream counterpart; read upstream source only if your brief names it (fetch the pinned file from GitHub at commit 6fcd95f, never from memory).

## Rules

- Create and modify files (probes, scripts, notes included) with the Write/Edit tools, never shell redirects, heredocs or `tee`, and keep scratch files inside your own session scratchpad directory, not arbitrary `/tmp` or `/private/tmp` paths: both can stop on a permission prompt nobody can answer (B105 reviewer stalled 30 min, B105 worker again).

- AGENTS.md applies. Read your brief, then only the design sections it names.
- **Test first**, through public boundaries: the HTTP API, the MCP endpoint, SMTP sink mail, rendered pages, the CLI/executable, loops with an injected clock. Use the existing fixtures in the test directories your brief names.
- Keep the guarantees: marketing at-most-once, no network inside transactions, injected clocks, module ownership of tables/SQL, bounded memory, no new runtime dependency.
- Update the design docs your brief names in the same PR so code and design agree, plus the OpenAPI document (`src/openapi/*`; MCP tools are generated from it, D98) for any API change.
- A decision record goes in `docs/design/09-decisions.md` as "(lead, 2026-11-17)" with the number your brief gives. State the decision, what is unchanged, considered alternatives and why.
- Do not edit `docs/status.md`.
- Owner rule "Local first": push only code that passed `bun run check` and the brief's acceptance on this host; never trigger CI.
- Open a PR to `main` titled as your brief says; the body lists what changed, the acceptance summary lines, any macOS-only limits, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Commits end with `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`. No CI wait, no workflow trigger, no merge.
- Last line: PR <URL>, head <SHA>, local checks <state>.

## Acceptance (every task unless the brief adds more)

`bun install --frozen-lockfile`, `bun run check`, `bun test test/server`, `bun test test/contract`, `bun run contract:normal`, `bun run contract:roles`. Paste the summary lines in the PR.
