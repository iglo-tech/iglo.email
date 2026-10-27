# Open questions

Questions that change scope or order and need the owner. Everything else is decided in [Decisions](09-decisions.md). Each one has a default, so work is not blocked.

1. **Where does the first instance run?**
   - **Default:** a VPS with a persistent volume, behind the existing reverse proxy, with nightly `iglo.email backup` to off-site storage.
   - **Why it matters:** the backup and restore steps in the operations guide (M6), and whether Litestream is documented as the recommended setup.

2. **Are public subscription forms needed in v1?**
   - **Default:** yes, the pages are ported, but CAPTCHA (Altcha) stays "later". The first consumer adds people through the API, not through forms.
   - **Why it matters:** if forms will be public on day one, CAPTCHA moves into v1, because open forms attract signup spam.

3. **Is any existing listmonk data to be imported?**
   - **Default:** no. The listmonk importer stays "later".
   - **Why it matters:** if there is data, the importer and the Go-template-to-Liquid converter move into M1.

4. **Is the repository public from day one?**
   - **Default:** public, like the other iglo.\* repositories. AGPL-3.0 already requires offering the source to network users of a modified version.
   - **Why it matters:** if it should be private until 1.0, that is fine under the AGPL as long as no one else uses a running instance.
