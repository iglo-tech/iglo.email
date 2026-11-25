// B138b measurement (docs/perf/projects-B138b.md; B139: projects-B139.md): outbox and campaign throughput of one project,
// against any compiled executable, through HTTP and a loopback SMTP sink only. The same script
// measures both sides of a change, since it does not read the data directory.
//
// Usage: bun test/perf/projects/throughput.ts <executable> <label> [tx=2000] [recipients=5000]
//
// Outbox: 2,000 async POST /api/tx, timed from the first request to the last message the sink
// receives. Campaign: one campaign to N subscribers, timed from the start to the last message.
// `messaging.max_send_rate` is 0 (no cap, D92) and the campaign pacing is raised out of the way,
// so the numbers are the loops' own throughput. One JSON line per run goes to stdout.
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { asBody } from "@/test/read-body";
import { portZeroRootUrl, readyOnPortZero, stopChild } from "@/test/serve-port";
import { startSink } from "@/test/tx/sink";
import { instanceClient } from "@/test/settings/instance-client";

const executable = resolve(process.argv[2] ?? "dist/iglo.email");
const label = process.argv[3] ?? "run";
const txCount = Number(process.argv[4] ?? 2000);
const recipients = Number(process.argv[5] ?? 5000);
const scratch = resolve(
  process.env.MEASURE_DIR ?? join(process.env.HOME ?? "/tmp", "scratch-b138b"),
);
const token = "Measure0123456789Measure0123456789Measure0123456";

const sink = await startSink({ discardData: true });
const dataDir = mkdtempSync(join(scratch, "throughput-"));
const child = Bun.spawn(
  [executable, "--port", "0", "--root-url", portZeroRootUrl, "--data-dir", dataDir],
  {
    env: {
      PATH: "",
      IGLO_EMAIL_ADMIN_USER: "measure-admin",
      IGLO_EMAIL_ADMIN_PASSWORD: "measure-admin-password",
      IGLO_EMAIL_API_USER: "measure-api",
      IGLO_EMAIL_API_TOKEN: token,
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
try {
  const { port } = await readyOnPortZero(child);
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
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
  // Every key below is an instance key since B139 (D154): a build with the instance settings API
  // (401 without a session) takes them there with the admin's session; an earlier one on /api/settings.
  const changes: Record<string, unknown> = {
    "messaging.max_send_rate": 0,
    "app.concurrency": 10,
    "app.message_rate": 100_000,
    "app.message_sliding_window": false,
    smtp: [
      {
        enabled: true,
        host: "127.0.0.1",
        port: sink.port,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        tls_skip_verify: false,
        max_conns: 10,
        max_msg_retries: 0,
        msg_retry_delay: "10ms",
        idle_timeout: "15s",
        wait_timeout: "5s",
        hello_hostname: "",
        name: "",
        from_addresses: [],
        email_headers: [],
        exclude_from_default: false,
      },
    ],
  };
  const origin = `http://127.0.0.1:${port}`;
  if ((await fetch(`${origin}/api/instance/settings`)).status === 401) {
    const instance = await instanceClient(origin, {
      user: "measure-admin",
      password: "measure-admin-password",
    });
    await instance.update((current) => ({ ...current, ...changes }));
  } else {
    const settings = await call<Record<string, unknown>>("GET", "/api/settings");
    await call("PUT", "/api/settings", { ...settings, ...changes });
  }
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

  const waitFor = async (count: number) => {
    while (sink.messages.length < count) {
      await Bun.sleep(5);
    }
    return performance.now();
  };

  // Outbox: async sends are rows the outbox claims and pushes.
  const txStart = performance.now();
  for (let sent = 0; sent < txCount; sent += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, txCount - sent) }, (_, offset) =>
        call("POST", "/api/tx", {
          subscriber_email: `m${(sent + offset) % recipients}@measure.test`,
          template_id: tx.id,
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
      tx: txCount,
      txSeconds: +txSeconds.toFixed(2),
      txPerSecond: +(txCount / txSeconds).toFixed(1),
      recipients,
      campaignSeconds: +campaignSeconds.toFixed(2),
      campaignPerSecond: +(recipients / campaignSeconds).toFixed(1),
    })}\n`,
  );
} finally {
  await stopChild(child, "SIGTERM", 10_000);
  await sink.close();
  rmSync(dataDir, { recursive: true, force: true });
}
