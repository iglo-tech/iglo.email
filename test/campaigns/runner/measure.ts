// M3.2 campaign runner acceptance against the compiled build (docs/perf/M3.2-runner.md);
// opt-in, not a CI threshold. `bun test/campaigns/runner/measure.ts limits|crash|mixed`
// after `bun run build`. Mail goes only to the loopback sink below; data directories are
// on disk under upstream/measurements (never tmpfs) and removed afterwards.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { provisionApiUser } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../../..");
const executable = join(repository, "dist/iglo.email");
const base = resolve(process.env.IGLO_EMAIL_PERF_DIR ?? join(repository, "upstream/measurements"));
mkdirSync(base, { recursive: true });
const fsType = Bun.spawnSync(["stat", "-f", "-c", "%T", base]).stdout.toString().trim();
if (/tmpfs|ramfs/.test(fsType)) throw new Error(`Refusing ${fsType} measurement directory`);
const results = join(repository, "docs/perf/M3.2-results.jsonl");
const fixtures = readFileSync(join(repository, "test/users/fixtures.md"), "utf8");
const admin = {
  user: /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixtures)![1]!,
  password: /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixtures)![1]!,
};
const free = () =>
  /Mem:\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/.exec(
    Bun.spawnSync(["free", "-m"]).stdout.toString(),
  )?.[1];

function record(entry: object) {
  appendFileSync(results, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  console.log(JSON.stringify(entry, null, 2));
}
function stats(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const round = (n: number) => +n.toFixed(2);
  return {
    n: values.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1)!),
  };
}

interface Delivery {
  to: string;
  /** MAIL FROM time and the accepting reply time (performance.now()). */
  mail: number;
  accepted: number;
}
/**
 * Loopback SMTP sink. Records accepted messages only. After `limit` acceptances it holds
 * every further final dot without replying, so those messages are never accepted.
 */
