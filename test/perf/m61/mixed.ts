// End-to-end throughput against the 02-architecture targets (docs/perf/M6.1-performance.md):
// the compiled build, real HTTP for every input, a loopback SMTP sink. Scenarios:
// - `events`: open-loop POST /api/subscriber-events at 100/s alone (reference for latency).
// - `baseline`: a running campaign plus the 100/s events.
// - `mixed`: the baseline plus active sequences (every tenth event is a `signup` that enrolls
//   in a sequence whose first step queues a send now, and in one that exits on the next
//   `order_paid`) and a trickle of async transactional POST /api/tx sends.
// Usage: bun run perf:mixed [events|baseline|mixed ...]. M61_WINDOW_MS (default 300000),
// M61_CONCURRENCY and M61_RATE (campaign workers, default 8 x 10), M61_TX_PER_SECOND (2),
// M61_AUDIENCE (campaign subscribers; default enough for the configured maximum rate).
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { provisionApiUser } from "@/test/contract/owned";
import {
  measurementBase,
  memAvailable,
  record,
  repository,
  rssOf,
  stats,
} from "@/test/perf/m61/record";

const executable = join(repository, "dist/iglo.email");
const base = measurementBase();
const windowMs = Number(process.env.M61_WINDOW_MS ?? 300_000);
const concurrency = Number(process.env.M61_CONCURRENCY ?? 8);
const rate = Number(process.env.M61_RATE ?? 10);
const txPerSecond = Number(process.env.M61_TX_PER_SECOND ?? 2);
const EVENT_MS = 10;
const MAX_IN_FLIGHT = 500;
const SUBSCRIBERS = 2000;
const fixtures = readFileSync(join(repository, "test/users/fixtures.md"), "utf8");
const admin = {
  user: /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixtures)![1]!,
  password: /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixtures)![1]!,
};

