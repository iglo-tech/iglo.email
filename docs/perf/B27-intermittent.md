# B27: intermittent watch lines

Each line in the hardening backlog that only watched for a repeat got one bounded attempt: the file alone 10 times, an e2e spec on one stack (`E2E_WORKERS=1`) 5 times, each once on the host as it was and once with 6 CPU burners (`bash -c 'while :; do :; done'` under `timeout`, killed by a trap; none survived). Every batch held `~/.local/state/iglo-email-cos/verify.lock`; none waited for a quiet host. Tests ran with `--timeout=30000`, as the parallel runner does. Host: 6 CPUs shared with other projects, load recorded per batch. No failure in any run, so no fix was needed.

| Case | Command | Runs, host load 1 min (start to end) | Result |
|---|---|---|---|
| `route-auth` (whole file) | `bun test test/messaging/route-auth.test.ts` | 10 as is (1.9 to 2.2); 10 with 6 burners (2.9 to 7.6) | 20/20 |
| `import.test.ts` SIGTERM case | `-t "SIGTERM stops an import"` | 10 as is (2.2 to 2.2); 10 with burners (7.6 to 8.7) | 20/20 |
| `templates-campaigns` | `bun test test/admin/templates-campaigns.test.ts` | 10 as is (2.2 to 2.9); 10 with burners (8.7 to 8.5) | 20/20 |
| `users.e2e.js` | `E2E_WORKERS=1 bun run e2e test/e2e/specs/users.e2e.js` | 5 as is (8.5 to 3.7); 5 with burners (6.0 to 11.2) | 10/10 |
| `maintenance.e2e.js` + `campaign-safety.e2e.js` | both files in one run | 5 as is (3.7 to 6.0); 5 with burners (11.2 to 9.8) | 10/10 |

Host-load lines, checked without runs:

- B15 backup timeouts: `backup.test.ts` and `interrupted.test.ts` set a 60 s default timeout, `hold.test.ts` 120 s, and the parallel runner's is 30 s. Their waits are deadline polls of 5 to 25 ms; the only fixed sleeps (`QUIET_MS` in `hold.test.ts`) assert that something does not happen. The failures came at load 25 to 43 from other projects' suites; both files passed alone. Closed as a host-capacity event.
- B13 e2e stall: the specs have no `test.setTimeout`, so Playwright's 30 s default applies, and the only fixed waits are three 300 ms to 3 s `waitForTimeout` calls in `campaign-safety.e2e.js` (the "live stats" test), which assert that polling stopped. A 2.5 minute stall against a 30 s timeout is the host, not a wait in the test; 10/10 passed here, 5 of them with 6 burners. Closed as a host-capacity event.

No test code changed for the watch lines. The one code change is `test/tx/measure-memory.ts` (bodies built when sent, see [B26](B26-tx-memory.md)).

## Known intermittent history

- `route-auth` "held SMTP body denies disabled before a connection": failed once in M1.9 (`smtp.count()` 1); the SMTP peer lists each counted client (remote port, opening line) since B8, so a repeat names who connected; 52 runs since (22 B8, 20 B13, 20 B27 with 10 under load), no failure, no cause found.
- `users.e2e.js` "edits a user" / "the screen does not raise your own permissions": `page.goto` interrupted by the page's own reload; B13 waits for the page `load` event at the four save-then-reload sites; clean since (76 B13 runs, 10 B27 runs, 5 under load).
- `import.test.ts` SIGTERM restart: failed once under load in the B11 review (`status()` had no `data`); `status()` has thrown with the HTTP status and body of such a reply since B13, so a repeat names the cause; 27 B13 runs of the lifecycle cases and 20 B27 runs, 10 under load, no failure.
- `templates-campaigns` connection reset (B12): last seen at load ~12 under the 5 s default timeout, read as a timed-out test whose fixture closed under a request in flight; the file's 60 s timeout (B8) turns a stall into a visible "timed out after 60000ms"; clean since (6 idle, 12 under load in B13, 20 in B27, 10 under load).
- Backup test timeouts (B15 round 2): load 25 to 43 from other projects' suites; the files' timeouts are 60 to 120 s and the polls are deadline-based; host-capacity event.
- `maintenance.e2e.js:207` / `campaign-safety.e2e.js:281` stall (B13 review): about 2.5 minutes at load 12 to 14 from other projects' suites, then 23/23 on rerun; no fixed waits that could stall; 10 clean B27 runs, 5 under load; host-capacity event.
