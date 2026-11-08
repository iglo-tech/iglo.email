// B35 (D89): Amazon SES is the only provider.
// Public boundary tests for Mailgun removal, migration, existing history, and UI.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { settingsView } from "@/admin/views/settings";
import { render } from "@/jsx/render";
import { buildDocument } from "@/openapi/document";
import { ensureProductionBuild } from "@/test/production-build";
import { healthWhenReady, startOnFreePort, stopChild } from "@/test/serve-port";
import { adminLogin } from "@/test/contract/owned";
import { TestClock } from "@/test/server/fixture";
import { txFixture } from "@/test/tx/fixture";

const repository = resolve(import.meta.dir, "../..");
const admin = { user: "b35-upgrade-admin", password: "b35-upgrade-synthetic-password" };
const legacySecret = "super-secret-mailgun-key";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

test("1. POST /webhooks/bounce/mailgun answers the same as an unknown route (404)", async () => {
  const f = await txFixture({ webhooks: {} });
  cleanups.push(() => f.close());

  const unknown = await f.request("/some-unknown-path", { method: "POST" });
  const mailgun = await f.request("/webhooks/bounce/mailgun", { method: "POST" });

  expect(mailgun.status).toBe(unknown.status);
  expect(mailgun.status).toBe(404);
});

