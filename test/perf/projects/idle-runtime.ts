// B143a measurement (docs/perf/projects-B143a.md): the idle cost of an instance whose projects were
// created at runtime through /api/instance/projects, compared with B138b's projects registered
// before the start (test/perf/projects/idle.ts).
//
// Usage: bun test/perf/projects/idle-runtime.ts <executable> <label> <projects> [minutes=10]
//
// A fresh install (the primary project), then `projects - 1` creates through the instance API, one
// after another, timed. Reported: the creates' durations, VmRSS five seconds after the last create,
// and VmRSS and CPU time (user + system, from /proc) after `minutes` of idling, also per minute.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import { portZeroRootUrl, readyOnPortZero, stopChild } from "@/test/serve-port";

const executable = resolve(process.argv[2] ?? "dist/iglo.email");
const label = process.argv[3] ?? "run";
const projects = Number(process.argv[4] ?? 1);
const minutes = Number(process.argv[5] ?? 10);
const scratch = resolve(
  process.env.MEASURE_DIR ?? join(process.env.HOME ?? "/tmp", "scratch-b143a"),
);
/** USER_HZ on Linux. */
const TICKS = 100;
const admin = { user: "measure-admin", password: "measure-admin-password" };

const dataDir = mkdtempSync(join(scratch, "idle-runtime-"));
const rss = (pid: number) =>
  Number(/^VmRSS:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf-8"))?.[1] ?? 0);
const cpuSeconds = (pid: number) => {
  // Fields after the command name: utime and stime are the 12th and 13th.
  const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) / TICKS;
};

const child = Bun.spawn(
  [executable, "--port", "0", "--root-url", portZeroRootUrl, "--data-dir", dataDir],
  {
    env: {
      PATH: "",
      IGLO_EMAIL_ADMIN_USER: admin.user,
      IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
try {
  const { port } = await readyOnPortZero(child, 60_000);
  await Bun.sleep(5000);
  const rssBeforeKb = rss(child.pid);
  const { session } = await instanceLogin(port, "127.0.0.1", admin);
  if (!session) {
    throw new Error("The instance login failed");
  }
  const createMs: Array<number> = [];
  for (let index = 1; index < projects; index++) {
    const started = performance.now();
    const response = await instanceCall(
      port,
      "127.0.0.1",
      session,
      "POST",
      "/api/instance/projects",
      {
        slug: `p${index}`,
        name: `P${index}`,
        hostname: `p${index}.measure.test`,
      },
    );
    if (response.status !== 200) {
      throw new Error(`Creating p${index} answered ${response.status}: ${await response.text()}`);
    }
    createMs.push(Math.round(performance.now() - started));
  }
  await Bun.sleep(5000);
  const rssStartKb = rss(child.pid);
  const cpuStart = cpuSeconds(child.pid);
  // CPU per idle minute: a tail after the creates decays, a steady cost does not.
  const cpuByMinute: Array<number> = [];
  let mark = cpuStart;
  for (let minute = 0; minute < minutes; minute++) {
    await Bun.sleep(60_000);
    const now = cpuSeconds(child.pid);
    cpuByMinute.push(+(now - mark).toFixed(2));
    mark = now;
  }
  const rssEndKb = rss(child.pid);
  const cpuIdle = cpuSeconds(child.pid) - cpuStart;
  process.stdout.write(
    `${JSON.stringify({
      label,
      projects,
      createMs,
      rssBeforeCreatesMiB: +(rssBeforeKb / 1024).toFixed(1),
      rssStartMiB: +(rssStartKb / 1024).toFixed(1),
      rssEndMiB: +(rssEndKb / 1024).toFixed(1),
      idleMinutes: minutes,
      idleCpuSeconds: +cpuIdle.toFixed(2),
      cpuByMinute,
    })}\n`,
  );
} finally {
  await stopChild(child, "SIGTERM", 10_000);
  rmSync(dataDir, { recursive: true, force: true });
}
