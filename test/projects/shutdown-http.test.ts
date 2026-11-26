// B149a (14-projects section 10, D164): the HTTP stop of a shutdown waits for requests in flight at
// most 5 s of the instance clock, as a delete's drain does, then cuts them. A stalled upload no
// longer holds the shutdown until Bun's own idle timeout, and a trickled one (which that timeout
// never ends) no longer holds it at all. In process on a test clock for the bound, and on the
// compiled executable for the signal path.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  heldRequest,
  openLifecycle,
  PRIMARY,
  projectSession,
} from "@/test/projects/lifecycle-fixture";
import {
  adminCredentials,
  logIn,
  prepareExecutable,
  request,
  sessionHeaders,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials } from "@/test/projects/fixture";
import { stopChild } from "@/test/serve-port";
import { TestClock } from "@/test/server/fixture";
import { untilState } from "@/test/wait";

setDefaultTimeout(60_000);

test("the HTTP stop waits at most 5 s of the instance clock for a request in flight, then cuts it", async () => {
  const clock = new TestClock();
  const f = await openLifecycle(clock);
  try {
    const session = await projectSession(f, PRIMARY);
    // An upload that never finishes: its body stops after its first bytes.
    const held = heldRequest(f.port, PRIMARY, session, "/api/subscribers", {
      email: "held@main.example.test",
      name: "Held",
    });
    await Bun.sleep(50);
    const startedAt = clock.now().getTime();
    let stopped = false;
    const stopping = f.instance.stopServer().then(() => {
      stopped = true;
    });
    // Still waiting just before the deadline.
    while (clock.now().getTime() - startedAt < 4900) {
      clock.advance(100);
      await Bun.sleep(2);
    }
    await Bun.sleep(50);
    expect(stopped).toBe(false);
    // At the deadline its connection is cut and the stop finishes.
    clock.advance(100);
    await untilState(() => stopped, { label: "the HTTP stop at 5 s", progress: () => "" });
    await stopping;
    expect(clock.now().getTime() - startedAt).toBe(5000);
    // Its connection is gone: the client gets no answer.
    const cut = await held.answered.catch(() => ({ status: 0, text: "" }));
    expect(cut.status).toBe(0);
  } finally {
    await f.close();
  }
  expect(f.failures).toEqual([]);
});

/**
 * A body trickled to `path` on the primary's host, then SIGTERM. `headers` gives the request's
 * own headers, with the instance's port and the test admin.
 */
const trickledShutdown = (
  route: string,
  path: string,
  headers: (port: number, admin: Credentials) => Promise<Record<string, string>>,
) =>
  test(`SIGTERM with a trickled upload to ${route} in flight exits cleanly within the 5 s bound`, async () => {
    const prepared = await prepareExecutable();
    const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b149a-shutdown-"));
    const admin = await adminCredentials();
    const instance = await startInstance(prepared.executable, dataDir, admin);
    let trickling = true;
    try {
      const own = await headers(instance.port, admin);
      // A body that arrives one byte every 200 ms (1000 bytes, under the body limit): Bun's idle timeout never ends it.
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await Bun.sleep(200);
          if (trickling) {
            controller.enqueue(encoder.encode("a"));
          } else {
            controller.close();
          }
        },
      });
      const trickled = request(instance.port, PRIMARY, path, {
        method: "POST",
        headers: { ...own, "content-length": "1000" },
        body,
      });
      trickled.catch(() => {});
      await Bun.sleep(500);
      const startedAt = performance.now();
      // Without the bound this never exits on its own; the SIGKILL after 15 s would end it.
      const code = await stopChild(instance.child, "SIGTERM", 15_000);
      const elapsed = performance.now() - startedAt;
      expect(code).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      expect(elapsed).toBeLessThan(10_000);
      const stderr = await new Response(instance.child.stderr).text();
      expect(stderr).toContain("[instance] Stopping: 1 request still running after 5 s was cut");
      // B155a item 6 (D176): the cut was intended, so nothing else is logged about it: no
      // "Unexpected request error" per aborted read.
      expect(stderr.trim().split("\n")).toEqual([
        "[instance] Stopping: 1 request still running after 5 s was cut",
      ]);
    } finally {
      trickling = false;
      await stopChild(instance.child, "SIGKILL", 1000);
      await rm(dataDir, { recursive: true, force: true });
      await prepared.cleanup();
    }
  });

trickledShutdown("a project route", "/api/subscribers", async (port, admin) =>
  sessionHeaders(await logIn(port, PRIMARY, admin)),
);
// B155a r2 (D176): an instance route goes through the instance's own logger. Unauthenticated: the
// login form is read before anything is checked.
trickledShutdown("the instance login", "/admin/instance/login", async () => ({
  "content-type": "application/x-www-form-urlencoded",
}));
