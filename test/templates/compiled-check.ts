// Compile and execute the real renderer from a disposable, isolated directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command } from "@/test/reference/command";

const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(join(tmpdir(), "iglo-template-compiled-"));
try {
  const fixture = join(directory, "fixture");
  const build = await command(
    [
      process.execPath,
      "build",
      "--compile",
      join(root, "test/templates/compiled-fixture.ts"),
      "--outfile",
      fixture,
    ],
    { cwd: root, env: { ...process.env, TMPDIR: directory }, timeout: 60_000 },
  );
  if (build.code !== 0) throw new Error("Template fixture compilation failed");
  const bwrap = Bun.which("bwrap");
  if (process.platform !== "linux" || !bwrap)
    throw new Error("Template isolation requires Linux bwrap");
  const result = await command(
    [
      bwrap,
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
    ],
    {
      cwd: directory,
      env: { PATH: "", HOME: "/work", TMPDIR: "/work", TZ: "UTC" },
      timeout: 30_000,
    },
  );
  if (result.code !== 0) throw new Error(`Template fixture failed: ${result.stderr}`);
  process.stdout.write(result.stdout);
} finally {
  await rm(directory, { recursive: true, force: true });
}
