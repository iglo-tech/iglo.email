# `bun run e2e` speed

Task: cut the wall time of `bun run e2e` (334 tests) without dropping a test or weakening an
assertion. The suite is browser-bound and CPU-bound, not wait-bound: it spends about 3 s per test,
spread evenly, and `waitForTimeout` totals about 15 s (all of it negative assertions such as
"polling stays stopped", which need the time to pass).

## Result

At the default of 2 stacks, `bun run e2e` with no override, two runs in a row on the final code,
`nice -n 10`, no other iglo.email verification running (checked by working directory), 334 passed
each time:

| Run | Wall time | Test time summed | Host load (1-minute, sampled every 10 s) |
|---|---|---|---|
| After, 2 stacks, run 1 of 2 | **10.1 min** | 1205 s | 11.0 to 16.5, mean 14.1 |
| After, 2 stacks, run 2 of 2 | **9.8 min** | 1166 s | 9.4 to 15.1, mean 12.1 |

The host load came from other agents' work (paszomistrz and iglo-base builds and tests, Playwright
runs of other projects); none of it was iglo.email verification. The load is what sets the wall time here: the same suite,
the same two stacks, took 7.9 min in an earlier run (before the campaigns change below) whose load fell from about 12 to 5 during the
run.

| | Wall time | Tests | Host |
|---|---|---|---|
| Before, one stack, serial (`m55`, 2026-10-31) | 13.5 min | 285 | not recorded |
| Before, one stack, serial (`m64`, 2026-10-31) | 14.1 min | 285 | not recorded |
| Before, one stack, serial (2026-11-05, this branch's parent) | **17.0 min** (1007 s of test time) | 334 | loaded; up to about 40 min reported under load |
| After, 2 stacks, run 1 (default) | **10.1 min** | 334 passed | load 11 to 16.5 |
| After, 2 stacks, run 2 (default) | **9.8 min** | 334 passed | load 9 to 15 |
| After, 2 stacks, earlier run | 7.9 min | 334 passed | load 12 falling to 5 |
| After, 3 stacks, two passes in a row (override) | **5.6 min**, **5.6 min** | 334 passed | load 4 to 9 |
| After, 3 stacks, same code on a busier host | 6.8 and 8.4 min | 334 passed | load 11 to 13 |
| After, 4 stacks (override) | 5.0 min | one failure, fixed | load 11 |

The 17.0 min figure was also measured on a loaded host, with unknown priority, so the two ends of
the comparison are not at the same load; a 2-stack run at load 14 takes 10 min, 41% under the 17.0 min serial run, and the runs at
lighter load (7.9 min for 2 stacks, 5.6 min for 3) show what the stacks do when the host has room. Wall time is what the runner prints; the
executable build before it is not included. The 3-stack and 4-stack rows are from before the `campaigns.e2e.js` change below and are kept as the documented overrides. All runs used `nice -n 10`, so the other agents' work
was not slowed; a run at normal priority would be faster.

## What changed, and what it saved

1. **Independent stacks** (`test/e2e/stack.ts`, `test/e2e/run.ts`). `E2E_WORKERS` stacks (default 2),
   each with its own server, data directory, SMTP sink and fresh-install instance, take spec files
   from a longest-first queue. A file still runs serially in one Playwright process, so describe
   groups, serial mode and their shared setup are unchanged. One shared server cannot take parallel
   workers: settings, captcha, bounces, sequences, forms and others change server-wide settings.
   This is the main gain.
2. **`subscribers.e2e.js` split** into three files. One of its describe blocks ("filtered bulk
   actions", 42 of 78 tests, 138 s of the old 208 s) is generated from a scope x action grid, and
   each case builds its own data. The case body now lives in `test/e2e/subscribers-helpers.js` and
   two files run half of the scopes each (24 and 18 tests). The same 78 tests run; none was
   changed. Before the split the one file was the floor at 208 s; the longest file is now
   `campaigns.e2e.js`.
3. **API sign-in instead of the login form** (`signIn` in `test/e2e/helpers.js`). About 90 form
   logins were setup. The form costs 694 ms and 0.7 CPU-s per login (it draws the login page and the
   dashboard), the API request 287 ms and a fraction of that (measured over 12 logins each on one
   stack at load 10). Each test still gets its own fresh session, its own client address, and the
   same CSRF cookie. The login, two-factor, password-reset and logout specs, and the tests that log in as a
   second user to land on a given screen, still go through the form (`login`). `logout` opens `/admin` first when the page holds
   no admin screen.
4. **Seeding in one round trip** (`seedSubscribers`). 25 subscribers through 25 `page.evaluate`
   calls took 749 ms; one evaluate that posts them in order takes 275 ms. Order and the check on
   every answer are unchanged. The 42 filtered bulk cases and several others seed this way.
5. **Playwright trace without screencast frames** (`test/e2e/playwright.config.js`). With
   `trace: "retain-on-failure"` Playwright records a screencast for every test and throws the
   trace away when the test passes. Measured on `templates.e2e.js` (6 tests), by process kind:

   | | total CPU | Chromium gpu-process | Chromium renderer | Playwright worker |
   |---|---|---|---|---|
   | default trace | 37.4 s | 9.6 s | 8.1 s | 6.5 s |
   | no screencast frames, DOM snapshots kept (now) | 29.1 s | 3.6 s | 8.5 s | 6.1 s |
   | no snapshots at all | 25.0 s | 3.6 s | 6.7 s | 4.7 s |
   | trace off | 25.7 s | 3.7 s | 7.1 s | 4.4 s |

   The first row is the 27% gpu-process share the earlier measurement found. Launch flags did not
   touch it: `--disable-gpu`, `--disable-gpu --disable-software-rasterizer`,
   `--disable-gpu-compositing --disable-gpu-rasterization` and `--use-gl=disabled --disable-gpu`
   all stayed at 9.5 to 10.6 s of gpu-process CPU. The trace keeps DOM snapshots, network and
   console, so a failure is still diagnosable, plus the failure screenshot and
   `error-context.md`; `--trace on` on a rerun adds nothing that is not recorded now except the
   frames. Dropping snapshots too would save a further 14% and was not done.

Not done: batching small files into one Playwright process (saves the roughly 3 CPU-s of starting a
browser per file, about 7% of the CPU, but coarsens the queue); sharing one session across tests
(forbidden by the brief).

## Cost of a stack

Measured with a sampler that walks the run's process tree every 0.4 s and sums proportional set
size (shared pages counted once), so these are lower than the 1.2 GiB per stack the earlier
RSS-based estimate gave:

| Stacks | Peak memory (PSS) | Wall time | Result |
|---|---|---|---|
| 2 | 2.2 GiB | 7.9 min | 334 passed |
| 3 | 2.8 and 2.9 GiB | 5.6 min, 5.6 min | 334 passed twice |
| 4 | 3.2 GiB | 5.0 min | one failure, see below |

Total CPU is nearly constant, 1120 to 1200 CPU-seconds for a run, so the stacks buy wall time only
while the host has idle cores: 3 stacks average about 3.3 cores at 5.6 min, which on a 6-core VM
that the other agents use leaves little for a 4th. Process mix at 3 stacks (CPU-s, run 2 of 2):
Chromium renderer 337, Playwright worker 253, iglo.email servers 179, Chromium gpu-process 163,
Chromium browser 117, Playwright runner 53, Chromium utility 21.

The default is 2 (owner decision): the VM is shared with other agents, and 2 stacks keep the run at
about 3 cores and 2.2 GiB, inside the VM's 2 to 16 GiB policy. `E2E_WORKERS=3` (5.6 min) or
`E2E_WORKERS=4` (5.0 min, with the order-dependent failure below, since fixed) are overrides for an
idle host, and `E2E_WORKERS=1` runs all files on one stack.

## Order dependence found by changing the order

The 4-stack run failed `dashboard.e2e.js` "shows counts, charts, system stats and escaped campaign
names": it expected the campaign-views chart to show "Nothing here", which holds only if no earlier
spec on the same server recorded a view. The old alphabetical order happened to keep that true.
The test now reads `/api/dashboard/charts` and expects the empty state when the API has no view,
and a visible chart without the empty state when it has one, so both states are checked. Nothing
else in the suite asserted on global emptiness (the other `.empty-state` checks follow a filter
the test itself built).

## A second order- and load-dependent test: listing start, pause, resume, cancel

The first 2-stack run after the reboot, at load 16 to 18, failed `campaigns.e2e.js` "starts,
pauses, resumes and cancels from the listing": the campaign was already `finished` when the test
cancelled it. The test sends to 150 readers at the configured 10 a second, which is 15 s of
sending, and on that host the four UI steps took 19.7 s. The test now sends to 600 readers
(60 s), and `audience` makes them in one browser round trip like `seedSubscribers`, so seeding is
about 6 s instead of 18 s at the old one-call-per-reader cost. Its assertions are unchanged. It
passed at load 9 to 16 in both acceptance runs (9.4 s alone at load 11). That first run is not
counted; the two runs above are on the final code.

## Slowest spec files, 2 stacks (the default), runs 1 and 2

Seconds as seen on a loaded stack.

| Run 1 s | Run 2 s | Tests | File |
|---|---|---|---|
| 132 | 131 | 28 | `campaigns.e2e.js` |
| 107 | 108 | 12 | `sequences.e2e.js` (one test is a real 63 s wait in test mode) |
| 104 | 102 | 34 | `editor-containment.e2e.js` |
| 78 | 88 | 24 | `subscribers-filtered-bulk.e2e.js` |
| 88 | 83 | 19 | `bounces.e2e.js` |
| 78 | 81 | 36 | `subscribers.e2e.js` |
| 66 | 76 | 17 | `settings.e2e.js` |
| 65 | 68 | 18 | `subscribers-filtered-bulk-query.e2e.js` |
| 61 | 56 | 23 | `lists.e2e.js` |
| 54 | 50 | 11 | `import.e2e.js` |
| 57 | 50 | 19 | `users.e2e.js` |
| 50 | 49 | 6 | `csp.e2e.js` (one test walks every screen) |
| 43 | 36 | 22 | `campaign-editor.e2e.js` |
| 39 | 35 | 8 | `campaign-safety.e2e.js` |
| 25 | 23 | 15 | `maintenance.e2e.js` |

Process mix at 2 stacks, run 2 (CPU-seconds, 1100 in total): Chromium renderer 322, Playwright
worker 239, iglo.email servers 175, Chromium gpu-process 155, Chromium browser 114, Playwright
runner 50, Chromium utility 20. Peak memory 2.17 GiB.

The runner prints this table and writes `dist/e2e-results/timings.json` with every file and test.
The weights in `test/e2e/run.ts` only order the queue; refresh them from that file when the
balance drifts.

## Not found

- The `subscribers.e2e.js` navigation race and the campaigns clone timeout are not in
  `docs/status.md` or in the retained e2e logs. `clones full content...` passed 12 of 12 under
  `--repeat-each 12` at load 10, and `subscribers.e2e.js` passed in every full run after the
  split, so they were neither reproduced nor changed.
- The `users.e2e.js` `:388` race is fixed (wait for the toast before the second `goto`); it passed in
  all full runs.

## Limits

- No full-run CPU baseline exists for the old configuration; the CPU table above compares trace
  settings on one small file.
- Wall times depend on what else the host runs. The two accepted runs were 5.6 min each, other
  runs at 3 stacks 6.8 and 8.4 min.
