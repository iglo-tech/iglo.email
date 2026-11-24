// B138b measurement (docs/perf/projects-B138b.md): the idle cost of an instance with N projects.
//
// Usage: bun test/perf/projects/idle.ts <executable> <label> <projects> [minutes=10]
//
// With more than one project, the extra projects are registered through src/projects before the
// start (so this needs the B138b layout); one project is a fresh install, which also runs an
// earlier executable. Reported: time from spawn to the first /health answer, VmRSS five seconds
// after it, and VmRSS and CPU time (user + system, from /proc) after `minutes` of idling.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { portZeroRootUrl, readyOnPortZero, stopChild } from "@/test/serve-port";
import { registerProjects } from "@/test/projects/fixture";

const executable = resolve(process.argv[2] ?? "dist/iglo.email");
const label = process.argv[3] ?? "run";
const projects = Number(process.argv[4] ?? 1);
const minutes = Number(process.argv[5] ?? 10);
const scratch = resolve(
  process.env.MEASURE_DIR ?? join(process.env.HOME ?? "/tmp", "scratch-b138b"),
);
/** USER_HZ on Linux. */
const TICKS = 100;

const dataDir = mkdtempSync(join(scratch, "idle-"));
if (projects > 1) {
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: "127.0.0.1", primary: true },
    ...Array.from({ length: projects - 1 }, (_, index) => ({
      slug: `p${index + 1}`,
      name: `P${index + 1}`,
      hostname: `p${index + 1}.measure.test`,
    })),
  ]);
}
const rss = (pid: number) =>
  Number(/^VmRSS:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf-8"))?.[1] ?? 0);
const cpuSeconds = (pid: number) => {
  // Fields after the command name: utime and stime are the 12th and 13th.
  const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) / TICKS;
};

const started = performance.now();
const child = Bun.spawn(
  [executable, "--port", "0", "--root-url", portZeroRootUrl, "--data-dir", dataDir],
  {
    env: {
      PATH: "",
      IGLO_EMAIL_ADMIN_USER: "measure-admin",
      IGLO_EMAIL_ADMIN_PASSWORD: "measure-admin-password",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
try {
  await readyOnPortZero(child, 60_000);
  const startupMs = Math.round(performance.now() - started);
  await Bun.sleep(5000);
  const rssStartKb = rss(child.pid);
  const cpuStart = cpuSeconds(child.pid);
  await Bun.sleep(minutes * 60_000);
  const rssEndKb = rss(child.pid);
  const cpuIdle = cpuSeconds(child.pid) - cpuStart;
  process.stdout.write(
    `${JSON.stringify({
      label,
      projects,
      startupMs,
      rssStartMiB: +(rssStartKb / 1024).toFixed(1),
      rssEndMiB: +(rssEndKb / 1024).toFixed(1),
      idleMinutes: minutes,
      idleCpuSeconds: +cpuIdle.toFixed(2),
    })}\n`,
  );
} finally {
  await stopChild(child, "SIGTERM", 10_000);
  rmSync(dataDir, { recursive: true, force: true });
}
