// Compare the protected SMTP diagnostic through owned Mailpit for both compiled binaries.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const admin = { user: "m18-measure-admin", password: "m18-measure-password" };
const captures: { label: string; html: string; id: string; subject: string }[] = [];
const ids: string[] = [];
try {
  for (const [label, executable] of [
    ["control", "node_modules/.cache/m18-baseline/dist/iglo.email"],
    ["candidate", "dist/iglo.email"],
  ] as const) {
    const address = `m18-${label}-${sink.runId}@example.test`;
    await withProduction(
      resolve(executable),
      AbortSignal.timeout(30000),
      async (origin) => {
        const credentials = await provisionApiUser(origin, admin);
        const response = await fetch(`${origin}/api/settings/smtp/test`, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: address,
            host: sink.host,
            port: sink.port,
            auth_protocol: "none",
            tls_type: "none",
          }),
        });
        assert.equal(response.status, 200);
        const query = new URLSearchParams({ query: `to:${address}`, limit: "100" });
        const found = (await (await fetch(`${sink.api}/api/v1/search?${query}`)).json()) as {
          messages: { ID: string; MessageID: string; Subject: string }[];
        };
        assert.equal(found.messages.length, 1);
        const item = found.messages[0]!;
        ids.push(item.ID);
        const message = (await (await fetch(`${sink.api}/api/v1/message/${item.ID}`)).json()) as {
          HTML: string;
          To: { Address: string }[];
        };
        assert.deepEqual(
          message.To.map((x) => x.Address),
          [address],
        );
        captures.push({ label, html: message.HTML, id: item.MessageID, subject: item.Subject });
      },
      admin,
    );
  }
  const normalize = (html: string) => html.replace(/\s+/g, " ").trim();
  assert.equal(captures[0]!.subject, captures[1]!.subject);
  assert.equal(normalize(captures[0]!.html), normalize(captures[1]!.html));
  assert.notEqual(captures[0]!.id, captures[1]!.id);
  console.log(
    "SMTP diagnostic: two accepted messages, distinct IDs and whitespace-normalized HTML match",
  );
} finally {
  if (ids.length)
    await fetch(`${sink.api}/api/v1/messages`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs: ids }),
    });
}
