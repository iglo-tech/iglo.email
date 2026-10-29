// Identical bounded compiled list/subscriber write samples on disposable DBs.
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
const admin = { user: "fixture-admin", password: "fixture-admin-password" };
for (let repetition = 1; repetition <= 3; repetition++) {
  await withProduction(
    resolve(process.argv[2]!),
    AbortSignal.timeout(120000),
    async (origin) => {
      const credential = await provisionApiUser(origin, admin);
      const headers = {
        authorization: `Basic ${btoa(`${credential.user}:${credential.token}`)}`,
        "content-type": "application/json",
      };
      const call = async (path: string, method = "GET", body?: unknown) => {
        const response = await fetch(origin + path, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status !== 200)
          throw new Error(`Unexpected status ${response.status} for ${method} ${path}`);
        return ((await response.json()) as { data: any }).data;
      };
      const list = await call("/api/lists", "POST", { name: "measure-list" });
      const subscriber = await call("/api/subscribers", "POST", { email: "measure@example.test" });
      async function measure(fn: (i: number) => Promise<void>) {
        const samples: number[] = [];
        for (let i = 0; i < 25; i++) {
          const start = performance.now();
          await fn(i);
          if (i >= 5) samples.push(performance.now() - start);
        }
        return samples.reduce((a, b) => a + b, 0) / samples.length;
      }
      const listUpdate = await measure(async (i) => {
        await call(`/api/lists/${list.id}`, "PUT", { ...list, name: `measure-${i}` });
      });
      const subscriberUpdate = await measure(async (i) => {
        await call(`/api/subscribers/${subscriber.id}`, "PATCH", { name: `measure-${i}` });
      });
      process.stdout.write(`${JSON.stringify({ repetition, listUpdate, subscriberUpdate })}\n`);
    },
    admin,
    120000,
  );
}
