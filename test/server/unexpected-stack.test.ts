// B110: an unexpected handler error keeps its stack on stderr, through a handler on a compiled
// process with the production logger. The response stays the hidden 500 envelope.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Whether the child exits within `ms`. A child still running after that is left for the caller. */
async function exitedWithin(child: ReturnType<typeof Bun.spawn>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test("an unexpected handler error prints its stack to stderr and answers a hidden 500", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "iglo-email-stack-"));
  const executable = join(temporaryDirectory, "stack-fixture");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        "test/server/stack-standalone.ts",
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
    if (buildCode !== 0) {
      throw new Error(`Fixture build failed: ${buildError}`);
    }
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
    reader.releaseLock();

    const response = await fetch(`${origin}/fixture/unexpected`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe('{"message":"Internal Server Error","code":"internal_error"}\n');
    expect(body).not.toContain("private");

    // The stderr copy is read once the child has exited, so every line it wrote is there. The exit
    // is waited for within a bound above the product's 5 s shutdown drain (D104); a child that
    // ignores SIGTERM is killed and fails by name, not at the 30 s test timeout (B118j item 2).
    child.kill("SIGTERM");
    if (!(await exitedWithin(child, 8000))) {
      child.kill("SIGKILL");
      await child.exited;
      throw new Error("The fixture ignored SIGTERM: it did not exit within 8 s and was killed.");
    }
    const stderr = await new Response(started.stderr).text();
    expect(stderr).toContain("Unexpected request error:");
    expect(stderr).toContain("private detail private-password");
    // A stack frame: an indented `at` line below the error, as Bun prints a thrown Error.
    expect(stderr).toMatch(/\n\s+at \S/);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}, 30_000);
