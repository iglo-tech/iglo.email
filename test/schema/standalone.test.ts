import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("compiled schema fixture installs embedded production SQL with an empty PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iglo-embedded-schema-"));
  const binary = join(directory, "fixture");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const build = Bun.spawn(
      [process.execPath, "build", "--compile", "test/schema/standalone.ts", "--outfile", binary],
      { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    if (code) throw new Error(`Fixture build failed: ${stderr}`);
    const started = Bun.spawn([binary, join(directory, "data")], {
      cwd: directory,
      env: { PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    child = started;
    const reader = started.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture readiness timeout")), 5000);
      }),
    ]).finally(() => clearTimeout(timer));
    const origin = new TextDecoder().decode(chunk.value).trim();
    const response = await fetch(origin, {
      method: "POST",
      body: JSON.stringify({ action: "migrate" }),
      signal: AbortSignal.timeout(3000),
    });
    const { result } = (await response.json()) as {
      result: { version: string; integrity: string; shapes: Record<string, string[]> };
    };
    expect(response.status).toBe(200);
    expect(result.version).toBe("1");
    expect(result.integrity).toBe("ok");
    expect(result.shapes.enrollments).toContain("claimed_until");
    reader.releaseLock();
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 3000);
      try {
        await child.exited;
      } finally {
        clearTimeout(timer);
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
