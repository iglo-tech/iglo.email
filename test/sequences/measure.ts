// Event ingest with active sequences for docs/perf/M5.3-sequences.md; opt-in, not a CI
// threshold. Real HTTP against the compiled build: open-loop events at fixed 10 ms deadlines
// (100/s), alternating `signup` and `order_paid` per subscriber, with no sequences
// (baseline) or 20 active sequences: 10 triggered by `order_paid` (5 with a data filter,
// all `reentry: always`, so every trigger also replaces) and 10 triggered by `signup` that
// exit on `order_paid`. Usage: bun test/sequences/measure.ts [baseline|sequences|all].
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../..");
const WINDOW_MS = Number(process.env.SEQUENCES_MEASURE_WINDOW_MS ?? 60_000);
const EVENT_MS = 10;
const MAX_IN_FLIGHT = 500;
const SUBSCRIBERS = 2000;
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

async function run(name: string, sequences: boolean) {
  const text = readFileSync(join(repository, "test/users/fixtures.md"), "utf8");
  const admin = {
    user: /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(text)![1]!,
    password: /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(text)![1]!,
  };
  return await withProduction(
    join(repository, "dist/iglo.email"),
    new AbortController().signal,
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
      if (sequences) {
        const template = (
          await api("/api/templates", "POST", {
            name: "measure",
            type: "tx",
            subject: "Measure",
            body: "<p>{{ subscriber.name }}</p>",
          })
        ).body.data.id as number;
        const steps = [
          { wait: "P1D", kind: "transactional", template_id: template },
          { wait: "P3D", kind: "transactional", template_id: template },
        ];
        for (let i = 0; i < 10; i++) {
          const triggering = await api("/api/sequences", "POST", {
            name: `trigger ${i}`,
            status: "active",
            trigger: {
              event: "order_paid",
              ...(i % 2 ? { where: { "data.currency": "USD" } } : {}),
            },
            reentry: "always",
            steps,
          });
          const exiting = await api("/api/sequences", "POST", {
            name: `exit ${i}`,
            status: "active",
            trigger: { event: "signup" },
            exit_on: ["order_paid"],
            reentry: "always",
            steps,
          });
          if (triggering.status !== 200 || exiting.status !== 200)
            throw new Error("sequence setup failed");
        }
      }
      for (let i = 0; i < 20; i++)
        await api("/api/subscriber-events", "POST", {
          subscriber: { email: `warm${i}@example.test` },
          name: "warmup",
        });
      const reader = new Database(join(dataDir, "iglo-email.db"), { readonly: true });
      const sample = () => ({
        events: (reader.query("SELECT count(*) AS n FROM events").get() as { n: number }).n,
        enrollments: Object.fromEntries(
          (
            reader.query("SELECT status, count(*) AS n FROM enrollments GROUP BY status").all() as {
              status: string;
              n: number;
            }[]
          ).map((row) => [row.status, row.n]),
        ),
      });
      const results: {
        deadline: number;
        sent: number;
        done: number;
        status: number;
        started: number;
        ended: number;
      }[] = [];
      let inFlight = 0,
        inFlightPeak = 0,
        shed = 0;
      const pending = new Set<Promise<void>>();
      const samples: object[] = [];
      const rssStart = serverRss(executable);
      const start = performance.now() + 50;
      const end = start + WINDOW_MS;
      const offered = Math.ceil(WINDOW_MS / EVENT_MS);
      let cursor = 0,
        nextSample = start;
      while (cursor < offered || performance.now() < end) {
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
        while (cursor < offered && start + cursor * EVENT_MS <= now) {
          const i = cursor++;
          const deadline = start + i * EVENT_MS;
          if (inFlight >= MAX_IN_FLIGHT) {
            shed++;
            continue;
          }
          inFlight++;
          inFlightPeak = Math.max(inFlightPeak, inFlight);
          const s = i % SUBSCRIBERS;
          const p = (async () => {
            const sent = performance.now();
            const response = await fetch(`${baseUrl}/api/subscriber-events`, {
              method: "POST",
              headers: { authorization, "content-type": "application/json" },
              body: JSON.stringify({
                subscriber: {
                  external_id: `u${s}`,
                  email: `ev${s}@example.test`,
                  attribs: { n: i, plan: i % 3 ? "trial" : "paid" },
                },
                // Each subscriber alternates signup and order_paid on successive rounds.
                name: Math.floor(i / SUBSCRIBERS) % 2 ? "order_paid" : "signup",
                data: { order: i, amount: 79, currency: "USD" },
                idempotency_key: `evt-${i}`,
              }),
            });
            const body = (await response.json()) as {
              data?: { enrollments: { started: unknown[]; ended: unknown[] } };
            };
            results.push({
              deadline,
              sent,
              done: performance.now(),
              status: response.status,
              started: body.data?.enrollments.started.length ?? 0,
              ended: body.data?.enrollments.ended.length ?? 0,
            });
          })().finally(() => {
            inFlight--;
            pending.delete(p);
          });
          pending.add(p);
        }
        const next = Math.min(start + cursor * EVENT_MS, nextSample, end);
        await Bun.sleep(Math.ceil(Math.max(0, next - performance.now())));
      }
      const atWindowEnd = { done: results.filter((r) => r.done <= end).length, inFlight };
      await Promise.all(pending);
      const final = sample();
      reader.close();
      return {
        name,
        windowMs: WINDOW_MS,
        offered,
        shed,
        completed: results.length,
        statuses: [...new Set(results.map((r) => r.status))],
        atWindowEnd,
        drainAfterWindowMs: +Math.max(0, Math.max(...results.map((r) => r.done)) - end).toFixed(2),
        started: results.reduce((n, r) => n + r.started, 0),
        ended: results.reduce((n, r) => n + r.ended, 0),
        acceptanceMs: stats(results.map((r) => r.done - r.deadline)),
        commitMs: stats(results.map((r) => r.done - r.sent)),
        inFlightPeak,
        final,
        serverRssMiB: {
          start: rssStart,
          peak: Math.max(...samples.map((s) => (s as { rss: number | null }).rss ?? 0)),
          end: serverRss(executable),
        },
      };
    },
    admin,
    WINDOW_MS + 300_000,
  );
}

const results: Record<string, unknown> = {
  date: new Date().toISOString(),
  bun: Bun.version,
  dataFs: fsType,
  freeBefore: free(),
};
if (scenario === "all" || scenario === "baseline") results.baseline = await run("baseline", false);
if (scenario === "all" || scenario === "sequences")
  results.sequences = await run("sequences", true);
results.freeAfter = free();
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
