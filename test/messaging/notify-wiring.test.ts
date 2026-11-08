// Admin notifications as the compiled server sends them. src/main.ts passes app.logo_url into the
// notifier; this test saves a logo through the API, finishes a campaign, and reads the notification
// the server actually sends to a loopback SMTP sink. Public boundaries only: the HTTP API and the mail.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  apiClient,
  buildExecutable,
  provisionAuthorization,
  removeDirectory,
  startServer,
  temporaryDirectory,
} from "@/test/backup/fixture";
import { startSink } from "@/test/tx/sink";

setDefaultTimeout(120_000);

const logo = "https://example.test/logo.png";
let build = "";
let executable = "";
beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
});
afterAll(() => removeDirectory(build));

/** Polls `read` until it returns a value, for at most 20 s of real time. */
async function waitFor<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

test("the admin notification carries the app.logo_url the server saved", async () => {
  const base = temporaryDirectory();
  const sink = await startSink();
  const server = await startServer(executable, join(base, "data"));
  try {
    const client = apiClient(server.origin, await provisionAuthorization(server.origin));
    const call = (path: string, method = "GET", body?: unknown) =>
      body === undefined
        ? client(path, { method })
        : client(path, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });

    // The seeded SMTP server points at the sink, without TLS or login. Its masked password is sent
    // back empty, which the API keeps (or, with auth none, drops).
    const seeded = ((await (await call("/api/settings")).json()) as { data: any }).data;
    const smtp = seeded.smtp.map((item: Record<string, unknown>, index: number) =>
      index === 0
        ? { ...item, host: "127.0.0.1", port: sink.port, tls_type: "none", auth_protocol: "none" }
        : item,
    );
    expect((await call("/api/settings/smtp", "PUT", smtp)).status).toBe(200);
    expect((await call("/api/settings/app.notify_emails", "PUT", ["ops@example.com"])).status).toBe(
      200,
    );
    expect((await call("/api/settings/app.logo_url", "PUT", logo)).status).toBe(200);

    const list = (
      (await (await call("/api/lists", "POST", { name: "Empty", type: "public" })).json()) as {
        data: { id: number };
      }
    ).data;
    const created = (await (
      await call("/api/campaigns", "POST", {
        name: "Logo",
        subject: "Logo",
        lists: [list.id],
        type: "regular",
        content_type: "html",
        body: "<p>Hello</p>",
      })
    ).json()) as { data: { id: number } };
    expect(
      (await call(`/api/campaigns/${created.data.id}/status`, "PUT", { status: "running" })).status,
    ).toBe(200);

    await waitFor(async () => {
      const campaign = (
        (await (await call(`/api/campaigns/${created.data.id}`)).json()) as {
          data: { status: string };
        }
      ).data;
      return campaign.status === "finished" ? true : undefined;
    }, "the campaign to finish");

    // The notification is queued after the finish commits and sent by the outbox.
    const mail = await waitFor(
      async () => sink.messages.find((m) => m.to.includes("ops@example.com")),
      "the admin notification",
    );

    // The message is quoted-printable: undo the soft line breaks and =3D escapes before matching.
    const html = mail.data.replace(/=\r\n/g, "").replace(/=3D/g, "=");
    expect(html).toContain(`src="${logo}"`);
  } finally {
    await server.stop();
    await sink.close();
    removeDirectory(base);
  }
});