test("2. Upgraded database drops stored bounce.mailgun row, GET /api/settings omits it, and PUT round-trips", async () => {
  // The schema before migration 0019 (B35), with a stored Mailgun secret.
  const dataDir = mkdtempSync(join(tmpdir(), "b35-upgrade-data-"));
  const directory = mkdtempSync(join(tmpdir(), "b35-upgrade-exe-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const before = openDatabase(dataDir);
  runMigrations(before, dataDir, new TestClock(), productionMigrations.slice(0, 18));
  before.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('bounce.mailgun', ?)", [
    JSON.stringify({ enabled: true, key: legacySecret }),
  ]);
  before.close(true);

  // The compiled executable starts on that database: it runs migration 0019 and serves settings.
  await ensureProductionBuild();
  const executable = join(directory, "iglo.email");
  copyFileSync(join(repository, "dist", "iglo.email"), executable);
  chmodSync(executable, 0o755);
  // Ready when this child answers /health and listens on the port: another server can hold it.
  const { child, port } = await startOnFreePort(async (listenPort) => {
    const started = Bun.spawn(
      [
        executable,
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(listenPort),
        "--data-dir",
        dataDir,
      ],
      {
        cwd: directory,
        env: {
          PATH: "",
          IGLO_EMAIL_ADMIN_USER: admin.user,
          IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    cleanups.push(() => stopChild(started));
    await healthWhenReady(started, listenPort, 10_000);
    return { child: started, port: listenPort };
  });
  const origin = `http://127.0.0.1:${port}`;

  const session = await adminLogin(origin, admin);
  const api = (path: string, method = "GET", body?: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        cookie: session.cookie,
        ...(method === "GET"
          ? {}
          : { "x-csrf-token": session.token, "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const getRes = await api("/api/settings");
  expect(getRes.status).toBe(200);
  const body = (await getRes.json()) as { data: Record<string, unknown> };
  expect(body.data["bounce.mailgun"]).toBeUndefined();

  // PUT round-trip succeeds
  expect((await api("/api/settings", "PUT", body.data)).status).toBe(200);

  // An old client sends bounce.mailgun in a full PUT: 200, the key is not stored or returned.
  expect(
    (
      await api("/api/settings", "PUT", {
        ...body.data,
        "bounce.mailgun": { enabled: true, key: "x" },
      })
    ).status,
  ).toBe(200);
  const getAfterPut = await api("/api/settings");
  expect(getAfterPut.status).toBe(200);
  const bodyAfterPut = (await getAfterPut.json()) as { data: Record<string, unknown> };
  expect(bodyAfterPut.data["bounce.mailgun"]).toBeUndefined();

  // Single-key PUT /api/settings/bounce.mailgun returns 400
  expect(
    (await api("/api/settings/bounce.mailgun", "PUT", { enabled: true, key: "x" })).status,
  ).toBe(400);

  // Migration 0019 removed the stored row, and nothing wrote it back.
  expect(await stopChild(child)).toBe(0);
  expect(await new Response(child.stderr).text()).not.toContain(legacySecret);
  const after = openDatabase(dataDir);
  expect(after.query("SELECT key FROM settings WHERE key = 'bounce.mailgun'").get()).toBeNull();
  after.close(true);
}, 120_000);

test("3. Existing source='mailgun' bounce row still shows in GET /api/bounces and wipes with subscriber", async () => {
  const f = await txFixture({ webhooks: {} });
  cleanups.push(() => f.close());

  const subId = await f.subscriber("mailgun-history@example.com", "History Person");
  const sub = (await f.json(`/api/subscribers/${subId}`)).body.data;

  // Insert a historic bounce with source = 'mailgun'
  f.db.run(
    `INSERT INTO bounces (subscriber_id, type, source, meta, created_at)
     VALUES (?, 'hard', 'mailgun', '{"code":550,"reason":"bounce"}', ?)`,
    [subId, f.clock.now().toISOString()],
  );

  // Shows in GET /api/bounces
  const listRes = await f.json("/api/bounces?source=mailgun");
  expect(listRes.status).toBe(200);
  const bounces = listRes.body.data.results as Array<{ id: number; source: string }>;
  expect(bounces.some((b) => b.source === "mailgun")).toBe(true);

  // Also export the subscriber who owns the source='mailgun' bounce row
  expect((await f.json("/api/settings/privacy.allow_export", "PUT", true)).status).toBe(200);
  const exportRes = await f.request(`/subscription/export/${sub.uuid}`, {
    method: "POST",
  });
  expect(exportRes.status).toBe(200);
  await f.drain();
  const [message] = f.mailTo(sub.email);
  expect(message).toBeDefined();
  const attachment = /filename="?data\.json"?[\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(
    message!.data,
  );
  expect(attachment).not.toBeNull();
  const report = JSON.parse(Buffer.from(attachment![1]!, "base64").toString("utf8"));
  expect(report.bounces.length).toBe(1);
  expect(report.bounces[0].source).toBe("mailgun");
  expect(report.bounces[0].type).toBe("hard");
  expect(report.bounces[0].meta).toEqual({ code: 550, reason: "bounce" });

  // Public wipe clears the bounce row with the subscriber
  const wipeRes = await f.request(`/subscription/wipe/${sub.uuid}`, {
    method: "POST",
  });
  expect(wipeRes.status).toBe(200);

  const remaining = f.db
    .query("SELECT count(*) as count FROM bounces WHERE subscriber_id = ?")
    .get(subId) as { count: bigint };
  expect(Number(remaining.count)).toBe(0);
});

test("5. Admin settings page Bounces tab shows only SES (no Mailgun, no inert providers, no mailbox editor)", async () => {
  const i18n = createTranslation();
  const page = await settingsView({
    context: {
      app: { i18n, logger: { error() {} } },
      url: new URL("http://fixture.test/admin/settings"),
      request: new Request("http://fixture.test/admin/settings"),
      params: {},
      peerAddress: "127.0.0.1",
    } as any,
    identity: { id: 1, username: "admin", type: "human" } as any,
    site: {
      siteName: "Test Site",
      faviconUrl: "",
      rootUrl: "http://fixture.test",
      cacheSlowQueries: false,
      disableTracking: false,
      individualTracking: false,
      fromEmails: [],
      messengers: [],
      publicSubscription: false,
      trustedUrls: [],
      captcha: { provider: "", key: "" },
      customCss: "",
      customJs: "",
    },
    can: () => true,
    listScope: () => ({ all: true, ids: [] }),
  });

  const html = render(page.body);

  // Shows SES
  expect(html).toContain("bounce.ses_topic_arns");

  // Does NOT contain Mailgun or inert provider setting names
  expect(html).not.toContain("bounce.mailgun");
  expect(html).not.toContain("bounce.sendgrid_enabled");
  expect(html).not.toContain("bounce.sendgrid_key");
  expect(html).not.toContain("bounce.postmark");
  expect(html).not.toContain("bounce.forwardemail");
  expect(html).not.toContain("bounce.lettermint");
  expect(html).not.toContain("bounce.azure");
  expect(html).not.toContain("bounce.mailboxes");
});

test("6. OpenAPI document has no Mailgun path, schema, or settings key", () => {
  const doc = JSON.parse(buildDocument());

  expect(doc.paths["/webhooks/bounce/mailgun"]).toBeUndefined();
  expect(doc.components.schemas.MailgunWebhook).toBeUndefined();
  expect(doc.components.schemas.Settings.properties["bounce.mailgun"]).toBeUndefined();
});
