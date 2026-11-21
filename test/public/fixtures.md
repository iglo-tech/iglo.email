# Public pages: manual data (B126)

Manual checks of the public pages and the subscriber mail (B126, D123), made with `agent-browser`
at 1280 and 390 px on the committed build, served from `oven/bun:1.4.5` by `bun src/main.ts serve`.
All data here is synthetic and exists only in that local run; nothing from a real installation was used.

## Server and credentials (synthetic)

- Admin: `admin` / `b126-synthetic-admin-pass`, created from `IGLO_EMAIL_ADMIN_USER` and
  `IGLO_EMAIL_ADMIN_PASSWORD` on the first start.
- API user: `api`, token `b126SyntheticTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123`, from
  `IGLO_EMAIL_API_USER` and `IGLO_EMAIL_API_TOKEN`.
- Root URL: `http://127.0.0.1:9100`.

## Data

- List: `B126 News`, public, single opt-in.
- Subscribers, all `@example.test`: `ada.synthetic`, `bob.synthetic`, `cy.synthetic`,
  `dan.synthetic`, `eve.synthetic`.
- Template: type `tx`, `B126 Marketing`, with `{{ unsubscribe_url }}` in the body.
- One marketing send per subscriber, created with `POST /api/tx`, so each has a real unsubscribe,
  manage and wipe path.
- Setting: `app.site_url` set to `https://brand.example.test/` for the back-link pages.

## What was checked

At 1280 and 390 px, with no horizontal scroll at either width:

- The manage page, with its labelled name field and the wipe copy.
- The wipe confirmation page, reached by choosing the wipe option and pressing Continue. Nothing
  was deleted there, and the subscriber still answered `200` through the API.
- The already-unsubscribed page, on a second visit to an unsubscribe link.
- The Done, Unsubscribed and Data removed pages, each with "Back to Mailing list" when `app.site_url`
  is set, and the header logo linking to that site.
- The "Page not found" 404, the invalid-link page and the expired-link page.
- The admin sign-in page, and the admin settings page's Site URL field.

Without `app.site_url` the logo links to the subscription page, and the result pages have no back link.
When no logo is set, the shell shows the default product logo, as it did before this change.
