// B7 measurement: (1) WAL size under continuous report polling with and without the forced gap,
// (2) parent memory with many unread near-cap downloads with and without the egress budget.
// Usage: bun test/analytics/measure-budget.ts wal|egress. Prints JSON lines. Not a CI threshold.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnalyticsReader, ReaderError } from "@/analytics/reader";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";

const report = (values: object) => process.stdout.write(`${JSON.stringify(values)}\n`);
const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;

async function wal(gapAfterMs: number, label: string, seconds: number, checkpoint: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "iglo-wal-"));
  const db = openDatabase(directory);
  try {
    runMigrations(db, directory, createRealClock(), productionMigrations);
    db.run("PRAGMA synchronous = OFF");
    db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
      INSERT INTO campaigns (id, uuid, name, subject, from_email, body, messenger)
      SELECT i, 'c-' || i, 'C', 's', 'a@example.test', 'b', 'email' FROM n`);
    db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400000)
      INSERT INTO campaign_views (campaign_id, created_at)
      SELECT 1 + i % 20, strftime('%Y-%m-%dT%H:%M:%fZ', 1.7e9 + i, 'unixepoch') FROM n`);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.run("PRAGMA synchronous = FULL");
    const reader = createAnalyticsReader({
      path: db.filename,
      gapAfterMs,
      ...(checkpoint ? { onGap: () => void db.run("PRAGMA wal_checkpoint(PASSIVE)") } : {}),
      command: [process.execPath, join(import.meta.dir, "hold-child.ts")],
    });
    const insert = db.prepare(
      "INSERT INTO campaign_views (campaign_id, created_at) VALUES (1, '2026-10-30T00:00:00.000Z')",
    );
    let running = true;
    let reads = 0;
    // Three staggered pollers on two slots, each read holding its snapshot for 1.5 s: the running
    // snapshots overlap continuously, as under a dashboard that never stops polling.
    const pollers = [0, 750, 1500].map(async (offset) => {
      await Bun.sleep(offset);
      while (running) {
        await reader.read("dashboardCounts", []).catch(() => {});
        reads++;
      }
    });
    const walPath = `${db.filename}-wal`;
    let peak = 0;
    const samples: number[] = [];
    const end = performance.now() + seconds * 1000;
    let second = 0;
    while (performance.now() < end) {
      for (let i = 0; i < 50; i++) insert.run(); // 50 commits per second, autocheckpoint on
      await Bun.sleep(1000 - 0);
      let size = 0;
      try {
        size = statSync(walPath).size;
      } catch {
        /* no WAL file */
      }
      peak = Math.max(peak, size);
      if (++second % 5 === 0) samples.push(mb(size));
    }
    running = false;
    await Promise.all(pollers);
    await reader.close();
    report({
      name: `wal ${label}`,
      seconds,
      reads,
      peakWalMB: mb(peak),
      everyFiveSecondsMB: samples,
    });
  } finally {
    db.close(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function egress(budgeted: boolean, clients: number, bodyBytes: number) {
  const reader = createAnalyticsReader({
    path: "x",
    command: ["head", "-c", String(bodyBytes), "/dev/zero"],
    egressBytes: 64 * 1024 * 1024,
  });
  let served = 0;
  let refused = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      try {
        const response = budgeted
          ? await reader.respond("dashboardCounts", [])
          : new Response(await reader.read("dashboardCounts", []));
        served++;
        return response;
      } catch (error) {
        if (error instanceof ReaderError) {
          refused++;
          return new Response("busy", { status: 503 });
        }
        throw error;
      }
    },
  });
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
  // Clients send a request and never read: the kernel buffers fill and the server keeps the rest.
  const sockets = Array.from({ length: clients }, () => {
    const socket = createConnection(server.port!, "127.0.0.1");
    socket.pause();
    socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
    return socket;
  });
  const deadline = performance.now() + 60_000;
  while (served + refused < clients && performance.now() < deadline) await Bun.sleep(50);
  await Bun.sleep(1000);
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  report({
    name: `egress ${budgeted ? "budget 64 MiB" : "no budget"}`,
    clients,
    bodyMB: mb(bodyBytes),
    served,
    refused,
    rssBeforeMB: mb(before),
    rssPeakMB: mb(peak),
  });
  for (const socket of sockets) socket.destroy();
  server.stop(true);
  await reader.close();
}

const mode = process.argv[2];
if (mode === "wal") {
  const seconds = Number(process.argv[3] ?? 60);
  await wal(Number.POSITIVE_INFINITY, "no forced gap (before)", seconds, false);
  await wal(15_000, "forced gap after 15 s (after)", seconds, true);
} else if (mode === "egress") {
  await egress(false, 40, 20_000_000);
  await egress(true, 40, 20_000_000);
} else throw new Error("usage: measure-budget.ts wal|egress");
