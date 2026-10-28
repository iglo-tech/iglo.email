# M1.4 compiled browser check

Run from the repository with Bun 1.4.4 and `agent-browser` installed. The only
credentials are synthetic values in `test/users/fixtures.md`; the factor key is
the RFC 6238 example in the two helper scripts. No challenge URL, nonce,
cookie or generated secret needs to be printed.

1. Run `bun run build` and start `bun test/users/browser-server.ts` in a
   terminal. It prints a loopback origin; replace `ORIGIN` below with it. The
   server creates a disposable data directory and removes it when stopped.
2. Run `agent-browser --session m14fix open 'ORIGIN/admin/login?next=%2Fapi%2Fprofile'`,
   then `agent-browser --session m14fix fill '#username' 'm13-bootstrap-admin'`,
   `agent-browser --session m14fix fill '#password' 'm13-bootstrap-password'`,
   and `agent-browser --session m14fix click 'button[type=submit]'`.
   `agent-browser --session m14fix eval '({profile:location.pathname==="/api/profile",content:document.body.textContent.includes("m13-bootstrap-admin")})'`
   returns both values true after navigation.
3. Run `agent-browser --session m14fix eval "$(cat test/users/m14-browser-setup.js)"`.
   It computes an independent current code in the browser, enables the factor,
   attempts a logout without CSRF, then logs out correctly. Observed statuses:
   enabled 200, csrfDenied 403, logout 200.
4. Repeat step 2. Avoid `wait --url`, snapshots or printing location: the
   factor URL contains a short-lived token. Instead use
   `agent-browser --session m14fix eval '({factor:location.pathname==="/admin/login/twofa",form:!!document.querySelector("#totp_code")})'`;
   both values are true. Run `agent-browser --session m14fix fill '#totp_code' '000000'`
   and `agent-browser --session m14fix click 'button[type=submit]'`. The redacted
   assertion `agent-browser --session m14fix eval '({error:!!document.querySelector(".error"),form:!!document.querySelector("#totp_code")})'`
   returns both true after navigation.
5. Run `agent-browser --session m14fix eval "$(cat test/users/m14-browser-submit.js)"`,
   then `agent-browser --session m14fix eval '({profile:location.pathname==="/api/profile",factor:document.body.textContent.includes("\"twofa_type\":\"totp\"")})'`.
   The code is generated in the browser; the protected profile and enabled
   factor assertions both returned true. Log out with the CSRF cookie:
   `agent-browser --session m14fix eval '(async()=>{const csrf=document.cookie.split("; ").find(v=>v.startsWith("csrf="))?.slice(5);const r=await fetch("/api/logout",{method:"POST",headers:{"x-csrf-token":csrf}});return {logout:r.status}})()'`;
   observed 200.
6. Open `ORIGIN/admin/login?next=%2F%3Cscript%3Ealert(1)%3C%2Fscript%3E`
   and run `agent-browser --session m14fix eval '(async()=>{const r=await fetch("/admin/login/twofa",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:"nonce=wrong&token=wrong&totp_code=000000"});return {nonceDenied:r.status,injectedScript:!!document.querySelector("script:not([src])"),escapedValue:document.querySelector("input[name=next]").value.includes("%3Cscript%3E")}})()'`.
   Observed nonceDenied 403, injectedScript false and escapedValue true.
7. Run `agent-browser --session m14fix close` and stop the server with Ctrl-C.

The separate `bun test/users/verify-qr.ts`, after `bun run build`, independently
decodes the actual compiled PNG with Python 3 and libzbar and verifies its
URI. This host-only check is optional and is not an ordinary CI prerequisite.
