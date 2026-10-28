// Invocation-owned, disk-backed child/compile boundary with no runtime asset fallback.
import { statfsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command } from "@/test/reference/command";
import type { ReferenceMailpit } from "@/test/perf/runtime-compat/smtp-env";

const root = resolve(import.meta.dir, "../../..");
export async function processCheck(
  mode: "source-liquid" | "compiled-liquid" | "compiled-smtp",
  reference?: ReferenceMailpit,
) {
  const base = resolve(root, "upstream/measurements");
  await mkdir(base, { recursive: true });
  const disk = await realpath(base);
  if ([0x01021994, 0x858458f6].includes(Number(statfsSync(disk).type)))
    throw new Error("Runtime spike requires disk-backed storage");
  const directory = await mkdtemp(join(disk, "m08-runtime-"));
  try {
    const env: NodeJS.ProcessEnv = { PATH: "", HOME: directory, TMPDIR: directory, TZ: "UTC" };
    if (reference)
      Object.assign(env, {
        MAILPIT_URL: reference.api,
        MAILPIT_SMTP_HOST: reference.host,
        MAILPIT_SMTP_PORT: String(reference.port),
        REFERENCE_RUN_ID: reference.runId,
      });
    let program: string;
    let args: string[];
    if (mode === "source-liquid") {
      program = process.execPath;
      args = [join(root, "test/perf/runtime-compat/liquid-probes.ts")];
    } else {
      program = join(directory, "fixture");
      const build = await command(
        [
          process.execPath,
          "build",
          "--compile",
          join(root, "test/perf/runtime-compat/compiled-fixture.ts"),
          "--outfile",
          program,
        ],
        { cwd: root, env: { ...process.env, TMPDIR: directory }, timeout: 60_000 },
      );
      if (build.code !== 0) throw new Error(`Fixture compilation failed: ${build.stderr}`);
      args = [mode === "compiled-liquid" ? "liquid" : "smtp"];
    }
    let invocation = [program, ...args];
    if (mode !== "source-liquid") {
      const bubblewrap = Bun.which("bwrap");
      if (process.platform !== "linux" || !bubblewrap)
        throw new Error("Compiled isolation check requires Linux bubblewrap (bwrap)");
      env.HOME = "/work";
      env.TMPDIR = "/work";
      invocation = [
        bubblewrap,
        "--unshare-user",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "--bind",
        directory,
        "/work",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--chdir",
        "/work",
        "/work/fixture",
        ...args,
      ];
    }
    const run = await command(invocation, { cwd: directory, env, timeout: 30_000 });
    if (run.code !== 0) throw new Error(`${mode} failed: ${run.stderr}`);
    return { mode, cleanExit: true, result: JSON.parse(run.stdout.trim()) as unknown };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
