// Serial timing for docs/perf/M3.4-bounces.md; opt-in, not a CI threshold. Real HTTP against a
// compiled build: signed Mailgun events, one per subscriber, each at its type's action
// threshold. Usage: bun test/bounces/measure.ts <executable> <hooks> [n]
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../..");
const executable = resolve(process.argv[2] ?? join(repository, "dist/iglo.email"));
const hooks = Number(process.argv[3] ?? 0);
const N = Number(process.argv[4] ?? 500);
const key = "measure-mailgun-signing-key";

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
      await api("/api/settings/bounce.webhooks_enabled", "PUT", true);
      await api("/api/settings/bounce.enabled", "PUT", true);
      await api("/api/settings/bounce.mailgun", "PUT", { enabled: true, key });
      for (let i = 0; i < hooks; i++)
        await api("/api/webhooks", "POST", {
          url: `http://127.0.0.1:${receiver.port}/h/${i}`,
          events: ["bounce.recorded", "subscriber.blocklisted", "subscriber.deleted"],
        });
      const list = (
        await api("/api/lists", "POST", { name: "measure", type: "public", optin: "single" })
      ).data.id as number;
      const ingest = async (email: string, sequence: string) => {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const token = crypto.randomUUID().replaceAll("-", "");
        const started = performance.now();
        const response = await fetch(`${origin}/webhooks/bounce/mailgun`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            signature: {
              timestamp,
              token,
              signature: createHmac("sha256", key).update(`${timestamp}${token}`).digest("hex"),
            },
            "event-data": {
              id: sequence,
              event: "failed",
              severity: "permanent",
              recipient: email,
              reason: "bounce",
              "delivery-status": { code: 550, message: "5.1.1 user unknown" },
            },
          }),
        });
        await response.text();
        if (response.status !== 200) throw new Error(`ingest: ${response.status}`);
        return performance.now() - started;
      };
      const results: Record<string, ReturnType<typeof stats>> = {};
      // `row only` sits below the count; the others fire their action on this bounce.
      for (const [name, count, action] of [
        ["row only", 2, "blocklist"],
        ["blocklist", 1, "blocklist"],
        ["unsubscribe", 1, "unsubscribe"],
        ["delete", 1, "delete"],
      ] as const) {
        await api("/api/settings/bounce.actions", "PUT", {
          soft: { count: 2, action: "none" },
          hard: { count, action },
          complaint: { count: 1, action: "blocklist" },
        });
        const emails: string[] = [];
        for (let i = 0; i < N; i++) {
          const email = `${action}${count}-${i}@example.test`;
          await api("/api/subscribers", "POST", { email, name: `M ${i}`, lists: [list] });
          emails.push(email);
        }
        const times: number[] = [];
        for (const [i, email] of emails.entries())
          times.push(await ingest(email, `${name.replace(" ", "")}${i}`));
        results[name] = stats(times);
      }
      const drainStart = performance.now();
      const expected = hooks * N * 6;
      while (hooks && received < expected && performance.now() - drainStart < 120_000)
        await Bun.sleep(25);
      return {
        bun: Bun.version,
        hooks,
        ms: results,
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
