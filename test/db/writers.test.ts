import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDbFixture } from "@/test/db/fixture";

async function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("BEGIN IMMEDIATE serializes writers in separate processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iglo-writers-"));
  const fixture = startDbFixture(directory);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await fetch(fixture.origin, {
      method: "POST",
      body: JSON.stringify({ action: "migrate", catalog: "first" }),
      signal: AbortSignal.timeout(3000),
    });
    function spawn(mode: string) {
      return Bun.spawn([process.execPath, "run", "test/db/writer.ts", directory, mode], {
        cwd: resolve(import.meta.dir, "../.."),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    }
    const locker = spawn("lock");
    children.push(locker);
    const locked = locker.stdout.getReader();
    const first = await bounded(locked.read(), "Lock readiness timeout");
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    const writer = spawn("write");
    children.push(writer);
    const output = writer.stdout.getReader();
    const attempt = await bounded(output.read(), "Writer readiness timeout");
    expect(new TextDecoder().decode(attempt.value)).toContain("attempt");
    // This bounded delay coordinates test processes; domain time remains injected.
    expect(
      await Promise.race([
        writer.exited.then(() => "exited"),
        Bun.sleep(100).then(() => "waiting"),
      ]),
    ).toBe("waiting");
    locker.stdin.write("x");
    locker.stdin.end();
    expect(await bounded(locker.exited, "Lock release timeout")).toBe(0);
    expect(await bounded(writer.exited, "Writer completion timeout")).toBe(0);
    locked.releaseLock();
    output.releaseLock();
    const response = await fetch(fixture.origin, {
      method: "POST",
      body: JSON.stringify({ action: "get", id: "20" }),
      signal: AbortSignal.timeout(3000),
    });
    expect(((await response.json()) as { result: { value: string } }).result.value).toBe("second");
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(children.map((child) => child.exited));
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
