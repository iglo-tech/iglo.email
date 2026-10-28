# M1.4 compiled browser check

On 2026-10-28 the compiled executable ran with the synthetic M1.3 bootstrap
fixture and a fresh disposable database. `bun test/users/browser-server.ts`
started it on loopback. Using `agent-browser --session m14-browser`, the login
form accepted the fixture username and password and reached `/api/profile`.
A browser-side WebCrypto SHA-1 HMAC computed a code for the RFC 6238 synthetic
key `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`; the self-service factor PUT and logout
both returned 200. A fresh password login displayed the actual second-factor
form, with a TOTP input and nonce. Submitting an independently computed code
navigated to `/api/profile`, whose response showed the synthetic bootstrap user
and `twofa_type: totp`. The browser and server were closed afterward.

The compiled provisioning QR was separately decoded by libzbar with
`bun test/users/verify-qr.ts` after `bun run build`; the decoder verified the
issuer, account, random secret, period, digits and algorithm of the URI. This
optional host check requires Python 3 and libzbar; it is not a CI requirement.
No real credentials or services were used. M4.1 retains full admin integration.
