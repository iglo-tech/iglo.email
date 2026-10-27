# M0.6 reference-first evidence

All requests below used a fresh synthetic installation of listmonk
v7.0.0-beta.1 at `6fcd95f32bb633d3a62a06c383c0b3322eecc898`, started and
cleaned by the repository's reference runner. No real data or credentials were
used. Run `bun run reference:run -- bun test/ui/reference-observe.ts` to repeat.

- `POST /health` and `GET /missing-public-page`: 404, `text/html; charset=UTF-8`,
  an HTML document titled `404 - Not found - Mailing list`, a visible
  `404 - Not found` heading, local versioned stylesheet and logo, and a
  `Powered by listmonk` footer.
- `HEAD /missing-public-page`: 404, the same HTML content type, empty body.
- `GET /public/static/style.css` and `GET /admin/static/oat.min.css`: 200,
  `text/css; charset=utf-8`, nonempty CSS. HEAD on each returns 405, no content
  type and an empty body. POST returns 405 and the JSON method error.
- Missing static files, the public static directory, and
  `/public/static/%2e%2e/style.css` return plain-text 404, not a directory
  listing or successful page. For the same traversal request, compiled
  iglo.email returns HTML 404 because Bun removes the encoded dot segment before
  routing (the existing D18 boundary). Both responses refuse the asset; there is
  no successful traversal or disk lookup.

The initial specification run, `bun test test/jsx test/ui`, failed as expected:
production returned plain text for `POST /health`, and no JSX runtime existed.
The JSX fixture exercises actual compiled TSX over HTTP, including untrusted
component strings, nested arrays/fragments, boolean and data attributes,
explicit trusted markup, malformed names, object impersonation, void children
and function event handlers.

## Manual browser verification

On 2026-10-28, after `bun run assets:build` and a compiled build, the shell
fixture and production executable were run from an invocation-owned temporary
working directory with fresh synthetic data and empty `PATH`. The installed
`agent-browser 0.38.2` guide was read with
`agent-browser skills get core --full`. A named session restricted to loopback
opened the fixture and the production `/missing-public-page`; the following
commands represent the session (ports were allocated for this invocation):

```sh
agent-browser --session m06-1b1e50f08261 --allowed-domains 127.0.0.1 open http://127.0.0.1:39145/
agent-browser --session m06-1b1e50f08261 snapshot -i
agent-browser --session m06-1b1e50f08261 click @e3
agent-browser --session m06-1b1e50f08261 find role button click --name dark
agent-browser --session m06-1b1e50f08261 open http://127.0.0.1:44779/missing-public-page
agent-browser --session m06-1b1e50f08261 errors
agent-browser --session m06-1b1e50f08261 console
agent-browser --session m06-1b1e50f08261 close
```

The fixture loaded the local Oat and application stylesheets, main JavaScript,
its local chunk, the Geist font and logo. The Oat profile menu opened and the
Alpine dark-theme button changed both local storage and the document color
scheme. The hostile synthetic config remained data and did not execute. The
production page showed the expected title, visible 404 heading, local CSS and
logo, and attribution. No console or page errors were reported. External footer
links were not followed; no authentication, domain screens or later admin
workflows were claimed. The browser session and both owned processes were closed.
