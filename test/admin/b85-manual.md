# B85 manual check: sequence step aggregates

Local, throwaway instance for the agent-browser check of the step editor. Not a shared or
production credential; the data directory is temporary and deleted after the check.

- Start: `IGLO_EMAIL_ADMIN_USER=b85admin IGLO_EMAIL_ADMIN_PASSWORD=b85-local-only-pass dist/iglo.email --host 127.0.0.1 --port <free loopback port> --data-dir <temporary directory>`
- Admin: `b85admin` / `b85-local-only-pass`
- Checks: a transactional template saved through `/api/templates`; a sequence created in the step
  editor with `aggregates` in the new JSON editor; the saved step read back in the editor.

## Result (agent-browser, this host)

- The step editor shows an Aggregates JSON editor under the condition editor, with the help text.
- A valid step saved with aggregates redirected to the sequence page, which read the aggregates back.
- A step with `{"items": {"event": "download_finished", "fn": "sum"}}` was refused with
  `Invalid fields: steps.0.aggregates.items.field (is required for sum and distinct)`, and the page
  stayed on the new form.
