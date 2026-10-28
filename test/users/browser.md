# M1.3 compiled login browser check

Run on 2026-10-28 against the compiled executable on loopback. Credentials are
the synthetic values in [fixtures.md](fixtures.md). The server below used a
fresh temporary data directory, selected port 36653, and removed its directory
on exit. The port is different in each run. No generated nonce, session ID or
CSRF value was recorded.

```sh
bun run build
bun test/users/browser-server.ts
agent-browser --session m13-browser open 'http://127.0.0.1:36653/admin/login?next=%2Fapi%2Fprofile'
agent-browser --session m13-browser snapshot -i
agent-browser --session m13-browser eval 'Boolean(document.querySelector("input[name=nonce]")?.value) && document.querySelector("input[name=next]")?.value === "/api/profile"'
bun test/users/browser-fill.ts wrong
agent-browser --session m13-browser click 'button[type=submit]'
agent-browser --session m13-browser snapshot
bun test/users/browser-fill.ts valid
agent-browser --session m13-browser eval '(async () => { const p = new URLSearchParams(new FormData(document.querySelector("form"))); p.delete("nonce"); const denied = await fetch("/admin/login", { method: "POST", body: p }); const profile = await fetch("/api/profile"); return { login: denied.status, profile: profile.status }; })()'
agent-browser --session m13-browser click 'button[type=submit]'
agent-browser --session m13-browser eval '({ path: location.pathname, user: JSON.parse(document.body.innerText).data.username, password: JSON.parse(document.body.innerText).data.password })'
agent-browser --session m13-browser eval '(async () => { const denied = await fetch("/api/logout", { method: "POST" }); const profile = await fetch("/api/profile"); return { logout: denied.status, profile: profile.status }; })()'
agent-browser --session m13-browser eval '(async () => { const token = document.cookie.split("; ").find((part) => part.startsWith("csrf="))?.slice(5); const logout = await fetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": token } }); const profile = await fetch("/api/profile"); return { logout: logout.status, profile: profile.status }; })()'
agent-browser --session m13-browser open 'http://127.0.0.1:36653/admin/login?next=%22%3E%3Csvg%20onload%3Dalert(1)%3E'
agent-browser --session m13-browser eval '({ injected: document.querySelectorAll("svg,script").length, fieldCount: document.querySelectorAll("input[name=next]").length, hasNonce: Boolean(document.querySelector("input[name=nonce]")?.value) })'
agent-browser --session m13-browser close
```

The server was stopped with Ctrl-C. The accessibility snapshot showed required
username/password inputs and Login. The nonce and next check returned `true`.
The wrong password rendered “Invalid login or password”. Omitting the nonce
returned 403, and the profile remained 403. A normal form submission navigated
to `/api/profile` and returned the bootstrap username with a null password.
Logout without CSRF returned 403 while the profile stayed 200; logout with the
readable session-bound CSRF cookie returned 200 and the profile then returned 403. The encoded HTML injection probe reported zero injected SVG/script nodes,
one next field and a nonempty nonce. This checks the login boundary, not the
deferred dashboard, reset or TOTP screens.
