# B117f manual check: administrator notification addresses in the settings form

The admin form's comma split runs in the browser (`assets/admin/js/views/settings.js`). It is covered
by the settings browser spec, `test/e2e/specs/settings.e2e.js` ("saves notification addresses whose
display name holds a comma, one entry per address"), which fails on the pre-fix split. This manual check
is extra evidence, with agent-browser. The server side (the array the API stores) is pinned by
`test/admin/settings-input.test.ts`.

Local, throwaway instance, not a shared or production credential. The data directory was temporary and
deleted after the check.

- Start: `IGLO_EMAIL_ADMIN_USER=b117fadmin IGLO_EMAIL_ADMIN_PASSWORD=b117f-local-only-pass dist/iglo.email --host 127.0.0.1 --port <free loopback port> --data-dir <temporary directory>`
- Admin: `b117fadmin` / `b117f-local-only-pass`
- Steps: open `/admin/settings`; in "Admin notification e-mails" enter
  `"Ops, Team" <ops@example.test>, other@example.test`; Save; read `GET /api/settings`; then
  Save again from the form, unchanged, and read `GET /api/settings` again.

## Result (agent-browser, this host, B117f head)

- First save: `app.notify_emails` is `["\"Ops, Team\" <ops@example.test>", "other@example.test"]`:
  two addresses, the display name kept with its comma. Before this change the form split at the comma
  into `"Ops` and `Team" <ops@example.test>`, which the server refuses (the B117a review saw its 400
  on the form save; this check was not repeated on the old script).
- The field showed the stored value after the save, and a second save from the form left the stored
  value unchanged.
