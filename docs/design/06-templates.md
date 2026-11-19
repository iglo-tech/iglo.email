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
- **Resource bounds are enforced by the application:** finite input/filter budgets and byte-counted output emission must complement the engine limits. `parseLimit` counts UTF-16 units, the renderer sets no `renderLimit` (D110: a wall-clock deadline made render failures depend on host load, so Liquid render time is bounded by the D54 budgets alone; the Markdown stage shares the same work budget through the pinned marked patch; [D111](09-decisions.md#d111-link-titles-must-follow-whitespace-so-the-inline-link-title-scan-is-linear-per-link-attempt-lead-2026-11-19) makes the inline link-title scan linear per link attempt, and the block-level and reflink scans stay outside that bound (B105/D112)), and `memoryLimit` accounts selected operations without capping all output or heap use. M1.8 must implement and test those bounds before production use (D23). [D54](09-decisions.md#d54-template-ownership-safe-updates-and-bounded-liquid-rendering) sets the finite input/output/work budgets, safe store/preview semantics and authorized dependency seams. The supported tag/filter/resolver subset is documented rather than assuming every Liquid extension is safe.
- **It is familiar:** Shopify, Jekyll and many email tools use it, so most people writing email templates have seen it.
- **No reimplementation:** reimplementing Go template semantics in TypeScript to keep old templates working is not worth it. There are no existing iglo.email templates to keep compatible.

HTML templates render with `outputEscape: "escape"`, so values are HTML-escaped unless piped through `raw`. Plain-text templates render without escaping.

M0.8 measured the selected library and found the precise library-limit semantics and capability boundaries ([evidence](../perf/M0.8-liquidjs.md)): filesystem lookup must be explicitly denied or mapped, `ownPropertyOnly` does not sanitize iteration, `memoryLimit` does not cap all output, and `renderLimit` is cooperative. D23 sets the required M1.8 boundaries; the fixture does not itself implement the production guarantee.

### Template reference for agents

#### Supported tags and filters

| Capability | Current behavior |
|---|---|
| Tags | `if`, `unless`, `for`, `assign`, `capture`, `comment`, `raw`, `break`, `continue`; other tags, including user `include`, `render` and `layout`, are rejected |
| Filters | `default`, `upcase`, `strip`, `raw`, `t`, `date`, `track_link`, `number`; other filters are rejected. These filters act on scalar inputs; `number` passes any value that is not a finite number through unchanged, and `t` accepts up to four name/value pairs, with bounded argument sizes and literal placeholder substitution. `number` formats a finite number with English grouping and at most three fraction digits ([D102](09-decisions.md#d102-the-number-liquid-filter-lead-2026-11-16)) |
| Dates | `now` and `today` use the injected clock; supported format directives are `%Y`, `%m`, `%d`, `%H`, `%M`, `%S` and `%%` in UTC. Other date strings must be a date or UTC ISO timestamp |

#### Data and functions

| listmonk (Go template) | iglo.email (Liquid) |
|---|---|
| `{{ .Subscriber.Name }}`, `.Email`, `.UUID` | `{{ subscriber.name }}`, `subscriber.email`, `subscriber.uuid` |
| `{{ .Subscriber.FirstName }}`, `.LastName` | `{{ subscriber.first_name }}`, `subscriber.last_name` |
| `{{ .Subscriber.Attribs.city }}` | `{{ subscriber.attribs.city }}` |
| — | `{{ subscriber.external_id }}` |
| `{{ .Campaign.Name }}`, `.Subject`, `.UUID` | `{{ campaign.name }}`, `campaign.subject`, `campaign.uuid` |
| — | `{{ campaign.attribs.key }}` |
| `{{ .Tx.Data.order_id }}` | `{{ data.order_id }}` |
| — | `{{ trigger.data.price }}`, `{{ sequence.name }}`, `{{ step.position }}`, `{{ aggregates.name }}` (sequence sends; the last is the step's event totals, each reading at most 10,000 events of its name in its window, [D100](09-decisions.md#d100-sequence-steps-read-event-aggregates-lead-2026-11-16)) |
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

`unsubscribe_url` in a transactional send renders an empty string: a transactional email has nothing to unsubscribe from. Saving a `tx` template that references it logs nothing, because the same `tx` template also serves marketing sends (`POST /api/tx` with `kind: "marketing"`, sequence marketing steps), where it is filled in; the send kind, not the template, decides.

#### Layouts

As in listmonk, a **campaign template** is a layout containing `{{ content }}`, and a campaign supplies the body. A **transactional template** is a complete message with its own subject. An already rendered HTML body is inserted as `{{ content | raw }}`; values were escaped within that body, and the raw insertion prevents double escaping during trusted layout composition.

A sequence step sends a transactional template and may override its subject. Steps have no body of their own yet, so a step cannot use a campaign layout.

#### Content types

`richtext` (Squire editor, stored as HTML), `html`, `markdown` (rendered with `marked` after Liquid), and `plain`. There is no visual editor; template editing for agents is via MCP.

#### Example: Campaign template (layout)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>{{ campaign.subject }}</title>
</head>
<body>
  <header>
    <h1>{{ campaign.name }}</h1>
  </header>
  <main>
    {{ content | raw }}
  </main>
  <footer>
    <p><a href="{{ unsubscribe_url }}">Unsubscribe</a> | <a href="{{ manage_url }}">Manage preferences</a></p>
    {{ track_view }}
  </footer>
</body>
</html>
```

#### Example: Transactional (tx) template

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Order Confirmation #{{ data.order_id }}</title>
</head>
<body>
  <h2>Hello {{ subscriber.name | default: "Valued Customer" }},</h2>
  <p>Thank you for your order #{{ data.order_id }}.</p>
  {% if data.items %}
  <ul>
    {% for item in data.items %}
    <li>{{ item.name }} - ${{ item.price }}</li>
    {% endfor %}
  </ul>
  {% endif %}
  <p>Track your package: <a href="{{ data.tracking_url | track_link }}">Track Order</a></p>
</body>
</html>
```

### Internal renderer implementation notes

| Capability | Current behavior |
|---|---|
| Lookup | No user partial lookup. Converted system templates are embedded and selected by the owning application, not by user-supplied paths or names |
| Data | Primitive JSON strings are limited to 256 KiB UTF-8 before parsing and copied to owned dense arrays and null-prototype records; depth 16, 10,000 nodes, 1,024 entries, and 64 KiB per string |
| Render | Source 64 KiB body/layout and 2 KiB subject; 1 MiB output per body/layout and 2 KiB subject; shared 4 MiB emission/intermediate budget, 10,000 work, depth 32 and 1,024 per range. Work includes expression tokens, property lookup, collection conversion and comparison size. Four admitted renders per instance. A caller can hold a compiled immutable snapshot; there is no retained cache |
| Markdown | Liquid with HTML escaping, then local `marked` 15.0.12 (a pinned patch), then the optional HTML layout. The lexer charges the characters marked scans, each token and each loop exec to a Markdown work budget of 40,000,000 units of its own (not Liquid's 10,000), and the bytes it materializes to the message's byte budget; a link title must follow whitespace (D111). One linear upper bound on the output is charged before parsing and refuses above 1 MiB (D112); the 1 MiB check after rendering is unchanged. A body is at most 64 KiB of source (D54); a Liquid loop can expand it to the 1 MiB output limit, and the Markdown stage renders or refuses that expansion within the target (D112) |
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

#### Loop metadata and arguments

Only the reviewed `forloop.index`, `index0`, `rindex`, `rindex0`, `first`,
`last` and `length` properties are exposed. Helper methods such as `valueOf`
and `next`, and the source-bearing loop name, are not template capabilities.
Implicit loop-record conversion reserves a conservative JSON-escaping bound
and work before the library creates the string, so truthiness or indirect
conversion cannot bypass the shared intermediate budget.

Filter arity is checked before argument evaluation or argv allocation, and
every evaluated argument consumes work. `raw`, `upcase`, `strip`, `number` and
`track_link` accept no extra arguments; `default` and `date` accept at most
one. `t` accepts zero to eight arguments in name/value pairs. This applies to
literal arguments too; ignored extra arguments do not provide free work.

`number` formats a finite number in one step and charges its output like
the other filters. Its output is bounded by the number's digits: at most
412 characters, for the largest finite number ([D102](09-decisions.md#d102-the-number-liquid-filter-lead-2026-11-16)).
Put `number` before `default` for a value that may be missing:
`{{ n | number | default: 0 }}` renders `0` for a missing `n` and `1,234,567`
for `1234567`. `number` passes nil through, so `default` supplies the fallback.

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

### Built-in templates

listmonk's default campaign, archive and transactional templates and its system emails are converted to Liquid and embedded:

- opt-in confirmation;
- campaign status notification;
- import status;
- forgot password;
- subscriber data export;
- SMTP test.

### Preview data

`POST /api/templates/preview` renders a posted body against a dummy context: a subscriber named `John Doe` with the address `dummy@example.invalid`, `trigger` with empty `data`, `aggregates` empty, and a `data` object. Its optional form field `sample` is a JSON object of the same shape as a step's sample ([sample](05-sequences.md#preview-and-test-send)): `subscriber` (`name`, `email`, `external_id`, `attribs`), `trigger` (`name`, `data`, `occurred_at`), `aggregates` (finite numbers) and `data`. Each part it names replaces the dummy one as a whole, and a sample name also sets `first_name` and `last_name`. A malformed sample, or one over the template data limits, is `400` naming the field, and nothing is rendered. Without `sample` the preview is unchanged ([D105](09-decisions.md#d105-a-sequence-step-previews-and-test-sends-with-sample-data-lead-2026-11-17)).

A sequence step's template reads `trigger` and `aggregates`, which a stored template cannot know, so preview a step with `POST /api/sequences/:id/steps/:step/preview`: it renders with the step's real context, as its send does. `GET /api/templates/:id/preview` and the `preview_template` MCP tool (with `sample`, for a stored template as well) use the same dummy context.

## Application views: server-side TSX

The admin UI and public pages are rendered on the server, as in listmonk v7. Its Go `html/template` views (26 views, 37 partials, 12 public templates) are ported to TSX components:

- **Bun compiles TSX natively.** An in-house JSX runtime renders to strings and escapes text and attributes by default. A `raw()` helper marks trusted markup through an opaque boundary; attribute values never accept it. Callers validate URL and Alpine expression contexts separately, and browser bootstrap values use script-safe JSON. There is no React and no virtual DOM.
- **Views are typed:** each view's props are a TypeScript type, so a handler cannot forget a field that the template uses. In Go templates that mistake fails silently.
- **Markup stays close to v7's:** class names, Alpine.js `x-data` attributes and Oat components stay the same, so v7's CSS and JS assets work unchanged and its Playwright tests stay meaningful.
- **Go template helpers become plain functions:** `dict`, `list` and `printf` become ordinary TypeScript, and `.L.T` becomes `t()`.
- **i18n uses listmonk's language JSON files and keys,** so translations carry over.

M0.6 implements the JSX runtime, a reusable v7-shaped admin shell, the public message shell and the production HTML 404. No admin screen or login route is installed. The shell is exercised by a compiled synthetic fixture; the v1 browser bundles and licenses are embedded from the reproducible build described in `assets/README.md`.
