// The restore hold through the compiled executable, the SMTP sink and a webhook receiver. A
// restored database has lost later deliveries and later opt-outs, so it must send nothing, by any
// path, until an operator says so. docs/design/09-decisions.md (D67) names the paths.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  apiClient,
  buildExecutable,
  provisionAuthorization,
  removeDirectory,
  restoreInto,
  runBackup,
  startServer,
  temporaryDirectory,
  type Client,
  type Server,
} from "@/test/backup/fixture";
import { createRealClock } from "@/clock";
import { createEmailer } from "@/messaging/email";
import { HttpError } from "@/server/response";
import { startSink } from "@/test/tx/sink";

setDefaultTimeout(120_000);
/** Longer than the campaign runner's scan and every sending loop's poll. */
const QUIET_MS = 6_500;
const ACKNOWLEDGE = "--consent-reconciled";
let executable = "";
let build = "";
let base = "";
let dataDir = "";
let server: Server | undefined;
let sink: Awaited<ReturnType<typeof startSink>> | undefined;
let receiver: ReturnType<typeof Bun.serve> | undefined;
let hooks: string[] = [];

beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
}, 120_000);
afterAll(() => removeDirectory(build));
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await sink?.close();
  sink = undefined;
  await receiver?.stop(true);
  receiver = undefined;
  hooks = [];
  if (base) removeDirectory(base);
  base = "";
});

const json = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
const put = (value: unknown): RequestInit => ({ ...json(value), method: "PUT" });
const data = async (response: Response) => {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.url}: ${response.status} ${text}`);
  return (JSON.parse(text) as { data: any }).data;
};
const subjects = () => sink!.messages.map(({ data }) => /^Subject: (.*)$/m.exec(data)?.[1] ?? "");
const recipients = (subject: string) =>
  sink!.messages
    .filter(({ data }) => data.includes(`Subject: ${subject}`))
    .flatMap(({ to }) => to)
    .sort();
async function until(condition: () => boolean, what: string, ms = 30_000) {
  for (const deadline = Date.now() + ms; !condition(); await Bun.sleep(25))
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
}
const stopServer = async () => {
  await server!.stop();
  server = undefined;
};

/** A server with SMTP going to the sink and webhooks to the receiver. */
async function stack() {
  base = temporaryDirectory();
  dataDir = join(base, "data");
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  sink = await startSink();
  receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      // Only a signed delivery counts: tools on the host probe local ports.
      if (request.headers.has("x-iglo-email-signature")) hooks.push(await request.text());
      return new Response("ok");
    },
  });
  server = await startServer(executable, dataDir);
  const authorization = await provisionAuthorization(server.origin);
  const client = apiClient(server.origin, authorization);
  const settings = await data(await client("/api/settings"));
  await data(
    await client(
      "/api/settings/smtp",
      put([
        {
          ...settings.smtp[0],
          enabled: true,
          host: "127.0.0.1",
          port: sink.port,
          auth_protocol: "none",
          username: "",
          password: "",
          tls_type: "none",
          email_headers: [],
        },
      ]),
    ),
  );
  await data(await client("/api/settings/webhooks.block_private_addresses", put(false)));
  await data(
    await client(
      "/api/webhooks",
      json({ url: `http://127.0.0.1:${receiver.port}/`, events: ["subscriber.unsubscribed"] }),
    ),
  );
  const list = await data(
    await client("/api/lists", json({ name: "News", type: "public", optin: "single" })),
  );
  const subscriber = async (name: string, lists: number[] = [list.id]) =>
    data(
      await client(
        "/api/subscribers",
        json({
          email: `${name}@example.test`,
          name,
          status: "enabled",
          lists,
          preconfirm_subscriptions: true,
        }),
      ),
    );
  return { authorization, client, list, subscriber };
}
const campaign = async (client: Client, list: number, subject: string, sendAt?: string) =>
  data(
    await client(
      "/api/campaigns",
      json({
        name: subject,
        subject,
        lists: [list],
        content_type: "plain",
        type: "regular",
        messenger: "email",
        body: "Body",
        ...(sendAt ? { send_at: sendAt } : {}),
      }),
    ),
  );
const backupTo = async (output: string) => {
  const result = await runBackup(executable, ["--data-dir", dataDir, "--output", output]);
  expect(result.exitCode).toBe(0);
  return result;
};
const release = (...args: string[]) =>
  runBackup(executable, ["--release-hold", "--data-dir", dataDir, ...args]);
const restart = async (authorization: string) => {
  server = await startServer(executable, dataDir);
  return apiClient(server.origin, authorization);
};