async function startSink() {
  const delivered: Delivery[] = [];
  const sockets = new Set<Socket>();
  let open = 0;
  let peak = 0;
  let limit = Infinity;
  let held = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("latin1");
    let buffer = "";
    let data = false;
    let current: { to: string; mail: number } | null = null;
    socket.write("220 sink.test ESMTP\r\n");
    socket.on("close", () => {
      if (current) open--;
      current = null;
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line !== ".") continue;
          data = false;
          if (delivered.length >= limit) {
            held++;
            continue;
          }
          delivered.push({ ...current!, accepted: performance.now() });
          current = null;
          open--;
          socket.write("250 queued\r\n");
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-sink.test\r\n250 8BITMIME\r\n");
        else if (verb === "MAIL") {
          current = { to: "", mail: performance.now() };
          peak = Math.max(peak, ++open);
          socket.write("250 ok\r\n");
        } else if (verb === "RCPT") {
          current!.to = /<([^>]*)>/.exec(line)?.[1] ?? "";
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
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sink address");
  return {
    port: address.port,
    delivered,
    get peak() {
      return peak;
    },
    get held() {
      return held;
    },
    hold(after: number) {
      limit = after;
      held = 0;
    },
    release() {
      limit = Infinity;
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
type Sink = Awaited<ReturnType<typeof startSink>>;

async function availablePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

/** One compiled server over a data directory; it can be killed and restarted. */
async function server(directory: string) {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let stderr = "";
  const start = async () => {
    child = spawn(
      executable,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-dir",
        join(directory, "data"),
      ],
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
      if (stderr.length < 4_000_000) stderr += chunk.toString();
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
      try {
        if ((await fetch(`${origin}/health`)).status === 200) return;
      } catch {
        /* not ready */
      }
      await Bun.sleep(25);
    }
    throw new Error("server readiness timed out");
  };
  const exited = () =>
    new Promise<void>((done) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) done();
      else child.once("exit", () => done());
    });
  await start();
  return {
    origin,
    start,
    get stderr() {
      return stderr;
    },
    async kill() {
      const done = exited();
      child?.kill("SIGKILL");
      await done;
    },
    async stop() {
      const done = exited();
      child?.kill("SIGTERM");
      await done;
    },
    pid: () => child?.pid,
  };
}

async function client(origin: string, sinkPort: number, settings: Record<string, unknown>) {
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
  return { api, authorization };
}
type Api = Awaited<ReturnType<typeof client>>["api"];

/** Creates `count` subscribers in `lists`, `parallel` requests at a time. */
async function seed(
  api: Api,
  prefix: string,
  count: number,
  lists: number[],
  extra: object = { preconfirm_subscriptions: true },
  parallel = 8,
) {
  const ids: number[] = Array.from({ length: count }, () => 0);
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < count) {
        const i = next++;
        const r = await api("/api/subscribers", "POST", {
          email: `${prefix}${String(i).padStart(5, "0")}@example.test`,
          name: `Subscriber ${i}`,
          lists,
          ...extra,
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        ids[i] = r.body.data.id;
      }
    }),
  );
  return ids;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const campaignOf = async (api: Api, id: number) => (await api(`/api/campaigns/${id}`)).body.data;

async function withRun<T>(name: string, run: (directory: string, sink: Sink) => Promise<T>) {
  const directory = mkdtempSync(join(base, `m32-${name}-`));
  const sink = await startSink();
  try {
    return await run(directory, sink);
  } finally {
    await sink.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 10,000 subscribers: rate, sliding window and concurrency, and exactly one message each. */
async function limits() {
  const concurrency = 5,
    rate = 10,
    windowRate = 2500,
    windowMs = 60_000;
  await withRun("limits", async (directory, sink) => {
    const before = free();
    const app = await server(directory);
    try {
      const { api } = await client(app.origin, sink.port, {
        "app.concurrency": concurrency,
        "app.message_rate": rate,
        "app.batch_size": 1000,
        "app.message_sliding_window": true,
        "app.message_sliding_window_duration": "1m",
        "app.message_sliding_window_rate": windowRate,
      });
      const single = (await api("/api/lists", "POST", { name: "single", type: "public" })).body.data
        .id;
      const double = (
        await api("/api/lists", "POST", { name: "double", type: "public", optin: "double" })
      ).body.data.id;
      const seeding = performance.now();
      await seed(api, "s", 9_000, [single]);
      await seed(api, "both", 1_000, [single, double]);
      // Ineligible: unconfirmed on double opt-in, unsubscribed, blocklisted.
      await seed(api, "unconfirmed", 20, [double], { preconfirm_subscriptions: false });
      const unsubscribed = await seed(api, "unsub", 20, [single]);
      const r = await api("/api/subscribers/lists", "PUT", {
        ids: unsubscribed,
        action: "unsubscribe",
        target_list_ids: [single],
      });
      assert.equal(r.status, 200);
      await seed(api, "blocked", 20, [single], { status: "blocklisted" });
      const seedSeconds = (performance.now() - seeding) / 1000;
      const created = await api("/api/campaigns", "POST", {
        name: "limits",
        subject: "Hello {{ subscriber.name }}",
        lists: [single, double],
        content_type: "html",
        body: '<p>Hi {{ subscriber.name }}</p><a href="{{ "https://example.test/a" | track_link }}">a</a>',
      });
      const id = created.body.data.id;
      const started = performance.now();
      assert.equal(
        (await api(`/api/campaigns/${id}/status`, "PUT", { status: "running" })).status,
        200,
      );
      await waitFor(
        async () => (await campaignOf(api, id)).status === "finished",
        900_000,
        "finish",
      );
      const elapsed = (performance.now() - started) / 1000;
      const c = await campaignOf(api, id);
      const to = sink.delivered.map((d) => d.to);
      const unique = new Set(to);
      const eligible = to.every((t) => /^(s|both)\d{5}@/.test(t));
      const mails = sink.delivered.map((d) => d.mail).sort((a, b) => a - b);
      let perSecond = 0;
      for (let i = 0, j = 0; i < mails.length; i++) {
        while (mails[j]! < mails[i]! - 1000 + 1e-9) j++;
        perSecond = Math.max(perSecond, i - j + 1);
      }
      // Windows anchored at the first message after each window, as the runner counts them.
      const windows: number[] = [];
      for (let i = 0; i < mails.length;) {
        const startAt = mails[i]!;
        let n = 0;
        while (i < mails.length && mails[i]! < startAt + windowMs) {
          n++;
          i++;
        }
        windows.push(n);
      }
      const seconds = new Map<number, number>();
      for (const m of mails) {
        const s = Math.floor((m - mails[0]!) / 1000);
        seconds.set(s, (seconds.get(s) ?? 0) + 1);
      }
      const entry = {
        scenario: "limits-10k",
        settings: { concurrency, rate, windowRate, window: "1m", batch: 1000 },
        seedSeconds: +seedSeconds.toFixed(1),
        eligible: 10_000,
        delivered: to.length,
        unique: unique.size,
        onlyEligible: eligible,
        campaign: { status: c.status, sent: c.sent, to_send: c.to_send },
        elapsedSeconds: +elapsed.toFixed(1),
        maxPerAnyOneSecond: perSecond,
        configuredPerSecond: concurrency * rate,
        windows,
        maxConcurrentTransactions: sink.peak,
        busiestSeconds: [...seconds.values()].sort((a, b) => b - a).slice(0, 5),
        loggedErrors: app.stderr.trim() ? app.stderr.trim().split("\n").length : 0,
        freeMiB: { before, after: free() },
      };
      record(entry);
      assert.equal(to.length, 10_000);
      assert.equal(unique.size, 10_000);
      assert.ok(eligible);
      assert.equal(c.sent, 10_000);
      assert.ok(perSecond <= concurrency * rate, `per second ${perSecond}`);
      assert.ok(
        windows.every((n) => n <= windowRate),
        `windows ${windows}`,
      );
      assert.ok(sink.peak <= concurrency, `concurrency ${sink.peak}`);
    } finally {
      await app.stop();
    }
  });
}

/**
 * Kill the compiled process at a point in a campaign of 600 (batches of 100), restart it, and
 * show no duplicates, at most one skipped batch and the skipped range in the log.
 */
async function crash(point: "after-commit" | "mid-batch" | "batch-end" | "unheld") {
  const batch = 100,
    total = 600;
  await withRun(`crash-${point}`, async (directory, sink) => {
    const app = await server(directory);
    try {
      const { api } = await client(app.origin, sink.port, {
        "app.concurrency": 2,
        "app.message_rate": 1000,
        "app.batch_size": batch,
        "app.message_sliding_window": false,
      });
      const list = (await api("/api/lists", "POST", { name: "crash", type: "public" })).body.data
        .id;
      // Sequential, so subscriber IDs ascend with the index and batches are index ranges.
      const ids = await seed(api, "c", total, [list], { preconfirm_subscriptions: true }, 1);
      const byEmail = new Map(
        ids.map((id, i) => [`c${String(i).padStart(5, "0")}@example.test`, id]),
      );
      const id = (
        await api("/api/campaigns", "POST", { name: "crash", subject: "s", lists: [list] })
      ).body.data.id;
      // Hold acceptance: at the start of batch 3, inside it, or on its last message.
      const holdAfter = {
        "after-commit": 200,
        "mid-batch": 250,
        "batch-end": 299,
        unheld: Infinity,
      }[point];
      sink.hold(holdAfter);
      assert.equal(
        (await api(`/api/campaigns/${id}/status`, "PUT", { status: "running" })).status,
        200,
      );
      if (point === "unheld")
        await waitFor(() => sink.delivered.length >= 420, 120_000, "420 deliveries");
      else await waitFor(() => sink.held > 0, 120_000, "a held message");
      const reader = new Database(join(directory, "data/iglo-email.db"), { readonly: true });
      const cursorAtKill = (
        reader.query("SELECT last_subscriber_id AS c FROM campaigns WHERE id = ?").get(id) as {
          c: number;
        }
      ).c;
      reader.close();
      await app.kill();
      const deliveredAtKill = sink.delivered.length;
      sink.release();
      const restarted = performance.now();
      await app.start();
      await waitFor(
        async () => (await campaignOf(api, id)).status === "finished",
        180_000,
        "finish",
      );
      const resumeSeconds = (performance.now() - restarted) / 1000;
      const received = sink.delivered.map((d) => byEmail.get(d.to)!);
      const unique = new Set(received);
      const missing = ids.filter((s) => !unique.has(s)).sort((a, b) => a - b);
      const logged = /campaign \d+ \(crash\): (\d+) subscribers with IDs (\d+)-(\d+)/.exec(
        app.stderr,
      );
      const entry = {
        scenario: `crash-${point}`,
        batch,
        total,
        heldAtKill: sink.held,
        deliveredAtKill,
        cursorAtKill,
        delivered: received.length,
        unique: unique.size,
        duplicates: received.length - unique.size,
        missing: missing.length,
        missingRange: missing.length ? [missing[0], missing.at(-1)] : null,
        loggedRange: logged ? { count: +logged[1]!, first: +logged[2]!, last: +logged[3]! } : null,
        resumeSeconds: +resumeSeconds.toFixed(1),
        campaign: (({ status, sent, to_send }) => ({ status, sent, to_send }))(
          await campaignOf(api, id),
        ),
      };
      record(entry);
      assert.equal(entry.duplicates, 0);
      assert.ok(missing.length <= batch, "more than one batch skipped");
      if (missing.length) {
        assert.ok(logged, "skipped range not logged");
        assert.ok(+logged[2]! <= missing[0]! && missing.at(-1)! <= +logged[3]!);
        assert.ok(+logged[1]! <= batch);
      }
      // Batch 3 (indexes 200-299) was committed before any of it was sent.
      if (point !== "unheld") assert.ok(cursorAtKill >= ids[299]!, "cursor committed first");
    } finally {
      await app.stop();
    }
  });
}

/** D22: campaign sending at 50/s while 100 events/s arrive through the real API. */
async function mixed(name: "events" | "campaign" | "mixed") {
  const windowMs = Number(process.env.M32_WINDOW_MS ?? 60_000);
  const events = name !== "campaign",
    campaign = name !== "events";
  await withRun(`mixed-${name}`, async (directory, sink) => {
    const app = await server(directory);
    try {
      const { api, authorization } = await client(app.origin, sink.port, {
        "app.concurrency": 5,
        "app.message_rate": 10,
        "app.batch_size": 1000,
        "app.message_sliding_window": false,
      });
      let id = 0;
      if (campaign) {
        const list = (await api("/api/lists", "POST", { name: "mixed", type: "public" })).body.data
          .id;
        await seed(api, "m", Math.ceil((windowMs / 1000) * 50 * 1.3), [list]);
        id = (
          await api("/api/campaigns", "POST", {
            name: "mixed",
            subject: "Hello {{ subscriber.name }}",
            lists: [list],
            body: "<p>Hi {{ subscriber.name }}</p>",
          })
        ).body.data.id;
      }
      for (let i = 0; i < 20; i++)
        await api("/api/subscriber-events", "POST", {
          subscriber: { email: `warm${i}@example.test` },
          name: "warmup",
        });
      if (campaign) {
        await api(`/api/campaigns/${id}/status`, "PUT", { status: "running" });
        // Start the window once the runner is sending.
        await waitFor(() => sink.delivered.length > 0, 30_000, "first campaign message");
      }
      const results: { deadline: number; done: number; status: number }[] = [];
      let inFlight = 0,
        peak = 0,
        shed = 0;
      const pending = new Set<Promise<void>>();
      const start = performance.now() + 50;
      const end = start + windowMs;
      const deliveredBefore = sink.delivered.length;
      const samples: object[] = [];
      let nextSample = start;
      for (let i = 0; events && i * 10 < windowMs;) {
        const now = performance.now();
        if (now >= nextSample) {
          samples.push({
            t: Math.round(now - start),
            inFlight,
            mail: sink.delivered.length - deliveredBefore,
          });
          nextSample += 1000;
        }
        while (i * 10 < windowMs && start + i * 10 <= now) {
          const deadline = start + i * 10;
          const n = i++;
          if (inFlight >= 500) {
            shed++;
            continue;
          }
          inFlight++;
          peak = Math.max(peak, inFlight);
          const p = fetch(`${app.origin}/api/subscriber-events`, {
            method: "POST",
            headers: { authorization, "content-type": "application/json" },
            body: JSON.stringify({
              subscriber: {
                external_id: `u${n % 2000}`,
                email: `ev${n % 2000}@example.test`,
                attribs: { n, plan: n % 3 ? "trial" : "paid" },
              },
              name: "order_paid",
              data: { order: n, amount: 79, currency: "USD" },
              idempotency_key: `evt-${n}`,
            }),
          })
            .then(async (r) => {
              await r.arrayBuffer();
              results.push({ deadline, done: performance.now(), status: r.status });
            })
            .catch(() => {
              results.push({ deadline, done: performance.now(), status: 0 });
            })
            .finally(() => {
              inFlight--;
              pending.delete(p);
            });
          pending.add(p);
        }
        await Bun.sleep(1);
      }
      if (!events) await Bun.sleep(Math.max(0, end - performance.now()));
      const inFlightAtEnd = inFlight;
      const mailInWindow = sink.delivered.filter((d) => d.accepted >= start && d.accepted < end);
      const campaignAtEnd = campaign ? await campaignOf(api, id) : null;
      await Promise.all(pending);
      const inWindow = results.filter((r) => r.done < end && r.status === 200).length;
      const mails = mailInWindow.map((d) => d.mail).sort((a, b) => a - b);
      let perSecond = 0;
      for (let i = 0, j = 0; i < mails.length; i++) {
        while (mails[j]! < mails[i]! - 1000) j++;
        perSecond = Math.max(perSecond, i - j + 1);
      }
      record({
        scenario: `d22-${name}`,
        windowMs,
        events: events
          ? {
              offered: Math.ceil(windowMs / 10),
              completedInWindow: inWindow,
              completedTotal: results.filter((r) => r.status === 200).length,
              failed: results.filter((r) => r.status !== 200).length,
              shed,
              inFlightPeak: peak,
              inFlightAtWindowEnd: inFlightAtEnd,
              acceptanceMs: stats(results.map((r) => r.done - r.deadline)),
            }
          : null,
        campaign: campaign
          ? {
              offeredRatePerSecond: 50,
              deliveredInWindow: mailInWindow.length,
              ratePerSecond: +((mailInWindow.length / windowMs) * 1000).toFixed(2),
              maxPerAnyOneSecond: perSecond,
              backlogAtWindowEnd: campaignAtEnd
                ? { to_send: campaignAtEnd.to_send, sent: campaignAtEnd.sent }
                : null,
            }
          : null,
        samples,
        freeMiB: free(),
      });
      if (campaign) await api(`/api/campaigns/${id}/status`, "PUT", { status: "cancelled" });
    } finally {
      await app.stop();
    }
  });
}

const mode = process.argv[2] ?? "all";
if (mode === "limits" || mode === "all") await limits();
if (mode === "crash" || mode === "all")
  for (const point of ["after-commit", "mid-batch", "batch-end", "unheld"] as const)
    await crash(point);
if (mode === "mixed" || mode === "all")
  for (const name of ["events", "campaign", "mixed"] as const) await mixed(name);
