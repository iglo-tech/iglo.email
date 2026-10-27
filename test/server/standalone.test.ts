import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Verify a non-English pack in a compiled program from outside the checkout too.
test("compiled translation fixture embeds its selected pack", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "iglo-email-translations-"));
  const executable = join(temporaryDirectory, "fixture");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        "test/server/standalone.ts",
        "--outfile",
        executable,
      ],
      {
        cwd: resolve(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [buildCode, buildError] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    if (buildCode !== 0) throw new Error(`Fixture build failed: ${buildError}`);
    const started = Bun.spawn([executable], {
      cwd: temporaryDirectory,
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
    const response = await fetch(`${origin}/fixture/locale`, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      '{"data":{"code":"fr","name":"Français (fr)","message":"Le nom entré présente une erreur."}}\n',
    );
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
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}, 30_000);
