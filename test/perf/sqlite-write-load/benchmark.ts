// Opt-in synthetic storage benchmark. It is not a production send or events API.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRealClock } from "@/clock";
import { SpikeStore } from "@/test/perf/sqlite-write-load/store";
import { runFtsIsolation } from "@/test/perf/sqlite-write-load/fts-isolation";
import { Workload, type Mode } from "@/test/perf/sqlite-write-load/workload";

const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (!["--control-only", "--smoke"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
const smoke = args.has("--smoke");
const durationMs = smoke ? 2000 : 60_000;
const repetitions = smoke ? 1 : 3;
const subscribers = smoke ? 1000 : 100_000;
const base = resolve(
  process.env.IGLO_EMAIL_PERF_DIR ?? join(import.meta.dir, "../../../upstream/measurements"),
);
mkdirSync(base, { recursive: true });
const directory = realpathSync(base);
const filesystemType = Number(statfsSync(directory).type);
if ([0x01021994, 0x858458f6].includes(filesystemType))
  throw new Error(
    "Storage measurements cannot use tmpfs/ramfs; set IGLO_EMAIL_PERF_DIR to disk-backed storage",
  );
function command(program: string, args: string[]) {
  const result = spawnSync(program, args, { encoding: "utf8" });
  return result.status === 0
    ? result.stdout.trim()
    : `unavailable: ${result.error?.message ?? result.stderr.trim()}`;
}
function summarize(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (fraction: number) =>
    Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!.toFixed(3));
  return { count: sorted.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: pick(1) };
}
const root = mkdtempSync(join(directory, "iglo-sqlite-spike-"));
try {
  console.log(
    JSON.stringify({
      kind: "environment",
      run: "comparison",
      directory,
      filesystemType: `0x${filesystemType.toString(16)}`,
      df: command("df", ["-T", directory]),
      mount: command("findmnt", ["-T", directory, "-o", "TARGET,SOURCE,FSTYPE,OPTIONS", "-n"]),
      bun: Bun.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      durationMs,
      repetitions,
      subscribers,
      smoke,
    }),
  );
  const modes: Mode[] = args.has("--control-only")
    ? ["record"]
    : ["record", "batch", "campaign-only"];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const mode of modes) {
      const runDir = join(root, `${mode}-${repetition}`);
      let store = new SpikeStore(runDir);
      const seedStarted = performance.now();
      store.seed(subscribers);
      const seedMs = performance.now() - seedStarted;
      const canary = subscribers + 500_000;
      store.mutate([
        { operation: "insert", id: canary, name: "Zebra original", email: "original@example.test" },
      ]);
      assert.deepEqual(store.search("zebra"), [canary]);
      store.mutate([
        { operation: "update", id: canary, name: "Otter changed", email: "changed@example.test" },
      ]);
      assert.deepEqual(store.search("zebra"), []);
      assert.deepEqual(store.search("otter"), [canary]);
      store.mutate([{ operation: "delete", id: canary }], true);
      assert.deepEqual(store.search("otter"), [canary]);
      store.mutate([{ operation: "delete", id: canary }]);
      store.mutate(
        [
          {
            operation: "insert",
            id: canary,
            name: "Rollback canary",
            email: "rollback@example.test",
          },
        ],
        true,
      );
      assert.deepEqual(store.search("rollback"), []);
      const sqlite = store.sqliteVersion();
      const clock = createRealClock();
      const workload = new Workload(store, clock, { mode, durationMs, subscribers });
      const measuredStart = performance.now();
      let next = workload.startedAt;
      while (clock.now().getTime() < workload.endAt) {
        workload.observeWake(next);
        const blockStarted = performance.now();
        workload.pump();
        workload.samples.pumpBlockMs.push(performance.now() - blockStarted);
        const now = clock.now().getTime();
        if (now >= workload.endAt) break;
        const regular =
          workload.startedAt + (Math.floor((now - workload.startedAt) / 100) + 1) * 100;
        const candidates = [
          regular,
          workload.endAt - 20,
          workload.endAt - 10,
          workload.endAt,
        ].filter((deadline) => deadline > now);
        next = Math.min(...candidates);
        await clock.sleep(Math.max(0, next - clock.now().getTime()));
      }
      const measuredElapsedMs = performance.now() - measuredStart;
      const window = structuredClone(workload.result());
      const sizesBeforeCheckpoint = store.sizes();
      const drainStarted = performance.now();
      workload.drain();
      const explicitDrainMs = performance.now() - drainStarted;
      const drainMs = Math.max(0, performance.now() - measuredStart - durationMs);
      store.observer = undefined;
      const afterDrain = workload.result();
      assert.equal(afterDrain.campaignBacklog, 0);
      assert.equal(afterDrain.eventBacklog, 0);
      assert.equal(afterDrain.churnBacklog, 0);
      const status = store.status();
      assert.equal(status.events, window.offeredEvents);
      assert.equal(status.distinctEvents, window.offeredEvents);
      assert.equal(status.cursor, window.offeredCampaign);
      assert.equal(status.sent, window.offeredCampaign);
      assert.equal(status.integrity, "ok");
      assert.equal(status.foreignKeyErrors, 0);
      store.verifyFts();
      assert.deepEqual(store.search("churn"), []);
      const checkpointStarted = performance.now();
      const checkpoint = store.checkpoint();
      const checkpointMs = performance.now() - checkpointStarted;
      const sizesAfterCheckpoint = store.sizes();
      store.close();
      store = new SpikeStore(runDir);
      assert.deepEqual(store.status(), status);
      store.verifyFts();
      store.close();
      console.log(
        JSON.stringify(
          {
            kind: "scenario",
            run: "comparison",
            mode,
            repetition,
            sqlite,
            seedMs,
            measuredElapsedMs,
            window,
            drainMs,
            explicitDrainMs,
            afterDrain,
            checkpoint,
            checkpointMs,
            sizesBeforeCheckpoint,
            sizesAfterCheckpoint,
            status,
            samples: Object.fromEntries(
              Object.entries(workload.samples).map(([key, values]) => {
                const summary = summarize(values);
                const interval =
                  key === "campaignLagMs"
                    ? 20
                    : key === "eventAcceptLagMs" || key === "eventCommitLagMs"
                      ? 10
                      : undefined;
                return [
                  key,
                  summary && interval
                    ? {
                        ...summary,
                        intervalMs: interval,
                        overInterval: values.filter((value) => value > interval).length,
                      }
                    : summary,
                ];
              }),
            ),
          },
          (_key, value) => (typeof value === "bigint" ? String(value) : value),
        ),
      );
    }
  }
  if (!args.has("--control-only")) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const triggers of repetition % 2 ? [false, true] : [true, false]) {
        const result = runFtsIsolation(root, triggers, repetition, subscribers, smoke ? 200 : 3000);
        console.log(
          JSON.stringify(result, (_key, value) =>
            typeof value === "bigint" ? String(value) : value,
          ),
        );
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
