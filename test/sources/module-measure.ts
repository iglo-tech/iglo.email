// B162a measurement (docs/perf/B162a-module.md): the idle cost of external sources per project.
// An in-process instance serves 20 projects on an injected clock; the script advances it through
// 10 minutes of clock time in 1-second steps and counts the clock timers the instance starts
// (every loop waits on `clock.sleep`), the timers pending at the end by their length, the RSS and
// the CPU time spent. Scenarios: `off` (the instance switch off, D188), `none` (the switch on and
// no project with a source) and `connected` (the switch on and every project reading one real
// PocketBase 0.40.5). A build without the switch (before B162a) runs `none` and `connected` only.
// Not a CI threshold: `bun test/sources/module-measure.ts [off|none|connected ...]`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "@/clock";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import {
  adminCredentials,
  api,
  createApiUser,
  logIn,
  registerProjects,
} from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";
import { startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";

const PROJECTS = 20;
const MINUTES = 10;
const HOST = "127.0.0.1";

/** A clock whose time moves only by `advance`; it counts every sleep it starts. */
function countingClock(start: number) {
  let offset = 0;
  let started = 0;
  const pending = new Set<{ at: number; ms: number; resolve: () => void }>();
  const clock: Clock = {
    now: () => new Date(start + offset),
    sleep(milliseconds, signal) {
      started++;
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = { at: offset + milliseconds, ms: milliseconds, resolve: () => {} };
        const abort = () => {
          pending.delete(timer);
          reject(signal?.reason);
        };
        timer.resolve = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        pending.add(timer);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  return {
    clock,
    started: () => started,
    pending: () => {
      const byLength = new Map<number, number>();
      for (const timer of pending) {
        byLength.set(timer.ms, (byLength.get(timer.ms) ?? 0) + 1);
      }
      return [...byLength].sort((a, b) => a[0] - b[0]);
    },
    async advance(milliseconds: number) {
      offset += milliseconds;
      // Deleting the current entry while iterating a Set is safe.
      for (const timer of pending) {
        if (timer.at <= offset) {
          pending.delete(timer);
          timer.resolve();
        }
      }
      // Let the woken loops run their turn (database work, a socket read) before the next step.
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
    },
  };
}

async function measure(scenario: string, pb: PocketBase | undefined) {
  const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b162a-measure-"));
  const projects = Array.from({ length: PROJECTS }, (_, index) =>
    index === 0
      ? { slug: "main", name: "Main", hostname: HOST, primary: true }
      : { slug: `p${index}`, name: `P${index}`, hostname: `p${index}.test`, primary: false },
  );
  registerProjects(dataDir, projects);
  const admin = await adminCredentials();
  const counted = countingClock(Date.now());
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: `http://${HOST}`,
      listen: { host: HOST, port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
    },
    counted.clock,
  );
  const server = serveRouted({ host: HOST, port: 0 }, (incoming, peer) =>
    instance.dispatch(incoming, peer),
  );
  instance.attach(server);
  instance.start((failure) => {
    console.error("A loop failed", failure);
  });
  const port = server.port!;
  try {
    const operator = (await instanceLogin(port, HOST, admin)).session!;
    const read = await instanceCall(port, HOST, operator, "GET", "/api/instance/settings");
    const shared = asBody<{ data: Record<string, unknown> }>(await read.json()).data;
    const switchable = "sources.enabled" in shared;
    if (scenario === "off" && !switchable) {
      return null;
    }
    const changes: Record<string, unknown> = {};
    if (switchable) {
      changes["sources.enabled"] = scenario !== "off";
    }
    if (scenario === "connected") {
      changes["sources.private_hosts"] = ["localhost"];
    }
    const saved = await instanceCall(port, HOST, operator, "PUT", "/api/instance/settings", {
      ...shared,
      ...changes,
    });
    if (saved.status !== 200) {
      throw new Error(`Instance settings answered ${saved.status}: ${await saved.text()}`);
    }
    if (scenario === "connected" && pb) {
      for (const project of projects) {
        const key = await createApiUser(
          port,
          project.hostname,
          await logIn(port, project.hostname, admin),
          "measure",
        );
        const source: Record<string, unknown> = {
          "source.url": `http://localhost:${pb.port}`,
          "source.identity": pb.service.identity,
          "source.password": pb.service.password,
          "source.users": { collection: "users", leaving_filter: "deletedAt != ''" },
        };
        if (switchable) {
          source["source.connector"] = "pocketbase";
        }
        const current = await api(port, project.hostname, key, "GET", "/api/settings");
        const settings = asBody<{ data: Record<string, unknown> }>(JSON.parse(current.text)).data;
        const answer = await api(port, project.hostname, key, "PUT", "/api/settings", {
          ...settings,
          ...source,
        });
        if (answer.status !== 200) {
          throw new Error(`${project.slug} settings answered ${answer.status}: ${answer.text}`);
        }
      }
    }
    // Let every project settle (streams connect) before the measured window.
    for (let second = 0; second < 30; second++) {
      await counted.advance(1000);
    }
    Bun.gc(true);
    const startedBefore = counted.started();
    const cpu = process.cpuUsage();
    const wall = performance.now();
    for (let second = 0; second < MINUTES * 60; second++) {
      await counted.advance(1000);
    }
    const used = process.cpuUsage(cpu);
    const elapsed = performance.now() - wall;
    Bun.gc(true);
    return {
      scenario,
      timersStarted: counted.started() - startedBefore,
      pending: counted.pending(),
      rssMiB: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
      cpuMs: Math.round((used.user + used.system) / 1000),
      wallMs: Math.round(elapsed),
    };
  } finally {
    await Promise.allSettled(instance.stop());
    await server.stop(true);
    await instance.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const scenarios = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["off", "none", "connected"];
const pb = scenarios.includes("connected") ? await startPocketBase() : undefined;
try {
  for (const scenario of scenarios) {
    const result = await measure(scenario, pb);
    console.log(
      result === null ? `${scenario}: not available on this build` : JSON.stringify(result),
    );
  }
} finally {
  await pb?.close();
}
