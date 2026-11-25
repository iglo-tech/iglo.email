// B149a (14-projects section 7 "Rate", D161, D164): the instance Settings page's line beside
// messaging.max_send_rate. A setting of 0 is no cap, not a rate above SES's, and has its own words;
// a setting above SES's rate gets the warning; one at or below it gets neither. The page renders
// the saved value's line (the field's Alpine binding follows edits; the browser pass checks that).
// In process with a stand-in for SES v2 GetAccount; everything else through the instance's HTTP.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createRealClock } from "@/clock";
import { asBody } from "@/test/read-body";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import { adminCredentials } from "@/test/projects/fixture";

setDefaultTimeout(60_000);

const HOST = "127.0.0.1";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** The instance Settings page after saving `setting`, with SES's rate at 5/s. */
async function settingsPage(setting: number): Promise<string> {
  const ses = Bun.serve({
    port: 0,
    hostname: HOST,
    fetch: () =>
      Response.json({
        SendQuota: { Max24HourSend: 50_000, MaxSendRate: 5, SentLast24Hours: 0 },
        ProductionAccessEnabled: true,
        SendingEnabled: true,
      }),
  });
  cleanup.push(() => ses.stop(true));
  const admin = await adminCredentials();
  const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b149a-ses-rate-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: `http://${HOST}`,
      listen: { host: HOST, port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
      sesEndpoint: () => `http://${HOST}:${ses.port}`,
    },
    createRealClock(),
  );
  const server = serveRouted({ host: HOST, port: 0 }, (incoming, peer) =>
    instance.dispatch(incoming, peer),
  );
  instance.attach(server);
  cleanup.push(async () => {
    await server.stop(true);
    await instance.close();
  });
  const port = server.port!;
  const operator = (await instanceLogin(port, HOST, admin)).session!;
  const current = await instanceCall(port, HOST, operator, "GET", "/api/instance/settings");
  const { data } = asBody<{ data: Record<string, unknown> }>(await current.json());
  const saved = await instanceCall(port, HOST, operator, "PUT", "/api/instance/settings", {
    ...data,
    "messaging.max_send_rate": setting,
    "ses.api_region": "eu-west-1",
    "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLE",
    "ses.api_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  expect(saved.status).toBe(200);
  const check = await instanceCall(
    port,
    HOST,
    operator,
    "POST",
    "/api/instance/settings/ses/check",
    {},
  );
  expect(check.status).toBe(200);
  return (await instanceCall(port, HOST, operator, "GET", "/admin/instance/settings")).text();
}

/** The opening tag of the element with `testid`, and whether it is shown as rendered. */
function line(page: string, testid: string) {
  const tag = new RegExp(`<p[^>]*data-testid="${testid}"[^>]*>([^<]*)`).exec(page);
  expect(tag).not.toBeNull();
  return {
    shown: !tag![0].includes("display: none"),
    text: tag![1]!.replaceAll(/\s+/g, " ").trim(),
  };
}

test("a setting of 0 says there is no cap of its own and that sending runs at SES's rate, not that it is higher", async () => {
  const page = await settingsPage(0);
  expect(page).toContain("SES allows 5/s.");
  expect(line(page, "ses-rate-unpaced")).toEqual({
    shown: true,
    text: "The setting is 0, no cap of its own: sending runs at the rate SES allows, 5/s.",
  });
  expect(line(page, "ses-rate-warning").shown).toBe(false);
});

test("a setting above SES's rate shows the warning; one at or below it shows neither line", async () => {
  const higher = await settingsPage(10);
  expect(line(higher, "ses-rate-warning")).toEqual({
    shown: true,
    text: "The setting is higher than the rate SES allows: sending runs at 5/s.",
  });
  expect(line(higher, "ses-rate-unpaced").shown).toBe(false);
  const lower = await settingsPage(5);
  expect(line(lower, "ses-rate-warning").shown).toBe(false);
  expect(line(lower, "ses-rate-unpaced").shown).toBe(false);
});
