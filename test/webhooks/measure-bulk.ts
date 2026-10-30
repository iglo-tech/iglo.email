// Serial timing for docs/perf/M2.6-webhooks.md; opt-in, not a CI threshold. Real HTTP against a
// compiled build: bulk blocklist of half the subscribers, which queues two events each, then
// bulk delete of all of them, with `hooks` enabled webhooks on every event and a loopback
// receiver, while a second client polls /health to see how long the event loop stays held.
// Subscribers are seeded directly into the SQLite file. At 2,500 × 20 and 50,000 × 1 both
// actions sit exactly at the budget.
// Usage: bun test/webhooks/measure-bulk.ts <executable> <hooks> <subscribers>
import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../..");
const executable = resolve(process.argv[2] ?? join(repository, "dist/iglo.email"));
const hooks = Number(process.argv[3] ?? 20);
const subscribers = Number(process.argv[4] ?? 2500);

const base = join(repository, "upstream/measurements");
mkdirSync(base, { recursive: true });
process.env.TMPDIR = base;

let received = 0;
const receiver = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    if (request.method === "POST") received++;
    return new Response("ok");
  },
});
const admin = { user: "measure-admin", password: "measure-admin-password" };
/** Round trips of a loopback client; the longest is the event loop's longest hold. */
async function whileProbing<T>(origin: string, work: () => Promise<T>) {
  let running = true,
    longest = 0;
  const probe = (async () => {
    while (running) {
      const started = performance.now();
      await (await fetch(`${origin}/health`)).text();
      longest = Math.max(longest, performance.now() - started);
      await Bun.sleep(5);
    }
  })();
  const started = performance.now();
  const result = await work();
  const requestMs = performance.now() - started;
  running = false;
  await probe;
  return { result, requestMs: +requestMs.toFixed(0), longestHealthMs: +longest.toFixed(0) };
}
try {
  const result = await withProduction(
    executable,
    AbortSignal.timeout(300_000),
    async (origin, _signal, _restart, dataDir) => {
      const { user, token } = await provisionApiUser(origin, admin);
      const authorization = `Basic ${btoa(`${user}:${token}`)}`;
      const api = async (path: string, method: string, body: unknown) => {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
        return JSON.parse(text);
      };
      for (let i = 0; i < hooks; i++)
        await api("/api/webhooks", "POST", {
          url: `http://127.0.0.1:${receiver.port}/h/${i}`,
          events: ["subscriber.unsubscribed", "subscriber.blocklisted", "subscriber.deleted"],
        });
      const list = async (name: string) =>
        (await api("/api/lists", "POST", { name, type: "public", optin: "single" })).data
          .id as number;
      const half = await list("half"),
        whole = await list("whole");
      const path = join(dataDir, "iglo-email.db");
      const writer = new Database(path);
      writer.run("BEGIN IMMEDIATE");
      writer.run(
        `WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < ?)
         INSERT INTO subscribers (uuid, email, name, external_id)
         SELECT lower(hex(randomblob(16))), 'bulk' || n || '@example.test', 'Bulk', 'app-' || n
         FROM i`,
        [subscribers],
      );
      const membership =
        "INSERT INTO subscriber_lists (subscriber_id, list_id, status) SELECT id, ?, 'confirmed' FROM subscribers";
      writer.run(membership, [whole]);
      writer.run(`${membership} ORDER BY id LIMIT ?`, [half, Math.floor(subscribers / 2)]);
      writer.run("COMMIT");
      writer.close();
      const blocklist = await whileProbing(origin, () =>
        api("/api/subscribers/query/blocklist", "PUT", { list_ids: [half], all: true }),
      );
      const remove = await whileProbing(origin, () =>
        api("/api/subscribers/query/delete", "POST", { list_ids: [whole], all: true }),
      );
      const reader = new Database(path, { readonly: true });
      const count = (reader.query("SELECT count(*) AS n FROM webhook_deliveries").get() as any).n;
      reader.close();
      return {
        bun: Bun.version,
        executable: executable.split("/").at(-1),
        hooks,
        subscribers,
        blocklistDeliveries: Math.floor(subscribers / 2) * hooks * 2,
        deleteDeliveries: subscribers * hooks,
        blocklist: { requestMs: blocklist.requestMs, longestHealthMs: blocklist.longestHealthMs },
        delete: { requestMs: remove.requestMs, longestHealthMs: remove.longestHealthMs },
        storedDeliveries: Number(count),
        received,
        walBytes: statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0,
      };
    },
    admin,
    300_000,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  receiver.stop(true);
}
