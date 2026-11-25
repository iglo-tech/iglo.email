// B145a: an instance with a stand-in for SES v2 GetAccount, for the agent-browser pass over the
// campaign page forecast and the instance settings "Check SES account" button. Not a test: run it
// with `bun test/projects/capacity-serve.ts`, read the printed URLs and credentials, stop it with
// Ctrl-C. It uses a temporary data directory and port 0 for both servers; nothing reaches AWS.
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import { adminCredentials } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";

/** `?quota=` on the stand-in's own URL changes Max24HourSend, to see the over-quota line. */
let max24HourSend = Number(process.argv[2] ?? 50_000);
const ses = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const quota = new URL(request.url).searchParams.get("quota");
    if (quota) {
      max24HourSend = Number(quota);
      return new Response(`Max24HourSend is now ${max24HourSend}\n`);
    }
    return Response.json({
      SendQuota: { Max24HourSend: max24HourSend, MaxSendRate: 14, SentLast24Hours: 1200 },
      ProductionAccessEnabled: true,
      SendingEnabled: true,
    });
  },
});
const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b145a-serve-"));
const admin = await adminCredentials();
const clock = createRealClock();
// The root URL names the port, so the admin's origin check accepts the browser: a free port first.
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const port = probe.port!;
await probe.stop(true);
const instance = await openInstance(
  {
    dataDir,
    rootUrl: `http://127.0.0.1:${port}`,
    listen: { host: "127.0.0.1", port },
    seed: { admin: { user: admin.user, password: admin.password } },
    sesEndpoint: () => `http://127.0.0.1:${ses.port}`,
  },
  clock,
);
const server = serveRouted({ host: "127.0.0.1", port }, (incoming, peer) =>
  instance.dispatch(incoming, peer),
);
instance.attach(server);

// A list of 3,000 and a draft campaign to it, written into the primary project's database.
const db = new Database(join(dataDir, "projects", "main", "iglo-email.db"));
const at = new Date().toISOString();
const series = "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 3000)";
db.run(
  `INSERT INTO lists (id, uuid, name, type, optin) VALUES (900, 'serve-list', 'Forecast list', 'private', 'single')`,
);
db.run(`${series} INSERT INTO subscribers (id, uuid, email, name, status, created_at, updated_at)
  SELECT 5000 + i, 'serve-sub-' || i, 'serve' || i || '@example.test', 'S', 'enabled', '${at}', '${at}' FROM n`);
db.run(`${series} INSERT INTO subscriber_lists (subscriber_id, list_id, status, created_at, updated_at)
  SELECT 5000 + i, 900, 'confirmed', '${at}', '${at}' FROM n`);
db.close();

const operator = (await instanceLogin(port, "127.0.0.1", admin)).session!;
const current = await instanceCall(port, "127.0.0.1", operator, "GET", "/api/instance/settings");
const { data } = asBody<{ data: Record<string, unknown> }>(await current.json());
const saved = await instanceCall(port, "127.0.0.1", operator, "PUT", "/api/instance/settings", {
  ...data,
  "ses.api_region": "eu-west-1",
  "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLE",
  "ses.api_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
});
if (saved.status !== 200) {
  throw new Error(`Saving the SES keys answered ${saved.status}: ${await saved.text()}`);
}

console.log(
  `admin:            http://127.0.0.1:${port}/admin  (${admin.user} / ${admin.password})`,
);
console.log(`instance settings: http://127.0.0.1:${port}/admin/instance/settings`);
console.log(`SES stand-in:     http://127.0.0.1:${ses.port}/?quota=2000 sets a small quota`);
console.log(`data directory:   ${dataDir}`);

const stop = async () => {
  await server.stop(true);
  await instance.close();
  await ses.stop(true);
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
