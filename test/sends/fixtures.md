# Synthetic send fixtures

All send data and the `fixture-admin` / `fixture-admin-password` account are
created only in disposable test databases. The producer is a separately compiled
test executable; its test controls are never registered by production. Its
marketing authorization is injected solely to test outbox mechanics, and does
not supply production consent policy. API credentials and session values are
held in memory, never printed. SMTP traffic is restricted to the reference
runner's labelled Mailpit and its invocation-owned loopback relays.
