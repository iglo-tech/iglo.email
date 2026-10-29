// D22 events-API measurement for docs/perf/M5.1-events.md; opt-in, not a CI threshold.
// Real HTTP against the compiled build: open-loop events at fixed 10 ms deadlines, alongside
// synthetic async transactional and marketing POST /api/tx load delivered by the outbox to a
// loopback SMTP sink. Campaigns do not exist until M3, so no campaign runner is exercised.
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../..");
const WINDOW_MS = Number(process.env.EVENTS_MEASURE_WINDOW_MS ?? 60_000);
const EVENT_MS = 10; // 100 events/s
// Send load in messages/s (default 50): four fifths transactional, one fifth marketing.
const SEND_RATE = Number(process.env.EVENTS_MEASURE_SEND_RATE ?? 50);
const TX_MS = 1000 / ((SEND_RATE * 4) / 5);
const MARKETING_MS = 1000 / (SEND_RATE / 5);
const MAX_IN_FLIGHT = 500;
const scenario = process.argv[2] ?? "all";

// Durable storage for the data directory: never tmpfs/ramfs.
const base = resolve(process.env.IGLO_EMAIL_PERF_DIR ?? join(repository, "upstream/measurements"));
mkdirSync(base, { recursive: true });
const fsType = Bun.spawnSync(["stat", "-f", "-c", "%T", base]).stdout.toString().trim();
if (/tmpfs|ramfs/.test(fsType)) throw new Error(`Refusing ${fsType} measurement directory`);
process.env.TMPDIR = base;
const free = () => Bun.spawnSync(["free", "-m"]).stdout.toString().trim();

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

/** Counting loopback SMTP sink: records the receive time of each subject, keeps no bodies. */
async function sink() {
  const received = new Map<string, number>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("latin1");
    let buffer = "",
      data = false,
      subject = "";
    socket.write("220 sink.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line === ".") {
            data = false;
            received.set(subject, performance.now());
            subject = "";
            socket.write("250 queued\r\n");
          } else if (!subject && line.startsWith("Subject: ")) subject = line.slice(9);
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-sink.test\r\n250 8BITMIME\r\n");
        else if (verb === "DATA") {
          data = true;
          socket.write("354 go\r\n");
        } else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sink address");
  return {
    port: address.port,
    received,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** Resident memory of the compiled process, found by its executable path. */
function serverRss(executable: string): number | null {
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (readlinkSync(`/proc/${pid}/exe`) !== executable) continue;
      const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
      return kb ? Math.round(Number(kb) / 1024) : null;
    } catch {
      /* process gone or not ours */
    }
  }
  return null;
}

