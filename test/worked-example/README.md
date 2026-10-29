# Worked example (M5.6)

`bun run worked-example` builds `dist/iglo.email` and runs `run.ts`: the
[05-sequences worked example](../../docs/design/05-sequences.md#worked-example) end to end
against the compiled production executable, through its public HTTP API only (settings,
lists, subscribers, templates, sequences, subscriber events, enrollments and the public
unsubscribe routes). It takes about two minutes and needs no Docker or network.

- The executable runs from a copy in a temporary directory with its own data directory, an
  admin from `IGLO_EMAIL_ADMIN_*` and an API user created through the real login. It is
  stopped gracefully (SIGTERM) once mid-run and restarted on the same data and port. The
  sequence holding the due step is paused through the API before the stop and resumed after
  the restart, so the scenario never races the scheduler's tick.
- Mail goes to the loopback SMTP sink (`test/tx/sink.ts`) configured through
  `PUT /api/settings/smtp`. Every email is checked by its received message: envelope
  recipient, subject and a `marker:<template>` body marker. The run ends by checking that
  every expected message arrived exactly once and nothing else arrived.
- Waits are shortened: `P3D`, `P5D` and `P45D` become `PT10S`; the edit scenario changes a
  wait to `PT40S`, and the step that replaces a deleted one waits `PT40S`, longer than the
  timing allowance. `marketing.min_interval` is `PT30S`. The scheduler's 15-second interval
  is real, so a waited step arrives within about 25 seconds of its trigger.
- The process must log nothing to stderr (application code logs only what needs attention).
- Everything it creates is removed with the temporary directory; no process is left behind.

Scenarios, subscribers and expected mail: [data.md](data.md). Left out: the
`subscriber.unsubscribed` webhook (M2.6, not built yet).
