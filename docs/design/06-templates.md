# Templates

There are two kinds of templates:

- **User-authored templates:** the campaign, transactional and sequence emails people write in the admin UI.
- **Application views:** the admin UI and public pages, which are part of the code.

## User-authored templates: Liquid

listmonk uses Go's `html/template` with Sprig functions (`{{ .Subscriber.FirstName }}`, `{{ UnsubscribeURL }}`). A TypeScript port needs an engine of its own. iglo.email uses **Liquid**, through [LiquidJS](https://liquidjs.com):

- **It is sandboxed:** templates can read the data they are given and call registered filters, nothing else. Prototype access is off (`ownPropertyOnly`).
- **It has hard limits:** `parseLimit`, `renderLimit` and `memoryLimit` stop runaway templates.
- **It is familiar:** Shopify, Jekyll and many email tools use it, so most people writing email templates have seen it.
- **No reimplementation:** reimplementing Go template semantics in TypeScript to keep old templates working is not worth it. There are no existing iglo.email templates to keep compatible.

HTML templates render with `outputEscape: "escape"`, so values are HTML-escaped unless piped through `raw`. Plain-text templates render without escaping.

M0.8 measured the selected library and found qualifications to the sandbox and hard-limit claims above ([evidence](../perf/M0.8-liquidjs.md)): filesystem lookup must be explicitly denied or mapped, `ownPropertyOnly` does not sanitize iteration, `memoryLimit` does not cap all output, and `renderLimit` is cooperative. The report proposes concrete M1.8 boundaries for the lead to decide; no production guarantee is established by this fixture.

### Data and functions

| listmonk (Go template) | iglo.email (Liquid) |
|---|---|
| `{{ .Subscriber.Name }}`, `.Email`, `.UUID` | `{{ subscriber.name }}`, `subscriber.email`, `subscriber.uuid` |
| `{{ .Subscriber.FirstName }}`, `.LastName` | `{{ subscriber.first_name }}`, `subscriber.last_name` |
| `{{ .Subscriber.Attribs.city }}` | `{{ subscriber.attribs.city }}` |
| — | `{{ subscriber.external_id }}` |
| `{{ .Campaign.Name }}`, `.Subject`, `.UUID` | `{{ campaign.name }}`, `campaign.subject`, `campaign.uuid` |
| `{{ .Tx.Data.order_id }}` | `{{ data.order_id }}` |
| — | `{{ trigger.data.price }}`, `{{ sequence.name }}`, `{{ step.position }}` (sequence sends) |
| `{{ template "content" . }}` (in campaign layouts) | `{{ content }}` |
| `{{ UnsubscribeURL }}` | `{{ unsubscribe_url }}`, campaigns and marketing sends |
| `{{ UnsubscribeURL }}?manage=true` | `{{ manage_url }}` |
| `{{ OptinURL }}` | `{{ optin_url }}` |
| `{{ MessageURL }}` | `{{ message_url }}` (view in browser; campaigns) |
| `{{ ArchiveURL }}` | `{{ archive_url }}` |
| `{{ TrackLink "https://…" }}` | `{{ "https://…" \| track_link }}` |
| `{{ TrackView }}` | `{{ track_view }}` |
| `{{ Date "2006-01-02" }}` | `{{ "now" \| date: "%Y-%m-%d" }}` |
| `{{ L.T "key" }}` | `{{ "key" \| t }}` |
| `{{ Safe "<b>…</b>" }}` | `{{ "<b>…</b>" \| raw }}` |
| Sprig (`default`, `upper`, `trim`, …) | Liquid standard filters (`default`, `upcase`, `strip`, …) |

`unsubscribe_url` in a transactional send renders an empty string and logs a warning at save time. A transactional email has nothing to unsubscribe from.

### Layouts

As in listmonk, a **campaign template** is a layout containing `{{ content }}`, and a campaign or sequence step supplies the body. A **transactional template** is a complete message with its own subject. Sequence steps use either:

- a transactional template;
- a campaign template plus a body stored on the step. This lets a sequence share the newsletter's layout.

### Content types

`richtext` (Squire editor, stored as HTML), `html`, `markdown` (rendered with `marked` after Liquid), and `plain`. Visual (drag-and-drop) templates are later.

### Built-in templates

listmonk's default campaign, archive and transactional templates and its system emails are converted to Liquid and embedded:

- opt-in confirmation;
- campaign status notification;
- import status;
- forgot password;
- subscriber data export;
- SMTP test.

## Application views: server-side TSX

The admin UI and public pages are rendered on the server, as in listmonk v7. Its Go `html/template` views (26 views, 37 partials, 12 public templates) are ported to TSX components:

- **Bun compiles TSX natively.** An in-house JSX runtime renders to strings and escapes text and attributes by default. A `raw()` helper marks trusted markup through an opaque boundary; attribute values never accept it. Callers validate URL and Alpine expression contexts separately, and browser bootstrap values use script-safe JSON. There is no React and no virtual DOM.
- **Views are typed:** each view's props are a TypeScript type, so a handler cannot forget a field that the template uses. In Go templates that mistake fails silently.
- **Markup stays close to v7's:** class names, Alpine.js `x-data` attributes and Oat components stay the same, so v7's CSS and JS assets work unchanged and its Playwright tests stay meaningful.
- **Go template helpers become plain functions:** `dict`, `list` and `printf` become ordinary TypeScript, and `.L.T` becomes `t()`.
- **i18n uses listmonk's language JSON files and keys,** so translations carry over.

M0.6 implements the JSX runtime, a reusable v7-shaped admin shell, the public message shell and the production HTML 404. No admin screen or login route is installed. The shell is exercised by a compiled synthetic fixture; the v1 browser bundles and licenses are embedded from the reproducible build described in `assets/README.md`.
