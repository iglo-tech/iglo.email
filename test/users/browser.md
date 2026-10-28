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

## Council correction verification

The lead repeated the compiled browser flow on 2026-10-28 with fresh synthetic
data at `http://127.0.0.1:35859`, using the same documented commands and
`m13-browser` session. The initial open was changed to:

```sh
agent-browser --session m13-browser open 'http://127.0.0.1:35859/admin/login?next=%2Fapi%2F%2570rofile'
```

The GET form canonicalized the escaped destination to `/api/profile`. After
the wrong-password and missing-nonce checks, valid login navigated there and
returned the bootstrap identity with a null password. Navigation was verified
with `agent-browser --session m13-browser wait --url '**/api/profile'`; the
wrong-password response used `wait --text 'Invalid login or password'`.
Missing-CSRF logout returned 403 with profile still 200; valid-CSRF logout
returned 200 with profile then 403. The encoded HTML probe still produced zero
injected SVG/script nodes, one next field and a nonce. The browser was closed,
the disposable server stopped with Ctrl-C and its loopback health was confirmed
unreachable. The HTTP common corpus separately submits the escaped destination
directly on POST, asserts the exact Location header, and follows it with the
issued session. No generated secret was recorded.

## Round-2 redirect cleanup verification

The lead repeated the documented compiled browser flow with fresh data at
http://127.0.0.1:33165 on 2026-10-28. The initial form destination for the
successful flow was /api/profile/., opened with:

```sh
agent-browser --session m13-browser open 'http://127.0.0.1:33165/admin/login?next=%2Fapi%2Fprofile%2F.'
```

The nonce/next check returned true and valid form submission navigated to
/api/profile with the synthetic bootstrap identity and null password. The
wrong-password, missing-nonce, missing-CSRF, valid-CSRF logout and escaped HTML
checks returned the same expected results recorded above. Navigation waits were
used. The browser was closed; Ctrl-C stopped the owned server, and its health
endpoint was confirmed unreachable.

Before that flow, after opening /admin/login, this script was passed to
`agent-browser --session m13-browser eval`. It returned
`{ "checked": 10, "passed": true }`. Only GET forms were inspected; the shared
HTTP corpus separately verifies direct POST Locations and issued identities.
The form was reopened afterwards so its nonce matched the latest cookie.
No generated nonce or cookie was printed.

```js
(async () => {
  const cases = [
    ["/api/profile/", "/api/profile"],
    ["/api/profile/.", "/api/profile"],
    ["/a/../api/profile", "/admin"],
    ["/%2e%2e/api/profile", "/admin"],
    ["/api/%0d%0aprofile", "/admin"],
    ["/api/%5cprofile", "/admin"],
    ["//outside.example.test/api/profile/", "/api/profile"],
    ["/api/profile%3Fq%3Dx", "/api/profile%3Fq%3Dx"],
    ["/api/profile%23fragment", "/api/profile%23fragment"],
    ["/api/%2570rofile", "/api/%2570rofile"],
  ];
  for (const [next, expected] of cases) {
    const response = await fetch("/admin/login?" + new URLSearchParams({ next }));
    const html = new DOMParser().parseFromString(await response.text(), "text/html");
    if (response.status !== 200 || html.querySelector("input[name=next]")?.value !== expected)
      throw new Error("Redirect form probe failed");
  }
  return { checked: cases.length, passed: true };
})();
```
