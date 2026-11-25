// B145b measurement (docs/perf/projects-B145b.md): outbox and campaign throughput of one project
// with the dispatcher's rate and hold inputs, as throughput.ts measures them (B138b, B141), but
// with the instance in this process so a stand-in for SES v2 GetAccount can answer it: the
// compiled executable only reaches AWS's own endpoint (B145a, D159). The same script measures both
// sides of a change: copy it into the control's tree and run it there, since it resolves `@/`
// against the tree it runs in.
//
// Usage: bun test/perf/projects/guard-throughput.ts <none|far> <label> [tx=2000] [recipients=5000]
//
// `none`: no SES API keys and `messaging.max_send_rate` 0 (no cap, D92), as throughput.ts.
// `far`: the keys saved, the stand-in answering a quota of 1,000,000,000 with nothing sent and
// MaxSendRate 20,000, and the setting at its highest, 10,000: the effective rate is 10,000 on both
// sides, far above the loops' throughput, and the snapshot is far from the hold line, so the
// guard's check runs on every grant and never holds. One JSON line per run goes to stdout.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import { adminCredentials } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";
import { startSink } from "@/test/tx/sink";

const mode = process.argv[2];
if (mode !== "none" && mode !== "far") {
  throw new Error("Usage: guard-throughput.ts <none|far> <label> [tx] [recipients]");
}
const label = process.argv[3] ?? "run";
const txCount = Number(process.argv[4] ?? 2000);
const recipients = Number(process.argv[5] ?? 5000);
const HOST = "127.0.0.1";
const token = "Measure0123456789Measure0123456789Measure0123456";

let reads = 0;
const ses = Bun.serve({
  port: 0,
  hostname: HOST,
  fetch: () => {
    reads++;
    return Response.json({
      SendQuota: { Max24HourSend: 1_000_000_000, MaxSendRate: 20_000, SentLast24Hours: 0 },
      ProductionAccessEnabled: true,
      SendingEnabled: true,
    });
  },
});
const sink = await startSink({ discardData: true });
const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b145b-measure-"));
const admin = await adminCredentials();
const instance = await openInstance(
  {
    dataDir,
    rootUrl: `http://${HOST}`,
    listen: { host: HOST, port: 0 },
    seed: {
      admin: { user: admin.user, password: admin.password },
      api: { user: "measure-api", token },
    },
    sesEndpoint: () => `http://${HOST}:${ses.port}`,
  },
  createRealClock(),
);
const server = serveRouted({ host: HOST, port: 0 }, (incoming, peer) =>
  instance.dispatch(incoming, peer),
);
instance.attach(server);
try {
  const port = server.port!;
  const operator = (await instanceLogin(port, HOST, admin)).session!;
  const current = await instanceCall(port, HOST, operator, "GET", "/api/instance/settings");
  const { data } = asBody<{ data: Record<string, unknown> }>(await current.json());
  const saved = await instanceCall(port, HOST, operator, "PUT", "/api/instance/settings", {
    ...data,
    "messaging.max_send_rate": mode === "far" ? 10_000 : 0,
    smtp: [
      {
        ...asBody<Array<Record<string, unknown>>>(data.smtp)[0],
        enabled: true,
        host: HOST,
        port: sink.port,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        max_conns: 10,
        max_msg_retries: 0,
      },
    ],
    ...(mode === "far"
      ? {
          "ses.api_region": "eu-west-1",
          "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLE",
          "ses.api_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        }
      : {}),
  });
  if (saved.status !== 200) {
    throw new Error(`Saving the settings answered ${saved.status}: ${await saved.text()}`);
  }
  let failed: unknown;
  instance.start((failure) => {
    failed = failure ?? new Error("a loop failed");
  });

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`http://${HOST}:${port}${path}`, {
      method,
      headers: {
        authorization: `token measure-api:${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== 200) {
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return asBody<{ data: T }>(await response.json()).data;
  };
  const list = await call<{ id: number }>("POST", "/api/lists", {
    name: "Measure",
    type: "private",
    optin: "single",
  });
  for (let start = 0; start < recipients; start += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, recipients - start) }, (_, offset) =>
        call("POST", "/api/subscribers", {
          email: `m${start + offset}@measure.test`,
          name: `M ${start + offset}`,
          status: "enabled",
          lists: [list.id],
          preconfirm_subscriptions: true,
        }),
      ),
    );
  }
  const templates = await call<Array<{ id: number; type: string }>>("GET", "/api/templates");
  const tx = templates.find((template) => template.type === "tx");
  if (!tx) {
    throw new Error("No transactional template");
  }
  if (mode === "far" && reads === 0) {
    throw new Error("The SES stand-in was never read");
  }

  const waitFor = async (count: number) => {
    while (sink.messages.length < count) {
      if (failed) {
        throw failed;
      }
      await Bun.sleep(5);
    }
    return performance.now();
  };

  // Outbox: async marketing sends are rows the marketing loop claims in granted slots.
  const txStart = performance.now();
  for (let sent = 0; sent < txCount; sent += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, txCount - sent) }, (_, offset) =>
        call("POST", "/api/tx", {
          subscriber_email: `m${(sent + offset) % recipients}@measure.test`,
          template_id: tx.id,
          kind: "marketing",
          list_id: list.id,
          async: true,
        }),
      ),
    );
  }
  const txEnd = await waitFor(txCount);

  // Campaign: one regular campaign to every subscriber of the list.
  const campaign = await call<{ id: number }>("POST", "/api/campaigns", {
    name: "Measure",
    subject: "Measure",
    lists: [list.id],
    from_email: "Measure <measure@measure.test>",
    content_type: "plain",
    type: "regular",
    messenger: "email",
    body: "Hello",
  });
  const campaignStart = performance.now();
  await call("PUT", `/api/campaigns/${campaign.id}/status`, { status: "running" });
  const campaignEnd = await waitFor(txCount + recipients);

  const txSeconds = (txEnd - txStart) / 1000;
  const campaignSeconds = (campaignEnd - campaignStart) / 1000;
  process.stdout.write(
    `${JSON.stringify({
      label,
      mode,
      tx: txCount,
      txSeconds: +txSeconds.toFixed(2),
      txPerSecond: +(txCount / txSeconds).toFixed(1),
      recipients,
      campaignSeconds: +campaignSeconds.toFixed(2),
      campaignPerSecond: +(recipients / campaignSeconds).toFixed(1),
    })}\n`,
  );
} finally {
  await Promise.allSettled(instance.stop());
  await server.stop(true);
  await instance.close();
  await sink.close();
  await ses.stop(true);
  await rm(dataDir, { recursive: true, force: true });
}
