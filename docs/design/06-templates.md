# Templates

There are two kinds of templates:

- **User-authored templates:** the campaign, transactional and sequence emails people write in the admin UI.
- **Application views:** the admin UI and public pages, which are part of the code.

## User-authored templates: Liquid

> M1.8 provides the template API, renderer and converted SMTP diagnostic on
> this task branch. Local D23/D54/D55 acceptance and measurements have been
> run. Hosted exact-head CI and independent review remain pending; this branch
> is not yet accepted.


listmonk uses Go's `html/template` with Sprig functions (`{{ .Subscriber.FirstName }}`, `{{ UnsubscribeURL }}`). A TypeScript port needs an engine of its own. iglo.email uses **Liquid**, through [LiquidJS](https://liquidjs.com):

- **Its capabilities are explicit:** M1.8 supplies bounded serialized JSON, dense arrays, reviewed filters and an allowlisted in-memory template resolver. `ownPropertyOnly` additionally restricts property lookup; it does not sanitize inherited array iteration. No filesystem or URL fallback is allowed ([D23](09-decisions.md#d23-liquid-template-boundaries-are-enforced-by-the-application)).
- **Resource bounds are enforced by the application:** finite input/filter budgets and byte-counted output emission must complement the engine limits. `parseLimit` counts UTF-16 units, `renderLimit` is cooperative, and `memoryLimit` accounts selected operations without capping all output or heap use. M1.8 must implement and test those bounds before production use (D23). [D54](09-decisions.md#d54-template-ownership-safe-updates-and-bounded-liquid-rendering) sets the finite input/output/work budgets, safe store/preview semantics and authorized dependency seams. The supported tag/filter/resolver subset is documented rather than assuming every Liquid extension is safe.
- **It is familiar:** Shopify, Jekyll and many email tools use it, so most people writing email templates have seen it.
- **No reimplementation:** reimplementing Go template semantics in TypeScript to keep old templates working is not worth it. There are no existing iglo.email templates to keep compatible.

HTML templates render with `outputEscape: "escape"`, so values are HTML-escaped unless piped through `raw`. Plain-text templates render without escaping.

M0.8 measured the selected library and found the precise library-limit semantics and capability boundaries ([evidence](../perf/M0.8-liquidjs.md)): filesystem lookup must be explicitly denied or mapped, `ownPropertyOnly` does not sanitize iteration, `memoryLimit` does not cap all output, and `renderLimit` is cooperative. D23 sets the required M1.8 boundaries; the fixture does not itself implement the production guarantee.

### Current M1.8 branch subset (acceptance pending)

| Capability | Current behavior |
|---|---|
| Tags | `if`, `unless`, `for`, `assign`, `capture`, `comment`, `raw`, `break`, `continue`; other tags, including user `include`, `render` and `layout`, are rejected |
| Filters | `default`, `upcase`, `strip`, `raw`, `t`, `date`, `track_link`; other filters are rejected. These filters accept scalar inputs; `t` accepts up to four name/value pairs, with bounded argument sizes and literal placeholder substitution |
| Dates | `now` and `today` use the injected clock; supported format directives are `%Y`, `%m`, `%d`, `%H`, `%M`, `%S` and `%%` in UTC. Other date strings must be a date or UTC ISO timestamp |
| Lookup | No user partial lookup. Converted system templates are embedded and selected by the owning application, not by user-supplied paths or names |
| Data | Primitive JSON strings are limited to 256 KiB UTF-8 before parsing and copied to owned dense arrays and null-prototype records; depth 16, 10,000 nodes, 1,024 entries, and 64 KiB per string |
| Render | Source 64 KiB body/layout and 2 KiB subject; 1 MiB output per body/layout and 2 KiB subject; shared 4 MiB emission/intermediate budget, 10,000 work, depth 32 and 1,024 per range. Work includes expression tokens, property lookup, collection conversion and comparison size. Four admitted renders per instance. A caller can hold a compiled immutable snapshot; there is no retained cache |
| Markdown | Liquid with HTML escaping, then local `marked` 15.0.12, then the optional HTML layout. The lexer shares the message work/byte/depth budget through the pinned patch; a conservative token reservation counts repeated reference URLs, escaping, nested parser output and prefixes before parsing. Conservative estimates can reject messages below the nominal byte limits |
| Tracking and URLs | `track_link` accepts HTTP(S) and `track_view` renders nothing unless the sending owner supplies per-message tracking (M2.4 tx sends: tracked `/m/:sendUUID` links and listmonk's hidden pixel image, inserted after rendering via a per-render marker). Explicit URL fields are checked |

The emitter, subset, JSON boundary and patches await hosted checks and
independent review before they are treated as an accepted boundary. The time limit remains
cooperative, and raw author HTML is not sanitized. Preview CSP protects its
sandboxed browser context; it is not a guarantee about HTML used elsewhere.
Marked does not sanitize raw HTML or arbitrary author-provided URLs.

[D55](09-decisions.md#d55-bound-serialized-template-context-before-reflection-and-preserve-sandbox-ci)
refines D54's renderer entry: untrusted context is a primitive, byte-bounded
JSON string checked before parse/reflection. Arbitrary JavaScript objects are
rejected without enumeration/coercion/getters; trusted callers compose explicit
bounded fields. Bounded decoded data is copied into dense/null-prototype values
with the same depth/node/string/entry rules. This is an internal renderer
interface, not a changed CRUD/preview HTTP envelope or completed acceptance.

### Loop metadata and arguments

Only the reviewed `forloop.index`, `index0`, `rindex`, `rindex0`, `first`,
`last` and `length` properties are exposed. Helper methods such as `valueOf`
and `next`, and the source-bearing loop name, are not template capabilities.
Implicit loop-record conversion reserves a conservative JSON-escaping bound
and work before the library creates the string, so truthiness or indirect
conversion cannot bypass the shared intermediate budget.

Filter arity is checked before argument evaluation or argv allocation, and
every evaluated argument consumes work. `raw`, `upcase`, `strip` and
`track_link` accept no extra arguments; `default` and `date` accept at most
one. `t` accepts zero to eight arguments in name/value pairs. This applies to
literal arguments too; ignored extra arguments do not provide free work.

The `for` tag admits only `offset`, `limit` and `reversed`. Unknown names,
including magic property names, reject while parsing rather than entering the
runtime hash. Duplicate supported names retain Liquid's final-value behavior.
Each nonempty loop reserves shared work for its bounded hash construction,
validation and every accepted argument before the library allocates its runtime
object/key list or evaluates values. Literal and flag forms are charged too;
ordinary modifiers and `offset:continue` retain their supported behavior.
Modifier values are finite scalars or missing/null; arrays and objects reject
before implicit slice-count coercion can allocate an uncharged joined string.
String values also consume work proportional to their UTF-8 byte length.
An unset `offset:continue` register starts at zero, preserving first-use behavior
without relying on implicit conversion of an empty object.

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
| `{{ template "content" . }}` (in campaign layouts) | `{{ content \| raw }}` (already rendered HTML body) |
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

As in listmonk, a **campaign template** is a layout containing `{{ content }}`, and a campaign or sequence step supplies the body. A **transactional template** is a complete message with its own subject. An already rendered HTML body is inserted as `{{ content | raw }}`; values were escaped within that body, and the raw insertion prevents double escaping during trusted layout composition. Sequence steps use either:

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
