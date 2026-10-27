import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Compile actual TSX and observe only its loopback HTTP surface.
test("compiled TSX escapes by default and rejects malformed values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iglo-jsx-"));
  const executable = join(directory, "fixture");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const build = Bun.spawn(
      [process.execPath, "build", "--compile", "test/jsx/fixture.tsx", "--outfile", executable],
      { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    );
    const [code, error] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    if (code !== 0) throw new Error(`TSX fixture build failed: ${error}`);
    child = Bun.spawn([executable], {
      cwd: directory,
      env: { PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture readiness timeout")), 5000);
      }),
    ]).finally(() => clearTimeout(timer));
    const origin = new TextDecoder().decode(chunk.value).trim();
    reader.releaseLock();
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
    const request = (path: string) =>
      fetch(`${origin}/${path}`, { signal: AbortSignal.timeout(2000) });
    const response = await request("document");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      '<section><p title="&lt;tag attr=&quot;x&quot;&gt;&amp;&#39;">&lt;tag attr=&quot;x&quot;&gt;&amp;&#39;</p>&lt;img src=x onerror=alert(1)&gt;one2<b>three</b><input disabled data-active="false" aria-checked="false"><br></section><em>trusted</em>',
    );
    for (const path of [
      "tag",
      "attribute",
      "object-child",
      "object-attribute",
      "raw-attribute",
      "event-handler",
      "void-child",
    ]) {
      const invalid = await request(path);
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toBe("rejected");
    }
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
