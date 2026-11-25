// B144a measurement (docs/perf/projects-B144a.md): duration and peak RSS of `backup` against any
// compiled executable, on a stopped server's data directory, so the same script measures both
// sides of a change. Opt-in, not a CI threshold.
//
// Usage: bun test/perf/projects/backup.ts <executable> <label> [subscribers=300000] [runs=3]
//
// Two data directories under MEASURE_DIR (default $HOME/scratch-b144a; real disk, not tmpfs):
// - "one": the primary project with N subscribers.
// - "ten": the primary and nine more projects, each with 1,000 subscribers.
// Each run is `backup --data-dir <dir> --output <fresh path>` with no other flag; peak RSS is the
// child's VmHWM. One JSON line per run goes to stdout.
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRealClock } from "@/clock";
import { openInstanceDatabase } from "@/projects/instance";
import { createRegistry } from "@/projects/registry";
import { portZeroRootUrl, readyOnPortZero, stopChild } from "@/test/serve-port";

const executable = resolve(process.argv[2] ?? "dist/iglo.email");
const label = process.argv[3] ?? "run";
const subscribers = Number(process.argv[4] ?? 300_000);
const runs = Number(process.argv[5] ?? 3);
const scratch = resolve(
  process.env.MEASURE_DIR ?? join(process.env.HOME ?? "/tmp", "scratch-b144a"),
);
mkdirSync(scratch, { recursive: true });
const base = mkdtempSync(join(scratch, "backup-"));
const mb = (bytes: number) => +(bytes / 1_048_576).toFixed(1);

/** One start and an orderly stop: every registered project gets its database and schema. */
async function startOnce(dataDir: string) {
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
  await readyOnPortZero(child);
  const code = await stopChild(child, "SIGTERM", 10_000);
  if (code !== 0) {
    throw new Error(`the server exited ${code}`);
  }
}

function seed(dataDir: string, slug: string, count: number) {
  const db = new Database(join(dataDir, "projects", slug, "iglo-email.db"));
  db.run("PRAGMA synchronous = OFF");
  const insert = db.prepare(
    "INSERT INTO subscribers (uuid, email, name, status, attribs, created_at, updated_at) VALUES (?, ?, ?, 'enabled', '{}', ?, ?)",
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(crypto.randomUUID(), `seed-${i}@example.test`, `Seed ${i}`, now, now);
    }
  })();
  insert.finalize();
  db.close();
}

function register(dataDir: string, slugs: Array<string>) {
  const clock = createRealClock();
  const db = openInstanceDatabase(dataDir, clock);
  try {
    const registry = createRegistry(db, clock);
    try {
      for (const slug of slugs) {
        registry.add({
          slug,
          name: slug,
          hostname: slug === "main" ? "127.0.0.1" : `${slug}.example.test`,
          primary: slug === "main",
        });
      }
    } finally {
      registry.close();
    }
  } finally {
    db.close();
  }
}

async function measure(shape: string, dataDir: string) {
  for (let run = 1; run <= runs; run++) {
    const output = join(base, `${shape}-out-${run}`);
    const begun = performance.now();
    const child = Bun.spawn([executable, "backup", "--data-dir", dataDir, "--output", output], {
      env: { PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    let exited = false;
    void child.exited.then(() => (exited = true));
    let peakRss = 0;
    while (!exited) {
      try {
        const peak = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${child.pid}/status`, "utf-8"));
        peakRss = Math.max(peakRss, Number(peak?.[1] ?? 0) * 1024);
      } catch {
        // It exited between the check and the read.
      }
      await Bun.sleep(5);
    }
    const seconds = (performance.now() - begun) / 1000;
    if ((await child.exited) !== 0) {
      throw new Error(await new Response(child.stderr).text());
    }
    console.log(
      JSON.stringify({
        label,
        shape,
        run,
        seconds: +seconds.toFixed(2),
        peakRssMiB: mb(peakRss),
      }),
    );
    rmSync(output, { recursive: true, force: true });
    Bun.gc(true);
  }
}

try {
  const one = join(base, "one");
  register(one, ["main"]);
  await startOnce(one);
  seed(one, "main", subscribers);
  await measure("one", one);
  rmSync(one, { recursive: true, force: true });

  const ten = join(base, "ten");
  const slugs = ["main", ...Array.from({ length: 9 }, (_, i) => `p${i + 1}`)];
  register(ten, slugs);
  await startOnce(ten);
  for (const slug of slugs) {
    seed(ten, slug, 1000);
  }
  await measure("ten", ten);
} finally {
  rmSync(base, { recursive: true, force: true });
}
