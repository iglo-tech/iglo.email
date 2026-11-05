// The retention loop the server really starts (src/main.ts): every owner's purge is on its list.
// Old rows are written into a stopped data directory, the compiled executable starts on it, and
// the first pass must remove the expired rows of each owner and leave the live ones.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  apiClient,
  buildExecutable,
  createSubscriber,
  provisionAuthorization,
  removeDirectory,
  startServer,
  temporaryDirectory,
} from "@/test/backup/fixture";

setDefaultTimeout(120_000);

const DAY = 86_400_000;
let build = "";
let executable = "";
beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
});
afterAll(() => removeDirectory(build));

const iso = (ago: number) => new Date(Date.now() - ago).toISOString();
const count = (db: Database, sql: string) =>
  Number(db.query<{ n: bigint }, []>(`SELECT count(*) AS n FROM ${sql}`).get()!.n);

test("the server's first retention pass runs every owner's purge", async () => {
  const base = temporaryDirectory();
  const dataDir = join(base, "data");
  try {
    // A first run makes the schema, a subscriber and an API user.
    const first = await startServer(executable, dataDir);
    const client = apiClient(first.origin, await provisionAuthorization(first.origin));
    const created = await createSubscriber(client, 1);
    const subscriber = ((await created.json()) as { data: { id: number } }).data.id;
    await first.stop();

    const db = new Database(join(dataDir, "iglo-email.db"), { readwrite: true, strict: true });
    db.run("PRAGMA foreign_keys = ON");
    try {
      const sessions = db.prepare("INSERT INTO sessions (id, data, created_at) VALUES (?, ?, ?)");
      sessions.run("old-expired", JSON.stringify({ expires_at: Date.now() - DAY }), iso(9 * DAY));
      sessions.run("old-legacy", "{}", iso(30 * DAY));
      sessions.run("still-live", JSON.stringify({ expires_at: Date.now() + DAY }), iso(DAY));

      db.run(
        "INSERT INTO webhooks (id, url, secret, events) VALUES (1, 'http://127.0.0.1:9/', 's', '[]')",
      );
      const deliveries = db.prepare(
        `INSERT INTO webhook_deliveries (uuid, webhook_id, event, payload, status, created_at, updated_at)
         VALUES (?, 1, 'subscriber.created', '{}', 'delivered', ?, ?)`,
      );
      deliveries.run("old-delivery", iso(60 * DAY), iso(60 * DAY));
      deliveries.run("new-delivery", iso(DAY), iso(DAY));

      const sends = db.prepare(
        `INSERT INTO sends (uuid, source, kind, to_email, status, payload, created_at, sent_at)
         VALUES (?, 'tx', 'transactional', 'a@example.test', 'sent', '{"message":{"body":"aGk="}}', ?, ?)`,
      );
      sends.run("00000000-0000-4000-8000-000000000001", iso(60 * DAY), iso(60 * DAY));
      sends.run("00000000-0000-4000-8000-000000000002", iso(DAY), iso(DAY));

      const events = db.prepare(
        `INSERT INTO events (subscriber_id, name, occurred_at, created_at) VALUES (?, 'seen', ?, ?)`,
      );
      events.run(subscriber, iso(500 * DAY), iso(500 * DAY));
      events.run(subscriber, iso(DAY), iso(DAY));
    } finally {
      db.close(true);
    }

    const second = await startServer(executable, dataDir);
    const reader = new Database(join(dataDir, "iglo-email.db"), { readonly: true, strict: true });
    try {
      const gone = () =>
        count(reader, "sessions WHERE id IN ('old-expired', 'old-legacy')") === 0 &&
        count(reader, "webhook_deliveries WHERE uuid = 'old-delivery'") === 0 &&
        count(reader, "sends WHERE payload IS NULL") === 1 &&
        count(reader, "events WHERE created_at < datetime('now', '-400 days')") === 0;
      // The loop pauses between owners, so a pass per owner takes about a second.
      for (const deadline = Date.now() + 60_000; !gone(); await Bun.sleep(50))
        if (Date.now() > deadline) break;
      expect({
        sessions: count(reader, "sessions WHERE id IN ('old-expired', 'old-legacy')"),
        oldDelivery: count(reader, "webhook_deliveries WHERE uuid = 'old-delivery'"),
        compacted: count(reader, "sends WHERE payload IS NULL"),
        oldEvents: count(reader, "events WHERE created_at < datetime('now', '-400 days')"),
      }).toEqual({ sessions: 0, oldDelivery: 0, compacted: 1, oldEvents: 0 });
      // What is still due stays.
      expect(count(reader, "sessions WHERE id = 'still-live'")).toBe(1);
      expect(count(reader, "webhook_deliveries WHERE uuid = 'new-delivery'")).toBe(1);
      expect(count(reader, "sends WHERE payload IS NOT NULL")).toBe(1);
      expect(count(reader, "events")).toBe(1);
    } finally {
      reader.close(true);
      await second.stop();
    }
  } finally {
    removeDirectory(base);
  }
});