async function run(name: string, events: boolean, sends: boolean) {
  const text = readFileSync(join(repository, "test/users/fixtures.md"), "utf8");
  const admin = {
    user: /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(text)![1]!,
    password: /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(text)![1]!,
  };
  const smtp = await sink();
  const controller = new AbortController();
  try {
    return await withProduction(
      join(repository, "dist/iglo.email"),
      controller.signal,
      async (baseUrl, _signal, _restart, dataDir) => {
        const executable = join(dirname(dataDir), "iglo.email");
        const credentials = await provisionApiUser(baseUrl, admin);
        const authorization = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
        const api = async (path: string, method: string, body: unknown) => {
          const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: { authorization, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const text = await response.text();
          return { status: response.status, body: text ? JSON.parse(text) : null };
        };
        const settings = await fetch(`${baseUrl}/api/settings`, { headers: { authorization } });
        const current = (await settings.json()) as { data: { smtp: object[] } };
        const configured = await api("/api/settings/smtp", "PUT", [
          {
            ...current.data.smtp[0],
            enabled: true,
            host: "127.0.0.1",
            port: smtp.port,
            auth_protocol: "none",
            username: "",
            password: "",
            tls_type: "none",
            email_headers: [],
          },
        ]);
        if (configured.status !== 200) throw new Error("smtp settings");
        const template = (
          await api("/api/templates", "POST", {
            name: "measure",
            type: "tx",
            subject: "{{ data.s }}",
            body: "<p>Order {{ data.s }} for {{ subscriber.name }}</p>",
          })
        ).body.data.id as number;
        const marketingCount = Math.ceil(WINDOW_MS / MARKETING_MS);
        let list = 0;
        const recipients: number[] = [];
        if (sends) {
          list = (await api("/api/lists", "POST", { name: "measure", type: "public" })).body.data
            .id as number;
          // The 7-day frequency cap admits one marketing send per subscriber.
          for (let i = 0; i < marketingCount; i++)
            recipients.push(
              (
                await api("/api/subscribers", "POST", {
                  email: `mk${i}@example.test`,
                  name: `Marketing ${i}`,
                  lists: [list],
                  preconfirm_subscriptions: true,
                })
              ).body.data.id as number,
            );
        }
        // Warm the connection pool and code paths outside the window.
        for (let i = 0; i < 20; i++)
          await api("/api/subscriber-events", "POST", {
            subscriber: { email: `warm${i}@example.test` },
            name: "warmup",
          });
        const reader = new Database(join(dataDir, "iglo-email.db"), { readonly: true });
        const sample = () => {
          const statuses = Object.fromEntries(
            (
              reader.query("SELECT status, count(*) AS n FROM sends GROUP BY status").all() as {
                status: string;
                n: number;
              }[]
            ).map((row) => [row.status, row.n]),
          );
          const stored = (reader.query("SELECT count(*) AS n FROM events").get() as { n: number })
            .n;
          return { statuses, stored };
        };

        const eventResults: { deadline: number; sent: number; done: number; status: number }[] = [];
        const txResults: {
          subject: string;
          deadline: number;
          sent: number;
          done: number;
          status: number;
        }[] = [];
        let inFlight = 0,
          inFlightPeak = 0,
          shed = 0;
        const pending = new Set<Promise<void>>();
        const fire = (work: () => Promise<void>) => {
          if (inFlight >= MAX_IN_FLIGHT) {
            shed++;
            return;
          }
          inFlight++;
          inFlightPeak = Math.max(inFlightPeak, inFlight);
          const p = work().finally(() => {
            inFlight--;
            pending.delete(p);
          });
          pending.add(p);
        };
        const post = async (path: string, body: unknown) => {
          const response = await fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { authorization, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          await response.arrayBuffer();
          return response.status;
        };
        const samples: object[] = [];
        const rssStart = serverRss(executable);
        const start = performance.now() + 50;
        const end = start + WINDOW_MS;
        const plan: { at: number; kind: "event" | "tx" | "marketing"; i: number }[] = [];
        if (events)
          for (let i = 0; i * EVENT_MS < WINDOW_MS; i++)
            plan.push({ at: start + i * EVENT_MS, kind: "event", i });
        if (sends) {
          for (let i = 0; i * TX_MS < WINDOW_MS; i++)
            plan.push({ at: start + i * TX_MS, kind: "tx", i });
          for (let i = 0; i < marketingCount; i++)
            plan.push({ at: start + i * MARKETING_MS + 5, kind: "marketing", i });
        }
        plan.sort((a, b) => a.at - b.at);
        let nextSample = start;
        const wakeDelays: number[] = [];
        let cursor = 0;
        while (cursor < plan.length || performance.now() < end) {
          const now = performance.now();
          if (now >= nextSample) {
            samples.push({
              t: Math.round(now - start),
              inFlight,
              rss: serverRss(executable),
              ...sample(),
            });
            nextSample += 1000;
          }
          while (cursor < plan.length && plan[cursor]!.at <= now) {
            const item = plan[cursor++]!;
            const deadline = item.at;
            if (item.kind === "event")
              fire(async () => {
                const sent = performance.now();
                const status = await post("/api/subscriber-events", {
                  subscriber: {
                    external_id: `u${item.i % 2000}`,
                    email: `ev${item.i % 2000}@example.test`,
                    attribs: { n: item.i, plan: item.i % 3 ? "trial" : "paid" },
                  },
                  name: "order_paid",
                  data: { order: item.i, amount: 79, currency: "USD" },
                  idempotency_key: `evt-${item.i}`,
                });
                eventResults.push({ deadline, sent, done: performance.now(), status });
              });
            else
              fire(async () => {
                const subject = `${item.kind}-${item.i}`;
                const sent = performance.now();
                const status = await post(
                  "/api/tx",
                  item.kind === "tx"
                    ? {
                        subscriber_mode: "external",
                        subscriber_emails: [`tx${item.i}@example.test`],
                        template_id: template,
                        data: { s: subject },
                        async: true,
                      }
                    : {
                        subscriber_id: recipients[item.i],
                        template_id: template,
                        kind: "marketing",
                        list_id: list,
                        data: { s: subject },
                        async: true,
                      },
                );
                txResults.push({ subject, deadline, sent, done: performance.now(), status });
              });
          }
          const next = Math.min(plan[cursor]?.at ?? end, nextSample, end);
          // Whole milliseconds, so the driver never spins on sub-millisecond timers.
          const wait = Math.ceil(Math.max(0, next - performance.now()));
          const before = performance.now();
          await Bun.sleep(wait);
          if (wait > 0) wakeDelays.push(performance.now() - before - wait);
        }
        const windowEnd = sample();
        const atWindow = {
          eventsDone: eventResults.filter((r) => r.done <= end).length,
          txDone: txResults.filter((r) => r.done <= end).length,
          delivered: [...smtp.received.values()].filter((t) => t <= end).length,
          inFlight,
          ...windowEnd,
        };
        await Promise.all(pending);
        const drainedRequests = performance.now();
        const expectedSends = txResults.filter((r) => r.status === 200).length;
        const deadline = performance.now() + 60_000;
        while (smtp.received.size < expectedSends && performance.now() < deadline)
          await Bun.sleep(10);
        const finished = performance.now();
        const final = sample();
        reader.close();
        const ok = eventResults.filter((r) => r.status === 200);
        const lastEvent = Math.max(0, ...eventResults.map((r) => r.done));
        const delivery = txResults
          .filter((r) => smtp.received.has(r.subject))
          .map((r) => smtp.received.get(r.subject)! - r.deadline);
        return {
          name,
          windowMs: WINDOW_MS,
          offered: {
            events: plan.filter((p) => p.kind === "event").length,
            tx: plan.filter((p) => p.kind === "tx").length,
            marketing: plan.filter((p) => p.kind === "marketing").length,
          },
          shed,
          completed: {
            events: eventResults.length,
            eventsOk: ok.length,
            eventStatuses: [...new Set(eventResults.map((r) => r.status))],
            tx: txResults.length,
            txStatuses: [...new Set(txResults.map((r) => r.status))],
            delivered: smtp.received.size,
          },
          atWindowEnd: atWindow,
          eventDrainAfterWindowMs: +Math.max(0, lastEvent - end).toFixed(2),
          requestDrainMs: +(drainedRequests - end).toFixed(2),
          deliveryDrainMs: +(finished - end).toFixed(2),
          eventAcceptanceMs: stats(eventResults.map((r) => r.done - r.deadline)),
          eventCommitMs: stats(eventResults.map((r) => r.done - r.sent)),
          eventClientLateMs: stats(eventResults.map((r) => r.sent - r.deadline)),
          txAcceptanceMs: stats(txResults.map((r) => r.done - r.deadline)),
          txCommitMs: stats(txResults.map((r) => r.done - r.sent)),
          deliveryLatencyMs: stats(delivery),
          driverWakeDelayMs: stats(wakeDelays),
          inFlightPeak,
          final,
          serverRssMiB: {
            start: rssStart,
            peak: Math.max(...samples.map((s) => (s as { rss: number | null }).rss ?? 0)),
            end: serverRss(executable),
          },
          samples,
        };
      },
      admin,
      WINDOW_MS + 600_000,
    );
  } finally {
    await smtp.close();
  }
}

const results: Record<string, unknown> = {
  date: new Date().toISOString(),
  bun: Bun.version,
  sendRate: SEND_RATE,
  dataFs: fsType,
  freeBefore: free(),
};
if (scenario === "all" || scenario === "sends") results.sendsOnly = await run("sends", false, true);
if (scenario === "all" || scenario === "events")
  results.eventsOnly = await run("events", true, false);
if (scenario === "all" || scenario === "mixed") results.mixed = await run("mixed", true, true);
results.freeAfter = free();
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
