# Why iglo.email exists

Most SaaS products need the same three kinds of email: one-off messages triggered by the app (receipts, access, alerts), occasional broadcasts to a list, and lifecycle sequences ("three days after purchase, if they have not used it yet, offer help"). The first two are solved well by listmonk. The third is not, and it is the one that matters most for activation and retention.

## What listmonk gets right

listmonk is a fast, focused, self-hosted mailing list manager. It has a clear data model, sensible opt-in and unsubscribe handling, a good campaign engine with throttling and tracking, bounce processing, and a transactional API. Version 7 replaced its single-page admin with a light server-rendered UI. iglo.email starts from that work rather than from a blank page.

## What it does not do, by design

- **No sequences or automation.** Requests for drip campaigns and automated sequences are closed as out of scope ([#2198](https://github.com/knadh/listmonk/issues/2198), [#2524](https://github.com/knadh/listmonk/issues/2524), [#2759](https://github.com/knadh/listmonk/issues/2759)). The suggested alternative is a much larger marketing suite.
- **Transactional email ignores unsubscribes.** The transactional API does not check list status, and `{{ UnsubscribeURL }}` is not available in transactional templates ([#1409](https://github.com/knadh/listmonk/issues/1409), [#1711](https://github.com/knadh/listmonk/issues/1711)). An app that sends lifecycle email through it has to build its own unsubscribe handling.
- **No events.** listmonk knows subscribers and their attributes, not what they did. Lifecycle conditions are about what people did.
- **No send log or outbound notifications.** The transactional API returns only success, and nothing tells the app when someone unsubscribes.

These are reasonable choices for a mailing list manager. They mean every app built on listmonk rebuilds the same scheduler, condition checks, unsubscribe bridge and send log, which is exactly the work iglo.email moves into one place.

## Why a rewrite, not a patch set

- **One stack across iglo.\* projects.** Bun, TypeScript and SQLite, shipped as one executable, like [iglo.monitor](https://github.com/iglo-tech/iglo.monitor). listmonk is Go and requires Postgres.
- **No external services.** A mailing list server for one or a few products does not need a database server. SQLite in WAL mode handles the write volume of email sending comfortably, and durable scheduling can live in ordinary tables.
- **Features upstream will not accept.** Sequences, events and transactional unsubscribe touch the data model, the sending path and the admin UI. Carrying them as patches on a Go codebase that keeps moving would cost more than owning the code.

## Scope

iglo.email does not aim for feature parity with listmonk. Features are kept when they are valuable and can be supported well; see [Scope](design/01-scope.md). It is not a marketing suite: no visual journey builder, no lead scoring, no CRM.

## Credit and independence

iglo.email would not exist without listmonk. Kailash Nadh and the listmonk contributors created the product model, the campaign engine, the templates, the admin UI design, the translations and years of practical behavior that form the starting point for this work.

iglo.email is independently maintained, is not an official listmonk edition, and does not ask listmonk maintainers to support its design decisions. It is licensed under AGPL-3.0, as listmonk is.
