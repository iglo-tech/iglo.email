// B145a (D159): what one `GET /api/sending/capacity` costs on a large project. One project with
// SENDS sends rows and DELIVERIES campaign deliveries spread over the last 48 hours, a running
// campaign, and a stand-in for SES. Prints the median and worst of RUNS requests. Not a CI
// threshold: `bun test/perf/projects/capacity.ts [sends] [deliveries]`.
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import { adminCredentials, createApiUser, logIn, request } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";

const SENDS = Number(process.argv[2] ?? 1_000_000);
const DELIVERIES = Number(process.argv[3] ?? 1_000_000);
const RUNS = 21;
const series = (count: number) =>
  `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${count})`;

const ses = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () =>
    Response.json({
      SendQuota: { Max24HourSend: 2_000_000, MaxSendRate: 14, SentLast24Hours: 900_000 },
      ProductionAccessEnabled: true,
      SendingEnabled: true,
    }),
});
const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b145a-measure-"));
const admin = await adminCredentials();
const instance = await openInstance(
  {
    dataDir,
    rootUrl: "http://127.0.0.1",
    listen: { host: "127.0.0.1", port: 0 },
    seed: { admin: { user: admin.user, password: admin.password } },
    sesEndpoint: () => `http://127.0.0.1:${ses.port}`,
  },
  createRealClock(),
);
const server = serveRouted({ host: "127.0.0.1", port: 0 }, (incoming, peer) =>
  instance.dispatch(incoming, peer),
);
instance.attach(server);
const port = server.port!;
try {
  const now = Date.now();
  const db = new Database(join(dataDir, "projects", "main", "iglo-email.db"));
  // i-th row at now − 48 h × i / count: half inside the last 24 hours.
  const at = (count: number) =>
    `strftime('%Y-%m-%dT%H:%M:%fZ', (${now} - 172800000.0 * i / ${count}) / 1000.0, 'unixepoch')`;
  const started = performance.now();
  db.run(`${series(SENDS)} INSERT INTO sends (uuid, source, kind, to_email, status, created_at, attempted_at, sent_at)
    SELECT 'm-' || i, 'tx', CASE i % 2 WHEN 0 THEN 'marketing' ELSE 'transactional' END, 'x@example.test', 'sent',
      ${at(SENDS)}, ${at(SENDS)}, ${at(SENDS)} FROM n`);
  db.run(`${series(DELIVERIES)} INSERT INTO subscribers (id, uuid, email, name, status, created_at, updated_at)
    SELECT i, 'ms-' || i, 'm' || i || '@example.test', 'S', 'enabled', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM n`);
  db.run(`INSERT INTO campaigns (id, uuid, name, subject, from_email, body, messenger, status, to_send, sent, created_at, updated_at)
    VALUES (1, 'mc-1', 'C', 's', 'a@example.test', 'b', 'email', 'running', ${DELIVERIES * 2}, ${DELIVERIES}, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  db.run(`${series(DELIVERIES)} INSERT INTO campaign_deliveries (campaign_id, subscriber_id, status, at)
    SELECT 1, i, 'sent', ${at(DELIVERIES)} FROM n`);
  db.close();
  const seeded = performance.now() - started;
  const key = await createApiUser(
    port,
    "127.0.0.1",
    await logIn(port, "127.0.0.1", admin),
    "measure",
  );
  const operator = (await instanceLogin(port, "127.0.0.1", admin)).session!;
  const current = await instanceCall(port, "127.0.0.1", operator, "GET", "/api/instance/settings");
  const { data } = asBody<{ data: Record<string, unknown> }>(await current.json());
  await instanceCall(port, "127.0.0.1", operator, "PUT", "/api/instance/settings", {
    ...data,
    "ses.api_region": "eu-west-1",
    "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLE",
    "ses.api_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  const times: Array<number> = [];
  let demand = 0;
  for (let run = 0; run < RUNS; run++) {
    const t = performance.now();
    const response = await request(port, "127.0.0.1", "/api/sending/capacity?count=10000", {
      headers: { authorization: key },
    });
    const body = asBody<{ data: { forecast: { demand: number } } }>(await response.json());
    times.push(performance.now() - t);
    demand = body.data.forecast.demand;
  }
  times.sort((a, b) => a - b);
  console.log(
    `sends ${SENDS}, deliveries ${DELIVERIES} (seeded in ${(seeded / 1000).toFixed(1)} s): ` +
      `median ${times[Math.floor(RUNS / 2)]!.toFixed(1)} ms, worst ${times.at(-1)!.toFixed(1)} ms, ` +
      `demand ${demand}`,
  );
} finally {
  await server.stop(true);
  await instance.close();
  await ses.stop(true);
  await rm(dataDir, { recursive: true, force: true });
}
