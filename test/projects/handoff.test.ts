// B140 (14-projects section 5; D153): a handoff token lives 60 s on the instance's injected clock.
// The instance runs in this process with a test clock, so the expiry is reached by advancing it.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "@/projects/instance";
import type { Instance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { TestClock } from "@/test/server/fixture";
import { instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
import { adminCredentials, request } from "@/test/projects/fixture";

setDefaultTimeout(30_000);

const clock = new TestClock();
let dataDir = "";
let instance: Instance;
let server: ReturnType<typeof serveRouted>;
let port = 0;
let session: InstanceSession;

beforeAll(async () => {
  const admin = await adminCredentials();
  dataDir = await mkdtemp(join(tmpdir(), "iglo-email-handoff-"));
  instance = await openInstance(
    {
      dataDir,
      rootUrl: "http://127.0.0.1",
      listen: { host: "127.0.0.1", port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
    },
    clock,
  );
  await instance.add({ slug: "a", name: "A", hostname: "a.example.test" });
  const opened = instance;
  server = serveRouted({ host: "127.0.0.1", port: 0 }, (incoming, peer) =>
    opened.dispatch(incoming, peer),
  );
  instance.attach(server);
  port = server.port!;
  session = (await instanceLogin(port, "127.0.0.1", admin)).session!;
});

afterAll(async () => {
  await server?.stop(true);
  await instance?.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function mint(): Promise<URL> {
  const open = await request(port, "127.0.0.1", "/admin/instance/open/a?next=/admin/lists", {
    headers: { cookie: session.cookie },
  });
  expect(open.status).toBe(303);
  return new URL(open.headers.get("location")!);
}

test("a token redeemed within 60 s signs in; one redeemed after 60 s is 403 with no session", async () => {
  const fresh = await mint();
  clock.advance(59_000);
  const inTime = await request(port, "a.example.test", fresh.pathname + fresh.search);
  expect(inTime.status).toBe(303);
  expect(inTime.headers.get("location")).toBe("/admin/lists");

  const stale = await mint();
  clock.advance(60_000);
  const late = await request(port, "a.example.test", stale.pathname + stale.search);
  expect(late.status).toBe(403);
  expect(late.headers.getSetCookie().some((value) => value.startsWith("session="))).toBe(false);
});
