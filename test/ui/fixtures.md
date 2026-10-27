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
  listing or successful page. Bun normalizes dot segments before the router
  (D18), which may alter which non-success fallback handles a traversal spelling.

The initial specification run, `bun test test/jsx test/ui`, failed as expected:
production returned plain text for `POST /health`, and no JSX runtime existed.
The JSX fixture exercises actual compiled TSX over HTTP, including untrusted
component strings, nested arrays/fragments, boolean and data attributes,
explicit trusted markup, malformed names, object impersonation, void children
and function event handlers.
