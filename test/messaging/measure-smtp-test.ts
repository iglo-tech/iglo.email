// Separately measured protected diagnostic HTTP route, on a disposable production process.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { percentile } from "@/test/perf/runtime-compat/metrics";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const admin = { user: "m21-measure-admin", password: "m21-measure-password" };
const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(sink, marker);
// The generated notification subject is fixed, so query by the unique synthetic recipient instead.
try {
  await withProduction(
    resolve("dist/iglo.email"),
    AbortSignal.timeout(120000),
    async (origin) => {
      const auth = await provisionApiUser(origin, admin);
      const latencies: number[] = [];
      for (let i = 0; i < 35; i++) {
        const begin = performance.now();
        const response = await fetch(`${origin}/api/settings/smtp/test`, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${auth.user}:${auth.token}`)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: `${marker}@example.test`,
            host: sink.host,
            port: sink.port,
            tls_type: "none",
            auth_protocol: "none",
          }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { data: [] });
        if (i >= 5) latencies.push(performance.now() - begin);
      }
      const query = new URLSearchParams({ query: `to:${marker}@example.test`, limit: "100" });
      const list = (await (await fetch(`${sink.api}/api/v1/search?${query}`)).json()) as {
        messages: Array<{ ID: string; MessageID: string }>;
      };
      assert.equal(list.messages.length, 35);
      assert.equal(new Set(list.messages.map((entry) => entry.MessageID)).size, 35);
      const removed = await fetch(`${sink.api}/api/v1/messages`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ IDs: list.messages.map((entry) => entry.ID) }),
      });
      assert.ok(removed.ok);
      console.log(
        JSON.stringify({
          warmup: 5,
          samples: 30,
          accepted: 35,
          uniqueIds: 35,
          latency: percentile(latencies),
          cleanup: 35,
        }),
      );
    },
    admin,
    120000,
  );
} finally {
  await mailpit.removeOwned();
}
