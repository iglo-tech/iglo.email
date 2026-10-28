// Bounded synthetic disk-backed HTTP measurements; no production data.
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
import { startListFixture } from "@/test/lists/fixture";
const admin = { user: "m15-measure-admin", password: "m15-measure-password" };
const executable = resolve(process.argv[2] ?? "dist/iglo.email");
const candidate = process.argv[3] === "candidate";
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
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
        const start = performance.now();
        const response = await fetch(`${origin}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = (await response.json()) as { data: any };
        if (response.status !== 200)
          throw new Error(`Unexpected status ${response.status} for ${path}`);
        return { data: data.data, ms: performance.now() - start };
      };
      for (let i = 0; i < 10; i++) await request("/api/health");
      const health: number[] = [];
      for (let i = 0; i < 100; i++) health.push((await request("/api/health")).ms);
      const result: Record<string, unknown> = {
        repetition,
        kind: candidate ? "candidate" : "control",
        tempRoot: tmpdir(),
        healthMeanMs: mean(health),
        healthSamples: health.length,
        healthWarmup: 10,
      };
      if (candidate) {
        const crud: number[] = [],
          query: number[] = [],
          bulk: number[] = [];
        for (let i = 0; i < 25; i++) {
          const start = performance.now();
          const created = await request("/api/lists", "POST", {
            name: `measure-${i}`,
            tags: ["sample"],
          });
          await request(`/api/lists/${created.data.id}`, "PUT", {
            name: `measure-${i}-updated`,
            tags: ["sample"],
          });
          await request(`/api/lists/${created.data.id}`, "DELETE");
          if (i >= 5) crud.push(performance.now() - start);
        }
        for (let i = 0; i < 40; i++)
          await request("/api/lists", "POST", { name: `filter-${i}`, tags: ["sample"] });
        for (let i = 0; i < 55; i++) {
          const sample = await request("/api/lists?query=filter&tag=sample&per_page=20");
          if (i >= 5) query.push(sample.ms);
        }
        for (let i = 0; i < 15; i++) {
          const name = `bulk-${i}`;
          for (let j = 0; j < 3; j++) await request("/api/lists", "POST", { name, tags: [name] });
          const sample = await request(`/api/lists?query=${name}&tag=${name}`, "DELETE");
          if (i >= 5) bulk.push(sample.ms);
        }
        Object.assign(result, {
          crudCycleMeanMs: mean(crud),
          queryMeanMs: mean(query),
          bulkThreeMeanMs: mean(bulk),
          crudSamples: crud.length,
          querySamples: query.length,
          bulkSamples: bulk.length,
          warmupEach: 5,
        });
      }
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    admin,
    120_000,
  );
}
if (candidate) {
  for (let repetition = 1; repetition <= 3; repetition++) {
    const f = await startListFixture();
    try {
      const credentials = await provisionApiUser(f.origin, f.admin);
      const headers = {
        Authorization: `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`,
        "Content-Type": "application/json",
      };
      async function request(path: string, method = "GET", body?: unknown) {
        const start = performance.now();
        const response = await fetch(`${f.origin}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = (await response.json()) as { data: any };
        if (response.status !== 200) throw new Error("Fixture request failed");
        return { data: data.data, ms: performance.now() - start };
      }
      for (let i = 0; i < 20; i++) {
        const list = await request("/api/lists", "POST", {
          name: `fixture-filter-${i}`,
          tags: ["sample"],
        });
        for (let j = 0; j < 5; j++)
          await request("/fixture/membership", "POST", {
            list: list.data.id,
            status: ["confirmed", "unconfirmed", "unsubscribed"][j % 3],
            subscriberStatus: j % 2 ? "disabled" : "enabled",
          });
      }
      const samples: number[] = [];
      for (let i = 0; i < 55; i++) {
        const result = await request(
          "/api/lists?query=fixture-filter&tag=sample&order_by=subscriber_count&per_page=10",
        );
        if (result.data.total !== 20) throw new Error("Fixture count mismatch");
        if (i >= 5) samples.push(result.ms);
      }
      process.stdout.write(
        `${JSON.stringify({ repetition, kind: "synthetic-count-fixture", lists: 20, memberships: 100, warmup: 5, samples: 50, queryMeanMs: mean(samples) })}\n`,
      );
    } finally {
      await f.close();
    }
  }
}
