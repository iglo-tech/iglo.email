// Opt-in serial compiled HTTP comparison; all state is disposable and synthetic.
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
const admin = { user: "m18-measure-admin", password: "m18-measure-password" };
const executables = [
  ["control", resolve("node_modules/.cache/m18-baseline/dist/iglo.email")],
  ["candidate", resolve("dist/iglo.email")],
] as const;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
for (const [kind, executable] of executables)
  for (let rep = 1; rep <= 3; rep++) {
    await withProduction(
      executable,
      AbortSignal.timeout(120000),
      async (origin, _signal, restart) => {
        const credentials = await provisionApiUser(origin, admin);
        const headers = {
          authorization: `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`,
          "content-type": "application/json",
        };
        async function request(path: string, method = "GET", body?: unknown) {
          const response = await fetch(`${origin}${path}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          if (response.status !== 200)
            throw new Error(`HTTP ${response.status} in ${method} ${path.split("?")[0]}`);
          return ((await response.json()) as { data: any }).data;
        }
        const samples: number[] = [];
        const restartSamples: number[] = [];
        for (let i = 0; i < 25; i++) {
          const start = performance.now();
          await request("/api/health");
          await request("/api/settings");
          await request("/api/settings/app.site_name", "PUT", `Synthetic ${i}`);
          const list = await request("/api/lists", "POST", { name: `measure-list-${i}` });
          await request(`/api/lists/${list.id}`);
          await request(`/api/lists/${list.id}`, "PUT", { name: `measure-list-${i}-updated` });
          const email = `measure-${i}@example.test`;
          const sub = await request("/api/subscribers", "POST", {
            email,
            lists: [list.id],
            preconfirm_subscriptions: true,
          });
          await request(`/api/subscribers/${sub.id}`);
          await request(`/api/subscribers/${sub.id}`, "PUT", { email, name: "Synthetic" });
          await request(`/api/subscribers/${sub.id}`, "DELETE");
          await request(`/api/lists/${list.id}`, "DELETE");
          if (i >= 5) samples.push(performance.now() - start);
        }
        const start = performance.now();
        await restart();
        restartSamples.push(performance.now() - start);
        const settings = await request("/api/settings");
        if (settings["app.site_name"] !== "Synthetic 24")
          throw new Error("Restart did not preserve settings");
        const result: Record<string, unknown> = {
          kind,
          rep,
          warmup: 5,
          samples: samples.length,
          cycleMeanMs: mean(samples),
          restartMs: restartSamples[0],
        };
        if (kind === "candidate") {
          const times: number[] = [];
          for (let i = 0; i < 25; i++) {
            const begin = performance.now();
            const item = await request("/api/templates", "POST", {
              name: `synthetic-${i}`,
              type: "tx",
              subject: "Hello",
              body: "<p>{{ subscriber.name }}</p>",
            });
            const preview = await fetch(`${origin}/api/templates/${item.id}/preview`, {
              headers: { authorization: headers.authorization },
            });
            if (preview.status !== 200 || !(await preview.text()).includes("John Doe"))
              throw new Error("Preview failed");
            await request(`/api/templates/${item.id}`, "PUT", { name: `renamed-${i}` });
            await request(`/api/templates/${item.id}`, "DELETE");
            if (i >= 5) times.push(performance.now() - begin);
          }
          result.templateCycleMeanMs = mean(times);
          result.templateSamples = times.length;
        }
        console.log(JSON.stringify(result));
      },
      admin,
      120000,
    );
  }
