// B7 measurement: parent memory for large subscriber selections (staged on disk since B7).
// Usage: bun test/subscribers/measure-stage.ts [subscribers]. Prints JSON lines.
import { queryFixture } from "@/test/subscribers/fixture";

const count = Number(process.argv[2] ?? 1_000_000);
const f = await queryFixture({ timeoutMs: 120_000 });
const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
const report = (name: string, values: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ name, ...values })}\n`);
const seeded = performance.now();
f.db.run("BEGIN");
const insert = f.db.prepare(
  "INSERT INTO subscribers (uuid, email, name, status, attribs, created_at, updated_at) VALUES (?, ?, ?, 'enabled', '{}', ?, ?)",
);
const now = new Date().toISOString();
for (let i = 0; i < count; i++)
  insert.run(crypto.randomUUID(), `s${i}@example.test`, `s${i}`, now, now);
f.db.run("COMMIT");
report("seed", { subscribers: count, ms: Math.round(performance.now() - seeded) });

async function timed(name: string, run: () => Promise<{ bytes: number; status: number }>) {
  Bun.gc(true);
  await Bun.sleep(200);
  let peak = process.memoryUsage().rss;
  const before = peak;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
  const started = performance.now();
  const result = await run();
  clearInterval(sampler);
  report(name, {
    ...result,
    ms: Math.round(performance.now() - started),
    rssBeforeMB: mb(before),
    rssPeakMB: mb(peak),
  });
}
async function drain(response: Response) {
  let bytes = 0;
  const reader = response.body!.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
  }
  return { bytes, status: response.status };
}
const q = encodeURIComponent("subscribers.id > 0");
const get = (path: string) => f.request(path, { headers: f.sessionHeaders });
await timed("raw page per_page=all", async () =>
  drain(await get(`/api/subscribers?per_page=all&query=${q}`)),
);
await timed("raw export", async () => drain(await get(`/api/subscribers/export?query=${q}`)));
await timed("built-in page per_page=all", async () =>
  drain(await get(`/api/subscribers?per_page=all`)),
);
await timed("raw bulk blocklist", async () => {
  const response = await f.request("/api/subscribers/query/blocklist", {
    method: "PUT",
    headers: { ...f.sessionHeaders, "content-type": "application/json" },
    body: JSON.stringify({ query: "subscribers.id > 0" }),
  });
  return { bytes: (await response.text()).length, status: response.status };
});
await f.close();
