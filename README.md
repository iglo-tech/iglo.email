# iglo.email

**iglo.email is a self-hosted newsletter, transactional email and lifecycle email server, built on Bun and SQLite.**

Canonical repository: [iglo-tech/iglo.email](https://github.com/iglo-tech/iglo.email). The default branch is `main`.

It is an independently maintained rewrite derived from [listmonk](https://github.com/knadh/listmonk) v7. It keeps listmonk's product model (subscribers, lists, campaigns, templates, transactional email) and adds what listmonk does not plan to have: event-triggered email sequences, unsubscribe-aware transactional email, a per-subscriber frequency cap, a send log and outbound webhooks.

> **Status: design phase.** There is no code yet. Start with the [design docs](docs/design/README.md).

## Planned

- subscribers, lists, single and double opt-in, segmentation queries
- campaigns with scheduling, throttling, tracking and bounces
- a transactional email API that respects unsubscribes and returns message IDs
- an events API and email sequences ("wait 3 days, then send X if Y did not happen")
- a server-rendered admin UI
- SQLite storage, no external database, Redis or queue
- one executable for deployment

## Why iglo.email?

Read [Why iglo.email exists](docs/why-iglo-email.md).

## License

AGPL-3.0, the same license as listmonk, from which this project is derived. See [LICENSE](LICENSE).
