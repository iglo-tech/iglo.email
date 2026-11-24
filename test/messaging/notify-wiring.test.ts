// Admin notifications as the compiled server sends them. src/main.ts passes app.logo_url into the
// notifier; this test saves a logo through the API, finishes a campaign, and reads the notification
// the server actually sends to a loopback SMTP sink. Public boundaries only: the HTTP API and the mail.
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
import { startSink } from "@/test/tx/sink";
import { readJson } from "@/test/read-body";
import { untilState } from "@/test/wait";
import { instanceClient } from "@/test/settings/instance-client";

setDefaultTimeout(120_000);

const logo = "https://example.test/logo.png";
let build = "";
let executable = "";
beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
});
afterAll(() => removeDirectory(build));

/**
 * Polls `read` until it returns a value. There is no progress signal beyond the value itself, so
 * the wait's 20 s limit is a stall window on that (B118d sweep).
 */
async function waitFor<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  let value: T | undefined;
  await untilState(async () => (value = await read()) !== undefined, {
    label: `timed out waiting for ${what}`,
    progress: () => (value === undefined ? "unread" : "read"),
    stallMs: 20_000,
    intervalMs: 25,
  });
  if (value === undefined) {
    throw new Error(`timed out waiting for ${what}`);
  }
  return value;
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
    // B139: SMTP is an instance key, changed with the instance session.
    await (await instanceClient(server.origin, admin)).useSink(sink.port);
    expect((await call("/api/settings/app.notify_emails", "PUT", ["ops@example.com"])).status).toBe(
      200,
    );
    expect((await call("/api/settings/app.logo_url", "PUT", logo)).status).toBe(200);

    const list = (
      await readJson<{ data: { id: number } }>(
        await call("/api/lists", "POST", { name: "Empty", type: "public" }),
      )
    ).data;
    const created = await readJson<{ data: { id: number } }>(
      await call("/api/campaigns", "POST", {
        name: "Logo",
        subject: "Logo",
        lists: [list.id],
        type: "regular",
        content_type: "html",
        body: "<p>Hello</p>",
      }),
    );
    expect(
      (await call(`/api/campaigns/${created.data.id}/status`, "PUT", { status: "running" })).status,
    ).toBe(200);

    await waitFor(async () => {
      const campaign = (
        await readJson<{ data: { status: string } }>(
          await call(`/api/campaigns/${created.data.id}`),
        )
      ).data;
      return campaign.status === "finished" ? true : undefined;
    }, "the campaign to finish");

    // The notification is queued after the finish commits and sent by the outbox.
    const mail = await waitFor(
      async () => sink.messages.find((m) => m.to.includes("ops@example.com")),
      "the admin notification",
    );

    // The message is quoted-printable: undo the soft line breaks and =3D escapes before matching.
    const html = mail.data.replaceAll("=\r\n", "").replaceAll("=3D", "=");
    expect(html).toContain(`src="${logo}"`);
  } finally {
    await server.stop();
    await sink.close();
    removeDirectory(base);
  }
});
