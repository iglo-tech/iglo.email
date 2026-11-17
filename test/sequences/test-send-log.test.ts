// A sequence step test send that is not delivered leaves one attention line (B101), through HTTP
// and the SMTP sink: the send answers `true`, a refused recipient is logged with its sequence, step,
// recipient and stage, and a delivered one is not. Time is the injected clock.
import { afterEach, expect, test } from "bun:test";
import { schedulerFixture, type SchedulerFixture } from "@/test/scheduler/fixture";

const REFUSED = "refused@example.test";
const DELIVERED = "delivered@example.test";

const fixtures: SchedulerFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

async function open(sinkReject?: (to: string) => boolean) {
  const f = await schedulerFixture(sinkReject ? { sinkReject } : {});
  fixtures.push(f);
  return f;
}

async function setup(f: SchedulerFixture) {
  const template = await f.template("<p>Hi {{ subscriber.name }}</p>", "Template subject");
  const sequence = await f.sequence({
    trigger: { event: "purchase" },
    steps: [{ wait: "P1D", kind: "transactional", template_id: template, subject: "Order update" }],
  });
  return { sequence: sequence.id, step: sequence.steps[0]!.id };
}

/** The messages the app logged as errors, as text. */
const logged = (f: SchedulerFixture) =>
  f.errors.map((error) => (error instanceof Error ? error.message : String(error)));

test("a refused step test send answers true, then one attention line naming the step and stage", async () => {
  const f = await open((to) => to === REFUSED);
  const { sequence, step } = await setup(f);
  const sent = await f.json(`/api/sequences/${sequence}/steps/${step}/test`, "POST", {
    emails: [REFUSED],
  });
  expect(sent.status).toBe(200);
  expect(sent.body.data).toBe(true);
  await f.until(() => logged(f).some((line) => line.includes("not delivered")), "the log line");
  const lines = logged(f).filter((line) => line.includes("not delivered"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(REFUSED);
  expect(lines[0]).toContain(`sequence ${sequence} step ${step}`);
  expect(lines[0]).toContain("stage recipients");
  expect(f.sink.messages).toHaveLength(0);
});

test("a delivered step test send logs nothing", async () => {
  const f = await open();
  const { sequence, step } = await setup(f);
  const sent = await f.json(`/api/sequences/${sequence}/steps/${step}/test`, "POST", {
    emails: [DELIVERED],
  });
  expect(sent.status).toBe(200);
  await f.until(() => f.sink.messages.length === 1, "the test message");
  expect(logged(f).filter((line) => line.includes("not delivered"))).toEqual([]);
});
