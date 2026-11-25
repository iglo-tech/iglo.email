// B118a item 3, through the compiled executable's HTTP API: a transactional send to an SMTP server
// that never greets is proven not sent, so the send answers `queued` for a retry, not `unknown`.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  admin,
  apiClient,
  buildExecutable,
  provisionAuthorization,
  removeDirectory,
  startServer,
  temporaryDirectory,
} from "@/test/backup/fixture";
import { silentServer } from "@/test/messaging/silent-server";
import { readJson } from "@/test/read-body";
import { instanceClient } from "@/test/settings/instance-client";

setDefaultTimeout(120_000);

let build = "";
let executable = "";
beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
});
afterAll(() => removeDirectory(build));

test("a transactional send to a server that never greets answers queued, not unknown", async () => {
  const base = temporaryDirectory();
  const silent = await silentServer("1s");
  const server = await startServer(executable, join(base, "data"));
  try {
    const client = apiClient(server.origin, await provisionAuthorization(server.origin));
    // B139: SMTP is an instance key, changed with the instance session.
    await (await instanceClient(server.origin, admin)).useSink(silent.port);

    const template = await client("/api/templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "retry", type: "tx", subject: "Retry", body: "<p>Retry</p>" }),
    });
    const templateId = (await readJson<{ data: { id: number } }>(template)).data.id;

    const sent = await client("/api/tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscriber_mode: "external",
        subscriber_emails: ["retry@example.test"],
        template_id: templateId,
        data: {},
      }),
    });
    expect(sent.status).toBe(200);
    const body = await readJson<{ data: { sends: Array<{ status: string }> } }>(sent);
    expect(body.data.sends.map((s) => s.status)).toEqual(["queued"]);
    expect(silent.bytesReceived()).toBe(0);
  } finally {
    await server.stop();
    await silent.close();
    removeDirectory(base);
  }
});
