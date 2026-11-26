// B155a item 5 (D174, D176): a campaign waiting for its source that is paused and resumed between
// two runner scans starts afresh, as one paused across a scan does: the resume does not wait out
// the old backoff. Through the campaigns API on the injected clock, with a real PocketBase whose
// recipients view the transport makes answer 503.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createEnrollments } from "@/sequences/enrollments";
import { createPocketBaseSource } from "@/sources/pocketbase";
import { createSendTimeLookup } from "@/sources/send-time";
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import type { RunnerFixture } from "@/test/campaigns/runner/fixture";
import { asBody } from "@/test/read-body";
import { sourceConfig, startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";
import { openGuard } from "@/test/sources/stream-fixture";

setDefaultTimeout(120_000);

let pb: PocketBase;
let f: RunnerFixture | undefined;
beforeAll(async () => {
  pb = await startPocketBase();
});
afterEach(async () => {
  await f?.close();
  f = undefined;
});
afterAll(async () => {
  await pb?.close();
});

test("a campaign paused and resumed between two scans while it waits for its source retries at the next scan", async () => {
  const reads = { count: 0, failing: true };
  const source = createPocketBaseSource({
    config: sourceConfig(pb.url, pb.service),
    clock: createRealClock(),
    guard: openGuard,
    transport: {
      fetch(input: URL, init: RequestInit) {
        if (/^\/api\/collections\/recipients\/records\//.test(input.pathname)) {
          reads.count++;
          if (reads.failing) {
            return Promise.resolve(new Response("unavailable", { status: 503 }));
          }
        }
        return fetch(input, init);
      },
    },
  });
  const fixture = await runnerFixture({
    sendTime: (owner) =>
      createSendTimeLookup({
        db: owner.db,
        source: () => source,
        subscribers: owner.owners.subscribers,
        enrollments: createEnrollments(owner.db, owner.clock),
        emailAllowed: () => true,
      }),
  });
  f = fixture;
  const attention = () =>
    fixture.errors.filter((e) => e instanceof Error && e.message.includes("could not be read"))
      .length;
  const list = await fixture.list("news");
  const user = await pb.user();
  const email = asBody<string>(user.email);
  await fixture.member(email, [list], "confirmed", { external_id: user.id });
  const c = await fixture.campaign({
    name: "resumed between scans",
    subject: "Hi",
    lists: [list],
    content_type: "html",
    body: "<p>x</p>",
  });
  fixture.start();
  expect((await fixture.status(c.id, "running")).status).toBe(200);
  // Up to the 5-minute wait: the ninth read is followed by another 300 s wait.
  const step = 250;
  await fixture.drive(() => reads.count >= 9, step, 10_000_000, 30_000);
  expect(attention()).toBe(1);
  // Paused and resumed at once, with no scan between: the campaign never leaves the due list.
  expect((await fixture.status(c.id, "paused")).status).toBe(200);
  expect((await fixture.status(c.id, "running")).status).toBe(200);
  const resumed = fixture.clock.now().getTime();
  const before = reads.count;
  // The next read comes at the next scan, not after the rest of the old 300 s wait, and the
  // outage after the resume writes its own attention line.
  await fixture.drive(() => reads.count > before, step, 10_000_000, 30_000);
  const waited = fixture.clock.now().getTime() - resumed;
  expect({ waited, within: waited <= 5000 + 4 * step }).toEqual({ waited, within: true });
  expect(attention()).toBe(2);
  // The source answers: sent once.
  reads.failing = false;
  await fixture.until(c.id, "finished");
  expect(fixture.pushes.map((push) => push.to)).toEqual([email]);
  expect((await fixture.read(c.id)).sent).toBe(1);
});
