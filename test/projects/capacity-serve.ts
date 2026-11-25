// B145a: an instance with a stand-in for SES v2 GetAccount, for the agent-browser pass over the
// campaign page forecast and the instance settings "Check SES account" button, and (B143b) the
// instance Sending page in each of its states. Not a test: run it
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

/**
 * The stand-in's own URL changes its next answers: `?quota=` sets Max24HourSend (the over-quota
 * line), `?sent=` SentLast24Hours (the guard's hold, B143b), `?sandbox=1` and `?disabled=1` clear
 * ProductionAccessEnabled and SendingEnabled, `?fail=1` makes reads fail with an AWS-style 403
 * (stale), and `?fail=0`, `?sandbox=0`, `?disabled=0` undo them. A page reads again only once the
 * last read is over a minute old.
 */
let max24HourSend = Number(process.argv[2] ?? 50_000);
let sentLast24Hours = 1200;
let production = true;
let sending = true;
let fail = false;
const ses = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const query = new URL(request.url).searchParams;
    if (query.size) {
      const flag = (name: string, current: boolean) =>
        query.has(name) ? query.get(name) === "1" : current;
      max24HourSend = Number(query.get("quota") ?? max24HourSend);
      sentLast24Hours = Number(query.get("sent") ?? sentLast24Hours);
      production = !flag("sandbox", !production);
      sending = !flag("disabled", !sending);
      fail = flag("fail", fail);
      return new Response(
        `Max24HourSend ${max24HourSend}, SentLast24Hours ${sentLast24Hours}, production ${production}, sending ${sending}, failing ${fail}\n`,
      );
    }
    if (fail) {
      return Response.json(
        {
          message:
            "User: arn:aws:iam::123456789012:user/reader is not authorized to perform: ses:GetAccount",
        },
        { status: 403, headers: { "x-amzn-errortype": "AccessDeniedException:" } },
      );
    }
    return Response.json({
      SendQuota: {
        Max24HourSend: max24HourSend,
        MaxSendRate: 14,
        SentLast24Hours: sentLast24Hours,
      },
      ProductionAccessEnabled: production,
      SendingEnabled: sending,
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
console.log(`sending page:     http://127.0.0.1:${port}/admin/instance/sending`);
console.log(
  `SES stand-in:     http://127.0.0.1:${ses.port}/?quota=2000 sets a small quota (also ?sent=, ?sandbox=1, ?disabled=1, ?fail=1)`,
);
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