/** Loopback SMTP sink: recipient and accept time of every message, nothing else. */
async function startSink() {
  const delivered: { to: string; accepted: number }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("latin1");
    let buffer = "";
    let data = false;
    let to = "";
    socket.write("220 sink.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line !== ".") continue;
          data = false;
          delivered.push({ to, accepted: performance.now() });
          socket.write("250 queued\r\n");
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-sink.test\r\n250 8BITMIME\r\n");
        else if (verb === "RCPT") {
          to = /<([^>]*)>/.exec(line)?.[1] ?? "";
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          data = true;
          socket.write("354 go\r\n");
        } else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    delivered,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

async function availablePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** The compiled server over a fresh data directory. */
async function startServer(directory: string) {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child: ChildProcess = spawn(
    executable,
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--data-dir", join(directory, "data")],
    {
      cwd: directory,
      env: {
        PATH: "",
        IGLO_EMAIL_ADMIN_USER: admin.user,
        IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr!.on("data", (chunk: Buffer) => {
    if (stderr.length < 1_000_000) stderr += chunk.toString();
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try {
      if ((await fetch(`${origin}/health`)).status === 200) break;
    } catch {
      /* not ready */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("server readiness timed out");
    }
    await Bun.sleep(25);
  }
  return {
    origin,
    pid: child.pid!,
    database: join(directory, "data", "iglo-email.db"),
    get stderr() {
      return stderr;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

async function setup(origin: string, sinkPort: number) {
  const credentials = await provisionApiUser(origin, admin);
  const authorization = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const current = (await api("/api/settings")).body.data;
  const settings = {
    "app.concurrency": concurrency,
    "app.message_rate": rate,
    "app.batch_size": 1000,
    "app.message_sliding_window": false,
  };
  const updated = await api("/api/settings", "PUT", {
    ...current,
    ...settings,
    "app.from_email": ["Measure <measure@example.test>"],
    smtp: [
      {
        ...current.smtp[0],
        enabled: true,
        host: "127.0.0.1",
        port: sinkPort,
        max_conns: 10,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        email_headers: [],
      },
    ],
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  return { api, authorization, settings };
}
type Api = Awaited<ReturnType<typeof setup>>["api"];

async function seed(api: Api, count: number, list: number, parallel = 8) {
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < count) {
        const i = next++;
        const r = await api("/api/subscribers", "POST", {
          email: `m${String(i).padStart(6, "0")}@example.test`,
          name: `Subscriber ${i}`,
          lists: [list],
          preconfirm_subscriptions: true,
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
    }),
  );
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

type Result = { deadline: number; done: number; status: number };

async function run(name: "events" | "baseline" | "mixed") {
  const campaign = name !== "events";
  const sequences = name === "mixed";
  const directory = mkdtempSync(join(base, `m61-${name}-`));
  const sink = await startSink();
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  let reader: Database | undefined;
  try {
    app = await startServer(directory);
    const { api, authorization, settings } = await setup(app.origin, sink.port);
    let campaignId = 0;
    const audience = Number(
      process.env.M61_AUDIENCE ?? Math.ceil((windowMs / 1000) * concurrency * rate * 1.1) + 1000,
    );
    const seedStarted = performance.now();
    if (campaign) {
      const list = (await api("/api/lists", "POST", { name: "mixed", type: "public" })).body.data
        .id;
      await seed(api, audience, list);
      const created = await api("/api/campaigns", "POST", {
        name: "mixed",
        subject: "Hello {{ subscriber.name }}",
        lists: [list],
        body: "<p>Hi {{ subscriber.name }}</p>",
      });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      campaignId = created.body.data.id;
    }
    const seedSeconds = (performance.now() - seedStarted) / 1000;
    let template = 0;
    if (sequences) {
      const created = await api("/api/templates", "POST", {
        name: "measure",
        type: "tx",
        subject: "Measure {{ subscriber.name }}",
        body: "<p>Hello {{ subscriber.name }}</p>",
      });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      template = created.body.data.id;
      const sends = await api("/api/sequences", "POST", {
        name: "welcome",
        status: "active",
        trigger: { event: "signup" },
        reentry: "always",
        steps: [
          { wait: "PT0S", kind: "transactional", template_id: template },
          { wait: "P1D", kind: "transactional", template_id: template },
        ],
      });
      const exits = await api("/api/sequences", "POST", {
        name: "nudge",
        status: "active",
        trigger: { event: "signup" },
        exit_on: ["order_paid"],
        reentry: "always",
        steps: [{ wait: "P1D", kind: "transactional", template_id: template }],
      });
      assert.equal(sends.status, 200, JSON.stringify(sends.body));
      assert.equal(exits.status, 200, JSON.stringify(exits.body));
    }
    for (let i = 0; i < 20; i++)
      await api("/api/subscriber-events", "POST", {
        subscriber: { email: `warm${i}@example.test` },
        name: "warmup",
      });
    reader = new Database(app.database, { readonly: true });
    const db = reader;
    const queue = () =>
      Object.fromEntries(
        (
          db.query("SELECT status, count(*) AS n FROM sends GROUP BY status").all() as {
            status: string;
            n: number;
          }[]
        ).map((row) => [row.status, row.n]),
      );
    const enrollments = () =>
      Object.fromEntries(
        (
          db.query("SELECT status, count(*) AS n FROM enrollments GROUP BY status").all() as {
            status: string;
            n: number;
          }[]
        ).map((row) => [row.status, row.n]),
      );
    const campaignState = async () => {
      const data = (await api(`/api/campaigns/${campaignId}`)).body.data;
      return { status: data.status, to_send: data.to_send, sent: data.sent };
    };
    if (campaign) {
      await api(`/api/campaigns/${campaignId}/status`, "PUT", { status: "running" });
      // The window starts once the runner is sending.
      await waitFor(() => sink.delivered.length > 0, 30_000, "first campaign message");
    }

    const events: Result[] = [];
    const tx: (Result & { to: string })[] = [];
    let inFlight = 0,
      inFlightPeak = 0,
      shed = 0;
    const pending = new Set<Promise<void>>();
    const send = (path: string, body: unknown, deadline: number, into: (r: Result) => void) => {
      if (inFlight >= MAX_IN_FLIGHT) {
        shed++;
        return;
      }
      inFlight++;
      inFlightPeak = Math.max(inFlightPeak, inFlight);
      const p = fetch(`${app!.origin}${path}`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (r) => {
          await r.arrayBuffer();
          into({ deadline, done: performance.now(), status: r.status });
        })
        .catch(() => into({ deadline, done: performance.now(), status: 0 }))
        .finally(() => {
          inFlight--;
          pending.delete(p);
        });
      pending.add(p);
    };
    const start = performance.now() + 50;
    const end = start + windowMs;
    const startQueue = queue();
    const startCampaign = campaign ? await campaignState() : null;
    const samples: object[] = [];
    let nextSample = start;
    let eventIndex = 0,
      txIndex = 0,
      memLow = memAvailable(),
      rssPeak = rssOf(app.pid) ?? 0;
    const txMs = 1000 / txPerSecond;
    while (performance.now() < end) {
      const now = performance.now();
      if (now >= nextSample) {
        const rss = rssOf(app.pid);
        const mem = memAvailable();
        rssPeak = Math.max(rssPeak, rss ?? 0);
        memLow = Math.min(memLow, mem);
        samples.push({
          t: Math.round(now - start),
          inFlight,
          mail: sink.delivered.length,
          sends: queue(),
          rss,
          mem,
        });
        nextSample += 5000;
      }
      while (start + eventIndex * EVENT_MS <= now && eventIndex * EVENT_MS < windowMs) {
        const n = eventIndex++;
        const signup = sequences && n % 10 === 0;
        send(
          "/api/subscriber-events",
          {
            subscriber: {
              external_id: `u${n % SUBSCRIBERS}`,
              email: `ev${n % SUBSCRIBERS}@example.test`,
              attribs: { n, plan: n % 3 ? "trial" : "paid" },
            },
            name: signup ? "signup" : "order_paid",
            data: { order: n, amount: 79, currency: "USD" },
            idempotency_key: `evt-${n}`,
          },
          start + n * EVENT_MS,
          (r) => events.push(r),
        );
      }
      while (sequences && start + txIndex * txMs <= now && txIndex * txMs < windowMs) {
        const i = txIndex++;
        const to = `tx${i}@example.test`;
        send(
          "/api/tx",
          {
            subscriber_mode: "external",
            subscriber_emails: [to],
            template_id: template,
            data: { i },
            async: true,
          },
          start + i * txMs,
          (r) => tx.push({ ...r, to }),
        );
      }
      await Bun.sleep(1);
    }
    const inFlightAtEnd = inFlight;
    const endQueue = queue();
    const endCampaign = campaign ? await campaignState() : null;
    const endEnrollments = sequences ? enrollments() : null;
    await Promise.all(pending);
    // Let tx and sequence sends queued near the end arrive, for their delivery latency.
    if (sequences) await Bun.sleep(5_000);

    const inWindow = (d: { accepted: number }) => d.accepted >= start && d.accepted < end;
    const mail = sink.delivered;
    const campaignMail = mail.filter((d) => d.to.startsWith("m") && inWindow(d));
    const sequenceMail = mail.filter((d) => d.to.startsWith("ev") && inWindow(d));
    const txMail = new Map(mail.filter((d) => d.to.startsWith("tx")).map((d) => [d.to, d]));
    const buckets: number[] = Array.from({ length: Math.ceil(windowMs / 10_000) }, () => 0);
    for (const d of campaignMail) buckets[Math.floor((d.accepted - start) / 10_000)]!++;
    const times = campaignMail.map((d) => d.accepted).sort((a, b) => a - b);
    let maxOneSecond = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (times[j]! < times[i]! - 1000) j++;
      maxOneSecond = Math.max(maxOneSecond, i - j + 1);
    }
    const ok = (r: Result) => r.status === 200;
    const errors = app.stderr.split("\n").filter((line) => line.trim()).length;
    const campaignRate = campaignMail.length / (windowMs / 1000);
    const eventsInWindow = events.filter((r) => ok(r) && r.done < end).length;
    const result = {
      scenario: `mixed-${name}`,
      windowMs,
      settings: campaign ? settings : null,
      seed: campaign ? { subscribers: audience, seconds: +seedSeconds.toFixed(1) } : null,
      events: {
        offered: eventIndex,
        completedInWindow: eventsInWindow,
        completedTotal: events.filter(ok).length,
        failed: events.filter((r) => !ok(r)).length,
        ratePerSecond: +(eventsInWindow / (windowMs / 1000)).toFixed(2),
        acceptanceMs: stats(events.map((r) => r.done - r.deadline)),
      },
      campaign: campaign
        ? {
            deliveredInWindow: campaignMail.length,
            ratePerSecond: +campaignRate.toFixed(2),
            per10sMin: Math.min(...buckets) / 10,
            per10sMax: Math.max(...buckets) / 10,
            maxInAnyOneSecond: maxOneSecond,
            atWindowStart: startCampaign,
            atWindowEnd: endCampaign,
          }
        : null,
      tx: sequences
        ? {
            offered: txIndex,
            accepted: tx.filter(ok).length,
            failed: tx.filter((r) => !ok(r)).length,
            acceptanceMs: stats(tx.map((r) => r.done - r.deadline)),
            delivered: tx.filter((r) => txMail.has(r.to)).length,
            deliveryMs: stats(
              tx
                .filter((r) => txMail.has(r.to))
                .map((r) => txMail.get(r.to)!.accepted - r.deadline),
            ),
          }
        : null,
      sequences: sequences
        ? {
            signupEvents: Math.ceil(eventIndex / 10),
            sendsDeliveredInWindow: sequenceMail.length,
            enrollmentsAtWindowEnd: endEnrollments,
          }
        : null,
      outbox: { atWindowStart: startQueue, atWindowEnd: endQueue },
      client: { shed, inFlightPeak, inFlightAtWindowEnd: inFlightAtEnd },
      serverRssPeakMiB: rssPeak,
      memAvailableMinMiB: memLow,
      serverErrorLines: errors,
      serverErrorsSample: app.stderr.slice(0, 2000),
      targets: {
        campaignAtLeast50PerSecond: campaign ? campaignRate >= 50 : null,
        events100PerSecondNoShed: eventsInWindow >= eventIndex - 5 && shed === 0,
      },
      samples,
    };
    record(result, true);
    if (campaign) await api(`/api/campaigns/${campaignId}/status`, "PUT", { status: "cancelled" });
  } finally {
    reader?.close();
    await app?.stop();
    await sink.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const scenarios = process.argv.slice(2);
for (const name of scenarios.length ? scenarios : ["events", "baseline", "mixed"])
  await run(name as "events" | "baseline" | "mixed");