test("a restored install sends nothing to someone who opted out after the backup", async () => {
  const { authorization, client, list, subscriber } = await stack();
  const alice = await subscriber("alice");
  await subscriber("bob");
  const sendAt = new Date(Date.now() + 4_000).toISOString();
  const scheduled = await campaign(client, list.id, "Once only", sendAt);
  await data(await client(`/api/campaigns/${scheduled.id}/status`, put({ status: "scheduled" })));
  const output = join(base, "backup");
  await backupTo(output);

  await until(() => recipients("Once only").length === 2, "the campaign");
  const unsubscribe = () =>
    fetch(`${server!.origin}/subscription/${scheduled.uuid}/${alice.uuid}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
  expect((await unsubscribe()).status).toBe(200);
  await stopServer();

  restoreInto(output, dataDir);
  await restart(authorization);
  await Bun.sleep(QUIET_MS);
  expect(recipients("Once only")).toEqual(["alice@example.test", "bob@example.test"]);

  // The hold does not stop the operator putting the lost opt-out back.
  expect((await unsubscribe()).status).toBe(200);
  const running = await release(ACKNOWLEDGE);
  expect(running.exitCode).toBe(1);
  expect(running.stderr).toContain("stop");
  await stopServer();
  const unacknowledged = await release();
  expect(unacknowledged.exitCode).toBe(1);
  expect(unacknowledged.stderr).toContain(ACKNOWLEDGE);
  expect(
    (await runBackup(executable, ["--verify", join(dataDir, "iglo-email.db")])).stdout,
  ).toMatch(/Hold: held since /);

  // Released, the restored campaign goes on: only what the operator reapplied is honoured.
  const released = await release(ACKNOWLEDGE);
  expect(released.exitCode).toBe(0);
  expect(
    (await runBackup(executable, ["--verify", join(dataDir, "iglo-email.db")])).stdout,
  ).toMatch(/Hold: released at /);
  await restart(authorization);
  expect(await (await fetch(server!.health)).json()).toEqual({ data: true });
  await until(() => recipients("Once only").length === 3, "the released campaign");
  expect(recipients("Once only")).toEqual([
    "alice@example.test",
    "bob@example.test",
    "bob@example.test",
  ]);
  await Bun.sleep(QUIET_MS);
  expect(recipients("Once only")).toHaveLength(3);
});

test("while held every path is stopped, what was queued stays, and a refusal still lands", async () => {
  const { authorization, client, list, subscriber } = await stack();
  const reader = await subscriber("reader");
  const leaver = await subscriber("leaver");
  const doubleList = await data(
    await client("/api/lists", json({ name: "Confirmed", type: "public", optin: "double" })),
  );
  const template = await data(
    await client(
      "/api/templates",
      json({ name: "Step", type: "tx", subject: "Tx subject", body: "<p>Tx body</p>" }),
    ),
  );
  const sequence = await data(
    await client(
      "/api/sequences",
      json({
        name: "Welcome",
        status: "active",
        reentry: "never",
        trigger: { event: "joined" },
        steps: [{ wait: "PT0S", kind: "transactional", template_id: template.id }],
      }),
    ),
  );
  const sent = await data(
    await client(
      "/api/tx",
      json({ subscriber_id: reader.id, template_id: template.id, subject: "Before" }),
    ),
  );
  await until(() => subjects().includes("Before"), "the send before the backup");
  const running = await campaign(client, list.id, "Was running");
  const paused = await campaign(client, list.id, "Was paused");
  const admin = await data(await client("/api/subscribers?per_page=1"));
  expect(admin.total).toBe(2);
  const output = join(base, "backup");
  await backupTo(output);
  await stopServer();
  restoreInto(output, dataDir);
  // A campaign the snapshot caught running.
  const seeded = new Database(join(dataDir, "iglo-email.db"));
  seeded.query("UPDATE campaigns SET status = 'running' WHERE id = ?").run(running.id);
  seeded.close();
  const before = sink!.messages.length;
  const held = await restart(authorization);

  // Each path that hands a message to the emailer. A refused one says so and leaves no row.
  const refused = async (response: Response) => {
    expect(response.status).toBe(503);
    expect(((await response.json()) as { message: string }).message).toContain("held");
  };
  const tx = { subscriber_id: reader.id, template_id: template.id };
  await refused(await held("/api/tx", json(tx)));
  await refused(await held(`/api/sends/${sent.sends[0].id}/resend`, { method: "POST" }));
  await refused(
    await held(
      `/api/campaigns/${paused.id}/test`,
      json({ ...paused, lists: [list.id], subscribers: ["reader@example.test"] }),
    ),
  );
  await refused(await held(`/api/campaigns/${paused.id}/status`, put({ status: "running" })));
  await refused(
    await held(
      "/api/settings/smtp/test",
      json({
        email: "reader@example.test",
        host: "127.0.0.1",
        port: sink!.port,
        auth_protocol: "none",
        tls_type: "none",
        max_conns: 1,
      }),
    ),
  );
  await refused(await held(`/api/subscribers/${reader.id}/optin`, { method: "POST" }));
  await refused(
    await held(
      "/api/enrollments",
      json({ sequence_id: sequence.id, subscriber_id: reader.id, test: true }),
    ),
  );
  const forgot = await fetch(`${server!.origin}/admin/forgot`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=admin%40example.test",
  });
  expect(forgot.status).toBe(503);
  const exported = await fetch(`${server!.origin}/subscription/export/${reader.uuid}`, {
    method: "POST",
  });
  expect(exported.status).toBe(503);

  // These are accepted and wait: queued rows, a due sequence step, opt-in mail and a webhook.
  await data(await held("/api/tx", json({ ...tx, subject: "Queued", async: true })));
  await data(
    await held(
      "/api/tx",
      json({
        ...tx,
        subject: "Queued marketing",
        kind: "marketing",
        list_id: list.id,
        async: true,
      }),
    ),
  );
  await data(
    await held(
      "/api/subscriber-events",
      json({ name: "joined", subscriber: { email: "reader@example.test" }, data: {} }),
    ),
  );
  await data(
    await held(
      "/api/subscribers",
      json({ email: "confirm@example.test", name: "c", status: "enabled", lists: [doubleList.id] }),
    ),
  );

  // Reading, consent and paused work go on.
  expect((await held("/api/campaigns")).status).toBe(200);
  const leaving = await fetch(`${server!.origin}/subscription/${running.uuid}/${leaver.uuid}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(leaving.status).toBe(200);
  const left = await data(await held(`/api/subscribers/${leaver.id}`));
  expect(left.lists.map(({ subscription_status }: any) => subscription_status)).toEqual([
    "unsubscribed",
  ]);

  // The settings API can neither see nor clear a hold.
  const settings = await data(await held("/api/settings"));
  expect(JSON.stringify(settings)).not.toContain("restore.hold");
  await data(await held("/api/settings", put({ ...settings, "restore.hold": null })));

  await Bun.sleep(QUIET_MS);
  expect(sink!.messages.length).toBe(before);
  expect(hooks).toEqual([]);

  const health = (await (await fetch(server!.health)).json()) as {
    data: boolean;
    hold: { since: string; reason: string };
  };
  expect(health.data).toBe(true);
  expect(health.hold.reason).toContain("backup");
  const login = await held("/admin");
  expect(await login.text()).toContain("restore-hold");

  // Nothing was marked failed.
  const queued = await data(await held("/api/sends?status=queued"));
  expect(queued.total).toBeGreaterThanOrEqual(2);
  expect((await data(await held("/api/sends?status=failed"))).total).toBe(0);

  // A backup of a held install is held too, since the same moment.
  const second = join(base, "second");
  await backupTo(second);
  const report = await runBackup(executable, ["--verify", second]);
  expect(report.stdout).toContain(`Hold: held since ${health.hold.since}`);
  await stopServer();

  // A release lets the waiting work go, and the refused requests left nothing behind.
  expect((await release(ACKNOWLEDGE)).exitCode).toBe(0);
  await restart(authorization);
  await until(
    () => ["Queued", "Queued marketing"].every((subject) => subjects().includes(subject)),
    "the queued sends",
  );
  await until(() => subjects().includes("Tx subject"), "the sequence step");
  await until(() => hooks.length > 0, "the webhook");
  await until(() => sink!.messages.some(({ to }) => to.includes("confirm@example.test")), "opt-in");
  expect(readdirSync(dataDir)).toContain("iglo-email.db");
});

test("the emailer's last gate refuses a push and a test before any connection", async () => {
  sink = await startSink();
  const server = {
    enabled: true,
    host: "127.0.0.1",
    port: sink.port,
    auth_protocol: "none",
    tls_type: "none",
    max_conns: 1,
  } as Parameters<ReturnType<typeof createEmailer>["test"]>[0];
  const emailer = createEmailer({
    clock: createRealClock(),
    settings: () => ({ smtp: [server], rootUrl: "http://localhost" }),
    refuse() {
      throw new HttpError(503, "held");
    },
  });
  const message = {
    from: "a@example.test",
    to: ["b@example.test"],
    subject: "Never",
    contentType: "plain" as const,
    body: Buffer.from("x"),
  };
  expect(() => emailer.push(message)).toThrow("held");
  expect(() => emailer.test(server, message, "http://localhost")).toThrow("held");
  await emailer.close();
  expect(sink.messages).toEqual([]);
});

test("backup and --verify report a hold", async () => {
  await stack();
  const output = join(base, "backup");
  expect((await backupTo(output)).stdout).toMatch(/Hold: held since /);
  expect((await runBackup(executable, ["--verify", output])).stdout).toMatch(/Hold: held since /);
});

test("--release-hold says what it needs and refuses a directory it cannot read", async () => {
  await stack();
  await stopServer();
  const none = await release(ACKNOWLEDGE);
  expect(none.exitCode).toBe(0);
  expect(none.stdout).toContain("No hold");
  const absent = await runBackup(executable, [
    "--release-hold",
    ACKNOWLEDGE,
    "--data-dir",
    join(base, "absent"),
  ]);
  expect(absent.exitCode).toBe(1);
  expect(absent.stderr).toContain("No database");
  const combined = await runBackup(executable, ["--release-hold", "--verify", "x"]);
  expect(combined.exitCode).toBe(1);
  const alone = await runBackup(executable, [ACKNOWLEDGE, "--data-dir", dataDir]);
  expect(alone.exitCode).toBe(1);
});
