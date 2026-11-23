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
| Filters | `default`, `upcase`, `downcase`, `capitalize`, `strip`, `prepend`, `append`, `replace`, `replace_first`, `split`, `join`, `slice`, `truncate`, `truncatewords`, `strip_html`, `plus`, `minus`, `times`, `divided_by`, `round`, `first`, `last`, `newline_to_br`, `url_encode`, `raw`, `t`, `date`, `track_link`, `number`, `size`, `json`; other filters are rejected, and a save that names one says which filter and points here. Not supported: `sort`, `map`, `where`, `uniq`, `reverse`, `escape` and regular expressions. A list or object prints as text: a list as its items' text joined with nothing, an object as its `json` text, both bounded by the message budget. A literal `nil`, `empty` or `blank` prints as nothing and reads as nil in a filter (`{{ data.x \| default: nil }}`); a loop object printed on its own (`{{ forloop }}`), or printed or read by a filter, in an argument too (`{{ forloop \| json }}`, `{{ 'x' \| append: forloop }}`), is refused at save, because its text is not data; so is a bare loop object that a `for` tag loops over or a range ends at (`{% for x in forloop %}`, `(1..forloop)`). A property the renderer does not expose is refused wherever it stands, in an output, a filter argument, a `for` tag's collection, `limit` or `offset`, or a bracket key, whatever the loop's data is: `{{ forloop.parentloop }}`, `{{ forloop["size"] }}`, `{{ data.m[forloop.parentloop] }}`. The same checks apply outside a loop, so `{{ forloop \| default: 'x' }}` is refused at save, although no loop is running there. The loop properties `index`, `index0`, `rindex`, `rindex0`, `first`, `last` and `length` read as before. A bare loop object in an `if`, or as a bracket key, is not refused, as before. A bare loop object given to a `for` tag's `limit`, `offset` or `reversed` is refused, wherever the loop runs, because the send fails there (B117f). A loop object stored with `{% assign f = forloop %}` is refused as well (B117f): a later read of `f` is a name the save cannot follow, so the store itself is refused, with the reason named. `{% assign n = forloop.index %}` stores a number and is not refused. `size` and `json` take a list or an object, `join` takes a list, `first` and `last` take a list (an item) or a text (a character), `slice` takes a text or a list, and `split` returns a list (for a loop or `join`, not for printing). `replace` and `replace_first` take literal strings, not regular expressions, and `$` in a replacement is plain text. `split` drops trailing empty parts, `join` uses a space when no separator is given, `slice` takes a negative start from the end, and `truncate` (50 characters) and `truncatewords` (15 words) add `...` when text is cut, with an ellipsis argument to change it; `truncatewords` adds it only when words were left out. `slice` and `truncate` count characters as code points, so a character outside the Basic Multilingual Plane is one character and a cut never splits it; `size` counts UTF-16 units (JavaScript's `length`), so that character is two. `strip_html` removes tags, comments, `script` and `style`, then decodes character references, so `&amp;` shows as `&` and is escaped once in an HTML output. Its result is text, not safe HTML: do not follow `strip_html` with `raw`, since a decoded `&lt;script&gt;` would become a live tag. `plus`, `minus`, `times` and `divided_by` compute on numbers and on text that holds one: a nil, empty or blank (spaces only) input or argument renders empty, so `{{ data.a \| plus: data.x }}` with `""` or `" "` in `x` renders empty (B117e); both operands are read first, so a text that is not a number still fails. A division is a decimal, as LiquidJS's is, whatever its operands were written as, read from data, or stored with `assign`: `{{ 10 \| divided_by: 4 }}` is 2.5, `{{ data.n \| divided_by: 4 }}` is 2.5 for `n` of 10, `{% assign my_float = 7 \| times: 1.0 %}{{ 20 \| divided_by: my_float }}` is 2.857142857142857, and `{{ 10.5 \| round \| divided_by: 4 }}` is 2.75 (`round` gives 11). A result is whole only when the second argument is the literal `true`, or a JSON `true` from data: `{{ 10 \| divided_by: 4, true }}` is 2 and `{{ -10 \| divided_by: 4, true }}` is -3, rounded down as LiquidJS's integer argument rounds (B117f, lead decision 1). The second argument must be `true` or `false` (`false` divides as a decimal), and a third argument is refused at save. There is no `floor` filter: a `floor` in a template is refused as an unknown filter, and `, true` is the whole-number division. This is a deliberate difference from Shopify's documented integer division of two integers, where `10 \| divided_by: 4` is 2 (see 07). A result that is not finite renders empty. A value that is not a number, an argument that is not one, and a division by zero fail the send, naming the expression; a literal one is refused at save. `round` takes 0 to 15 digits (none by default) and rounds halves away from zero. A digits argument from data that is nil, empty or blank renders empty, as an arithmetic argument does (B117e); a literal one is refused at save, and `{{ data.x \| round }}` with no argument rounds to a whole number. An input that is not a number still fails the send. `newline_to_br` escapes its text once in an HTML output and writes each line break as `<br />`. Its output is safe to print as the last filter, or with `raw`; a filter after it reads its text, so it writes no `<br />` there, and it is best last. In a plain-text part it keeps its line breaks as they are. `url_encode` percent-encodes its text per RFC 3986: every byte outside the unreserved set (letters, digits, `-`, `_`, `.` and `~`) is written as `%XX`, so a space is `%20` and `!'()*` are encoded too. It suits a query value or a path segment; it is not form encoding, which writes a space as `+`. There is no `escape` filter: every HTML output is already escaped, so a second escape would double it, and a plain-text template has no escaping to ask for. A `for` tag takes a value, not a filter: `{% for x in v \| slice: 1 %}` would drop the filter, so a save refuses it, and the filtered value is assigned first (`{% assign picked = v \| slice: 1 %}`). `size` is the length of a string in characters (JavaScript's `length`), the items of an array, the keys of an object, and 0 for nil and other values. `json` is the JSON text of the value (nil is `null`; a loop's `[key, value]` pair is an array), escaped in HTML like any value unless piped through `raw`; a value over the output or work budget is refused. `number` passes any value that is not a finite number through unchanged, and `t` accepts up to four name/value pairs, with bounded argument sizes and literal placeholder substitution. `number` formats a finite number with English grouping and at most three fraction digits ([D102](09-decisions.md#d102-the-number-liquid-filter-lead-2026-11-16)) |
| Dates | `now` and `today` use the injected clock. The format directives, all in UTC and in English: `%Y` (year), `%y` (two-digit year), `%m` (month, 01 to 12), `%d` (day, 01 to 31), `%-d` (day, unpadded), `%e` (day, space-padded), `%H` (hour, 00 to 23), `%I` (hour, 01 to 12), `%M`, `%S`, `%p` (AM or PM), `%b` and `%B` (month, short and full name), `%a` and `%A` (weekday, short and full name), `%j` (day of the year, 001 to 366) and `%%`, a literal percent sign. The format is read left to right, so `100%% %Y` is `100% 2026`; a lone `%`, or any other directive, is refused at save, and the message lists the supported ones. Other date strings must be a date or UTC ISO timestamp. A value that is nil, missing, empty or not a date, and a calendar date that does not exist (`2026-02-30`, `2026-04-31`), renders empty, so one optional field does not fail a message; a literal one (`'2026-02-30' \| date`) is refused at save. Guard an optional date by its formatted text, so the text around it does not print without its date: `{% assign d = data.delivery_date \| date: "%d %B" %}{% if d != blank %}Delivery {{ d }}{% endif %}`. The date filter renders empty for a nil, missing, empty or non-date value and for a calendar date that does not exist (`2026-02-30`), so this guard holds for each of them. A guard on the raw value (`{% if data.delivery_date %}`) is true for `""` and for `2026-02-30`, so it prints `Delivery ` with no date; do not use it for an optional date. An empty format returns the input |

A save renders the template once against the preview's sample, as a send renders it. It refuses a failure the template's own text causes, and names the cause: a filter with the wrong number of arguments; a date format with an unsupported directive (the message names it and lists the supported ones); a `for` tag whose collection has a filter; a range or loop out of bounds with literal bounds; a loop object that a filter reads, a `for` tag loops over or reads as its `limit`, `offset` or `reversed`, or that `assign` stores (B117e and B117f, see the Filters row); a property name that is not allowed; and a literal value a filter cannot use, such as `{{ "abc" | truncate: "x" }}`, `{{ "2026-02-30" | date }}` or a literal `split` into more than 1,024 parts. A literal argument that its filter cannot read is checked on the template's text in every branch, including branches the sample never reaches: `{{ data.s | truncate: "x" }}` is refused as `truncate: the first argument must be a whole number, got "x"`, and so are a missing required argument, too many arguments, a `round` count outside 0 to 15, a literal divisor of zero (it fails for every number), and a `date` format with an unsupported directive. A failure that depends on the data a message carries is not refused at save, because the sample cannot tell a missing value from a present one: the template saves, and a send that fails for the value is refused with its expression and the kind of value named (`data.n | slice: data.k: needs a whole-number argument, got text`), not as `invalid template`. `{{ data.s | truncate: data.n }}` saves for that reason. A failure whose expression reads no variable is literal; a loop or `assign` variable counts as a variable, so a literal failure through one is judged at send.

#### Data and functions

| listmonk (Go template) | iglo.email (Liquid) |
|---|---|
| `{{ .Subscriber.Name }}`, `.Email`, `.UUID` | `{{ subscriber.name }}`, `subscriber.email`, `subscriber.uuid` |
| `{{ .Subscriber.FirstName }}`, `.LastName` | `{{ subscriber.first_name }}`, `subscriber.last_name` |
| `{{ .Subscriber.Attribs.city }}` | `{{ subscriber.attribs.city }}` |
| — | `{{ subscriber.external_id }}` |
| `{{ .Campaign.Name }}`, `.Subject`, `.UUID` | `{{ campaign.name }}`, `campaign.subject`, `campaign.uuid` |
| — | `{{ campaign.attribs.key }}` |
| — | `{{ brand_accent }}`, `brand_link`, `brand_on_accent`, `brand_font`, `brand_header`, `logo_url`, `site_name`, `site_url`: the site's brand, in campaign, transactional and system mail data (B130, D128) |
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

A number in `data` is a JSON number, read as a double, so an integer above 2^53 (9007199254740992) loses precision and prints as the nearest double: `9007199254740993` prints `9007199254740992`. JSON parsing is not changed for this. Send such ids (order numbers, external IDs of 16 digits or more) as strings, which print exactly.

`unsubscribe_url` in a transactional send renders an empty string: a transactional email has nothing to unsubscribe from. Saving a `tx` template that references it logs nothing, because the same `tx` template also serves marketing sends (`POST /api/tx` with `kind: "marketing"`, sequence marketing steps), where it is filled in; the send kind, not the template, decides.

#### Layouts

As in listmonk, a **campaign template** is a layout containing `{{ content }}`, and a campaign supplies the body. A **transactional template** is a complete message with its own subject. An already rendered HTML body is inserted as `{{ content | raw }}`; values were escaped within that body, and the raw insertion prevents double escaping during trusted layout composition.

A sequence step sends a transactional template and may override its subject. Steps have no body of their own yet, so a step cannot use a campaign layout.

#### Content types

`richtext` (Squire editor, stored as HTML), `html`, `markdown` (rendered with Bun's Markdown API after Liquid, D113), and `plain`. There is no visual editor; template editing for agents is via MCP. An HTML message without an alternative body gets a generated `text/plain` part; its lists are numbered when they are ordered (a Markdown `1.` list renders as an ordered list, so it is numbered too), and its named references decode as [07-api-and-ui](07-api-and-ui.md) lists.

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
| Markdown | Liquid with HTML escaping, then Bun's built-in Markdown API (`Bun.markdown.html` with listmonk's GFM options: tables, strikethrough and task lists; no bare-URL autolinks, no heading IDs), then the optional HTML layout (D113). Bun marks that API unstable, so the output is tied to the pinned Bun version. The Markdown source after Liquid expansion is capped at 128 KiB and refused with a 400 before parsing (D112). An upper bound on the output is computed before `html()` runs, by a dry run through `Bun.markdown.render` that charges each element's bound to the message's byte budget; a bound above 1 MiB is refused before any output string is built (D113). The parser is linear in its input, so there is no work budget. A link title must follow whitespace (D111). A body is at most 64 KiB of source (D54). A Liquid loop can expand a body to the 1 MiB output limit within the 128 KiB source cap, and that expansion renders or is refused within the target (D112) |
| Tracking and URLs | `track_link` accepts HTTP(S) and `track_view` renders nothing unless the sending owner supplies per-message tracking (M2.4 tx sends: tracked `/m/:sendUUID` links and listmonk's hidden pixel image, inserted after rendering via a per-render marker). Only the built-in URL fields are checked (`unsubscribe_url`, `manage_url`, `optin_url`, `message_url`, `archive_url`, `logo_url`, `reset_url` and `root_url`): each must be an HTTP(S) URL. Any other value is not checked, and a value printed inside `href` or `src` is HTML-escaped but its scheme is not, so pass only `http`, `https` or `mailto` URLs in `data`: check the scheme where the data is built, and send a link that needs tracking through `track_link`, which accepts only HTTP(S) |

The emitter, subset, JSON boundary and patches await hosted checks and
independent review before they are treated as an accepted boundary. The time limit remains
cooperative, and raw author HTML is not sanitized. Preview CSP protects its
sandboxed browser context; it is not a guarantee about HTML used elsewhere.
Markdown does not sanitize raw HTML or arbitrary author-provided URLs, as before (listmonk's goldmark runs unsafe too).

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
every evaluated argument consumes work. `raw`, `upcase`, `downcase`, `capitalize`, `strip`, `strip_html`, `number`, `size`, `json`, `track_link`, `first`, `last`, `newline_to_br` and `url_encode` accept no extra arguments; `default`, `date`, `split`, `join`, `prepend`, `append`, `plus`, `minus`, `times` and `round` accept at most one, and `divided_by` at most two (its whole-number flag, `true` or `false`); `replace`, `replace_first`, `slice`, `truncate` and `truncatewords` take at most two. `t` accepts zero to eight arguments in name/value pairs. This applies to
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
