// A test send that is not delivered leaves one attention line (B101), through HTTP: the send
// answers `true` at once, a refused recipient leaves a line in GET /api/logs, and a delivered one
// leaves none. The buffer keeps a fixed text with no address; stderr keeps the recipient and stage.
import { afterEach, expect, test } from "bun:test";
import { createAnalyticsPurge } from "@/analytics/purge";
import { createErrorLogger } from "@/app";
import { createLogBuffer, type LogBuffer } from "@/maintenance/log-buffer";
import { registerMaintenanceRoutes } from "@/maintenance/routes";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";

const REFUSED = "refused@example.test";
const DELIVERED = "delivered@example.test";
const FIXED = "Test send not delivered: the server error output names the recipient and stage";

const fixtures: CampaignsFixture[] = [];
const purges: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const purge of purges.splice(0)) purge.close();
  for (const f of fixtures.splice(0)) await f.close();
});

/** Campaign test sends through HTTP, with the app's own error logger and log buffer. */
async function open() {
  let logs!: LogBuffer;
  const f = await campaignsFixture({
    sinkReject: (to) => to === REFUSED,
    logger: (clock) => {
      logs = createLogBuffer(clock);
      return createErrorLogger(logs);
    },
  });
  fixtures.push(f);
  const purge = createAnalyticsPurge(f.db, f.db);
  purges.push(purge);
  registerMaintenanceRoutes(f.router, {
    subscribers: f.owners.subscribers,
    analytics: purge,
    logs,
    auth: f.owners.auth,
    clock: f.clock,
    keepOpen: () => {},
    individualTracking: () => false,
  });
  return f;
}

/** The error output this process writes while `run` runs, as the messages it logs. */
async function captureStderr(run: () => Promise<void>) {
  const written: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => {
    written.push(String((parts[1] as Error | undefined)?.message ?? parts[0]));
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return written;
}

const logLines = async (f: CampaignsFixture) => {
  const response = await f.json("/api/logs");
  expect(response.status).toBe(200);
  return response.body.data as string[];
};

async function testCampaign(f: CampaignsFixture, to: string) {
  const news = await f.list("news");
  await f.subscriber(to, [news]);
  const c = await f.campaign({ name: "Weekly", subject: "Stored", lists: [news] });
  const sent = await f.json(`/api/campaigns/${c.id}/test`, "POST", {
    name: "Weekly",
    subject: "Hi",
    lists: [news],
    messenger: "email",
    content_type: "plain",
    body: "Hello",
    subscribers: [to],
  });
  expect(sent.status).toBe(200);
  expect(sent.body.data).toBe(true);
  return c as { id: number };
}

test("a refused test send answers true, then one attention line in the log", async () => {
  const f = await open();
  let campaign!: { id: number };
  const stderr = await captureStderr(async () => {
    campaign = await testCampaign(f, REFUSED);
    // The send is queued; its refusal is logged once the emailer settles it.
    for (let i = 0; i < 400 && (await logLines(f)).length === 0; i++) await Bun.sleep(5);
  });
  const lines = await logLines(f);
  expect(lines.filter((line) => line.includes(FIXED))).toHaveLength(1);
  expect(lines.find((line) => line.includes(FIXED))).toMatch(new RegExp(` \\*: ${FIXED}$`));
  // The buffer keeps no address; stderr names the campaign, the recipient and the stage.
  expect(lines.join("\n")).not.toContain(REFUSED);
  const detail = stderr.find((message) => message.includes("not delivered"));
  expect(detail).toContain(REFUSED);
  expect(detail).toContain(`campaign ${campaign.id}`);
  expect(detail).toContain("stage recipients");
});

test("a delivered test send logs nothing", async () => {
  const f = await open();
  await testCampaign(f, DELIVERED);
  for (let i = 0; i < 400 && (await f.mail(1)).length === 0; i++) await Bun.sleep(5);
  expect(f.sink.messages).toHaveLength(1);
  // The outcome is settled once the message is in the sink; nothing is logged for it.
  await Bun.sleep(20);
  expect(await logLines(f)).toEqual([]);
});
