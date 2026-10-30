// Serial timing for docs/perf/M2.6-webhooks.md; opt-in, not a CI threshold. Real HTTP against a
// compiled build: event ingest and one-click unsubscribes, with 0 or more enabled webhooks
// pointing at a loopback receiver. Usage: bun test/webhooks/measure.ts <executable> <hooks> [n]
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../..");
const executable = resolve(process.argv[2] ?? join(repository, "dist/iglo.email"));
const hooks = Number(process.argv[3] ?? 0);
const N = Number(process.argv[4] ?? 1500);
const dummy = "00000000-0000-0000-0000-000000000000";

const base = join(repository, "upstream/measurements");
mkdirSync(base, { recursive: true });
process.env.TMPDIR = base;

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    n: values.length,
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    p99: +at(0.99).toFixed(2),
    max: +sorted.at(-1)!.toFixed(2),
  };
};

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
try {
  const result = await withProduction(
    executable,
    AbortSignal.timeout(600_000),
    async (origin) => {
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
      const settings = (await (
        await fetch(`${origin}/api/settings`, { headers: { authorization } })
      ).json()) as { data: Record<string, any> };
      await api("/api/settings/security.public_rate_limit", "PUT", {
        ...settings.data["security.public_rate_limit"],
        unsubscribe: 1_000_000,
      });
      for (let i = 0; i < hooks; i++)
        await api("/api/webhooks", "POST", {
          url: `http://127.0.0.1:${receiver.port}/h/${i}`,
          events: ["subscriber.unsubscribed"],
        });
      const list = (
        await api("/api/lists", "POST", { name: "measure", type: "public", optin: "single" })
      ).data.id as number;
      const ids: string[] = [];
      for (let i = 0; i < N; i++)
        ids.push(
          (
            await api("/api/subscribers", "POST", {
              email: `m${i}@example.test`,
              name: `M ${i}`,
              lists: [list],
            })
          ).data.uuid as string,
        );
      const ingest: number[] = [];
      for (let i = 0; i < N; i++) {
        const started = performance.now();
        await api("/api/subscriber-events", "POST", {
          subscriber: { email: `m${i}@example.test`, attribs: { n: i } },
          name: "order_paid",
          data: { order: i, amount: 79 },
          idempotency_key: `evt-${i}`,
        });
        ingest.push(performance.now() - started);
      }
      const unsubscribe: number[] = [];
      for (const uuid of ids) {
        const started = performance.now();
        const response = await fetch(`${origin}/subscription/${dummy}/${uuid}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        });
        await response.text();
        if (response.status !== 200) throw new Error(`unsubscribe: ${response.status}`);
        unsubscribe.push(performance.now() - started);
      }
      const drainStart = performance.now();
      while (hooks && received < N * hooks && performance.now() - drainStart < 120_000)
        await Bun.sleep(25);
      return {
        bun: Bun.version,
        executable: executable.split("/").at(-1),
        hooks,
        ingestMs: stats(ingest),
        unsubscribeMs: stats(unsubscribe),
        received,
        drainMs: hooks ? +(performance.now() - drainStart).toFixed(0) : 0,
      };
    },
    admin,
    600_000,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  receiver.stop(true);
}
