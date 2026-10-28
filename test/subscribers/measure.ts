// Bounded synthetic compiled HTTP workload; no real data or destinations.
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
const admin = { user: "m16-measure-admin", password: "m16-measure-password" };
const executable = resolve(process.argv[2] ?? "dist/iglo.email");
const candidate = process.argv[3] === "candidate";
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
for (let repetition = 1; repetition <= 3; repetition++) {
  await withProduction(
    executable,
    AbortSignal.timeout(120_000),
    async (origin) => {
      const credentials = await provisionApiUser(origin, admin);
      const headers = {
        Authorization: `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`,
        "Content-Type": "application/json",
      };
      const request = async (path: string, method = "GET", body?: unknown) => {
        const t = performance.now();
        const response = await fetch(origin + path, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value = await response.json();
        if (response.status !== 200) throw new Error(`Unexpected ${response.status} for ${path}`);
        return { data: value.data, ms: performance.now() - t };
      };
      const measure = async (n: number, warmup: number, fn: (i: number) => Promise<void>) => {
        const samples: number[] = [];
        for (let i = 0; i < n + warmup; i++) {
          const start = performance.now();
          await fn(i);
          if (i >= warmup) samples.push(performance.now() - start);
        }
        return mean(samples);
      };
      const health = await measure(50, 5, async () => {
        await request("/api/health");
      });
      const listCrud = await measure(20, 5, async (i) => {
        const a = await request("/api/lists", "POST", { name: `list-cycle-${i}` });
        await request(`/api/lists/${a.data.id}`, "PUT", { name: `list-cycle-new-${i}` });
        await request(`/api/lists/${a.data.id}`, "DELETE");
      });
      for (let i = 0; i < 20; i++)
        await request("/api/lists", "POST", { name: `filter-${i}`, tags: ["sample"] });
      const listQuery = await measure(50, 5, async () => {
        await request("/api/lists?query=filter&tag=sample&per_page=20");
      });
      const result: Record<string, unknown> = {
        repetition,
        kind: candidate ? "candidate" : "control",
        health,
        listCrud,
        listQuery,
      };
      if (candidate) {
        const first = await request("/api/lists", "POST", { name: "membership-one" });
        const second = await request("/api/lists", "POST", { name: "membership-two" });
        const subCrud = await measure(20, 5, async (i) => {
          const a = await request("/api/subscribers", "POST", {
            email: `crud-${i}@example.test`,
            lists: [first.data.id],
          });
          await request(`/api/subscribers/${a.data.id}`, "PUT", {
            email: a.data.email,
            lists: [first.data.id],
          });
          await request(`/api/subscribers/${a.data.id}`, "DELETE");
        });
        const ids: number[] = [];
        for (let i = 0; i < 100; i++) {
          const a = await request("/api/subscribers", "POST", {
            email: `count-${i}@example.test`,
            lists: [first.data.id, second.data.id],
          });
          ids.push(a.data.id);
        }
        const patch = await measure(30, 5, async (i) => {
          await request(`/api/subscribers/${ids[i]}`, "PATCH", { name: `patch-${i}` });
        });
        const membership = await measure(30, 5, async (i) => {
          await request(`/api/subscribers/lists/${ids[i]}`, "PUT", {
            action: "unsubscribe",
            target_list_ids: [first.data.id],
          });
        });
        const blocklist = await measure(30, 5, async (i) => {
          await request(`/api/subscribers/${ids[i]}/blocklist`, "PUT");
        });
        const bulk = await measure(10, 5, async (i) => {
          await request("/api/subscribers/lists", "PUT", {
            ids: ids.slice(i * 3, i * 3 + 3),
            target_list_ids: [second.data.id],
            action: "remove",
          });
        });
        const counts = await measure(50, 5, async () => {
          const a = await request("/api/lists?query=membership&order_by=subscriber_count");
          if (a.data.total !== 2) throw new Error("Count mismatch");
        });
        Object.assign(result, {
          subCrud,
          patch,
          membership,
          blocklist,
          bulk,
          counts,
          subscribers: 100,
          initialMemberships: 200,
        });
      }
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    admin,
    120_000,
  );
}
