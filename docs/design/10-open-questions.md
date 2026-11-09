# Open questions

Questions that change scope or order and need the owner. Everything else is decided in [Decisions](09-decisions.md). Each one has a default, so work is not blocked.

1. **Where does the first instance run?**
   - **Default:** a VPS with a persistent volume, behind the existing reverse proxy, with nightly `iglo.email backup` to off-site storage.
   - **Why it matters:** the backup and restore steps in the operations guide (M6), and whether Litestream is documented as the recommended setup.

2. **Are public subscription forms needed in v1?**
   - **Default:** yes, the pages are ported, with ALTCHA or hCaptcha on the form (B4, [D72](09-decisions.md#d72-the-altcha-widget-is-in-house-and-replay-state-stays-in-memory)). The first consumer adds people through the API, not through forms.
   - **Why it matters:** open forms attract signup spam; turn a CAPTCHA on before making a form public.

3. **Is any existing listmonk data to be imported?**
   - **Default:** no. The listmonk importer stays "later".
   - **Why it matters:** if there is data, the importer and the Go-template-to-Liquid converter move into M1.

4. **Is the repository public from day one?**
   - **Default:** public, like the other iglo.\* repositories. AGPL-3.0 already requires offering the source to network users of a modified version.
   - **Why it matters:** if it should be private until 1.0, that is fine under the AGPL as long as no one else uses a running instance.

5. **Do uploaded PDFs need a check on phones, or a different way of serving them?**
   - **Context:** the media library serves an uploaded PDF from the app's own address and shows it in the browser (as listmonk does). Other files get a sandbox that stops scripts, but a PDF cannot have it, because browsers' PDF viewers refuse to render with that sandbox. A PDF can contain JavaScript. The risk is a user who can upload media (`media:manage`) planting a PDF that, when an admin opens it while logged in, acts as that admin. B60 showed that desktop Chromium and Firefox run PDF JavaScript but give it no access to the page, cookies or the network.
   - **Options:** (a) keep serving inline, phones untested: no work, small unknown risk on iOS/Android viewers. (b) Test on a real iPhone and Android phone: about 10 minutes of the owner's time, removes the unknown. (c) Serve PDFs as downloads (`Content-Disposition: attachment`): no unknown on any device, but a PDF link downloads instead of opening in the tab, which differs from listmonk.
   - **Default:** (a) until the owner decides. Lead recommendation: (c) if anyone other than the owner gets `media:manage`; otherwise (a).

