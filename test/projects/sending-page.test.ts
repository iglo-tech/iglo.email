// B143b (14-projects sections 7, 13 and 19 item 2, D162): the instance Sending page shows what the
// dispatcher and SES see when it is rendered: the effective rate and its source, the SES snapshot
// and its age, the quota guard, and the forecast for the 24 hours ending now, equal to
// `GET /api/sending/capacity` without a candidate. An instance runs in this process on a test
// clock with a stand-in for SES v2 GetAccount; its loops are not started, so every read is the
// on-demand one a page or a forecast triggers (at most one a minute). Everything is read through
// the rendered page, the project API and the stand-in's request count.
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { TestClock } from "@/test/server/fixture";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
import { adminCredentials, api, createApiUser, logIn, request } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";

setDefaultTimeout(60_000);

const HOST = "127.0.0.1";
const PAGE = "/admin/instance/sending";
const KEYS = {
  "ses.api_region": "eu-west-1",
  "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLE",
  "ses.api_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

/** What the stand-in answers next: an account, or a refusal with AWS's message. */
interface Account {
  max: number;
  sent: number;
  rate: number;
  production: boolean;
  sending: boolean;
  refuse: { status: number; message: string } | null;
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** A forecast field as the page writes it. */
const shown = (value: number | boolean | null | undefined) =>
  typeof value === "boolean" ? (value ? "Yes" : "No") : (value ?? 0).toLocaleString("en-US");

/** Every element with a `data-testid`, by its ID, with its whole text, spaces collapsed. */
function texts(html: string): Map<string, string> {
  const found = new Map<string, string>();
  const open: Array<string> = [];
  new HTMLRewriter()
    .on("*", {
      element(element) {
        const id = element.getAttribute("data-testid");
        if (!id || !element.canHaveContent || element.selfClosing) {
          return;
        }
        found.set(id, "");
        open.push(id);
        element.onEndTag(() => {
          open.splice(open.lastIndexOf(id), 1);
        });
      },
      text(chunk) {
        for (const id of open) {
          found.set(id, found.get(id) + chunk.text);
        }
      },
    })
    .transform(html);
  for (const [id, text] of found) {
    // HTMLRewriter hands text over as written: the escapes the renderer writes are undone.
    const decoded = text.replaceAll(
      /&(#39|quot|lt|gt|amp);/g,
      (_, name: string) => ({ "#39": "'", quot: '"', lt: "<", gt: ">", amp: "&" })[name] ?? "",
    );
    found.set(id, decoded.replaceAll(/\s+/g, " ").trim());
  }
  return found;
}

async function sendingInstance(options: { setting: number; keys: boolean; account?: Account }) {
  // The stand-in's refusals are attention lines on stderr: kept, not printed.
  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => errors.mockRestore());
  const clock = new TestClock();
  const account: Account = options.account ?? {
    max: 50_000,
    sent: 1200,
    rate: 14,
    production: true,
    sending: true,
    refuse: null,
  };
  let reads = 0;
  const ses = Bun.serve({
    port: 0,
    hostname: HOST,
    fetch: () => {
      reads++;
      if (account.refuse) {
        return Response.json(
          { message: account.refuse.message },
          {
            status: account.refuse.status,
            headers: { "x-amzn-errortype": "AccessDeniedException:" },
          },
        );
      }
      return Response.json({
        SendQuota: {
          Max24HourSend: account.max,
          MaxSendRate: account.rate,
          SentLast24Hours: account.sent,
        },
        ProductionAccessEnabled: account.production,
        SendingEnabled: account.sending,
      });
    },
  });
  cleanup.push(() => ses.stop(true));
  const admin = await adminCredentials();
  const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b143b-sending-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: `http://${HOST}`,
      listen: { host: HOST, port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
      sesEndpoint: () => `http://${HOST}:${ses.port}`,
    },
    clock,
  );
  const server = serveRouted({ host: HOST, port: 0 }, (incoming, peer) =>
    instance.dispatch(incoming, peer),
  );
  instance.attach(server);
  cleanup.push(async () => {
    await Promise.allSettled(instance.stop());
    await server.stop(true);
    await instance.close();
  });
  const port = server.port!;
  const operator: InstanceSession = (await instanceLogin(port, HOST, admin)).session!;
  const current = await instanceCall(port, HOST, operator, "GET", "/api/instance/settings");
  const { data } = asBody<{ data: Record<string, unknown> }>(await current.json());
  const saved = await instanceCall(port, HOST, operator, "PUT", "/api/instance/settings", {
    ...data,
    "messaging.max_send_rate": options.setting,
    ...(options.keys ? KEYS : {}),
  });
  expect(saved.status).toBe(200);

  /** The page as the instance admin sees it now. */
  const page = async () => {
    const response = await request(port, HOST, PAGE, { headers: { cookie: operator.cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    return { html, text: texts(html) };
  };
  return {
    port,
    clock,
    account,
    admin,
    operator,
    page,
    reads: () => reads,
    /** Past the on-demand rule's minute, so the next page reads the account again. */
    nextMinute: () => clock.advance(61_000),
  };
}

test("without SES keys the page says there is no reading, forecast or guard, and rate 0 is unpaced", async () => {
  const sending = await sendingInstance({ setting: 0, keys: false });
  const { html, text } = await sending.page();
  expect(text.get("sending-no-keys")).toContain(
    "there is no SES reading, no capacity forecast and no quota guard",
  );
  expect(html).toContain('href="/admin/instance/settings"');
  expect(text.get("rate-effective")).toBe("No cap");
  expect(text.get("rate-setting")).toBe("0 (no cap)");
  expect(text.get("rate-ses")).toBe("Not read");
  expect(text.get("rate-source")).toContain("No cap: sending is not paced");
  for (const absent of [
    "sending-snapshot",
    "sending-guard",
    "sending-forecast",
    "sending-not-read",
  ]) {
    expect(text.has(absent)).toBe(false);
  }
  expect(sending.reads()).toBe(0);
  // The nav links the page beside Projects and Logs, and marks it as the current one.
  expect(html).toMatch(/<a[^>]*href="\/admin\/instance\/sending"[^>]*aria-current="page"/);
  const projects = await request(sending.port, HOST, "/admin/instance/projects", {
    headers: { cookie: sending.operator.cookie },
  });
  expect(await projects.text()).toContain('href="/admin/instance/sending"');
});

test("before the first good read the page says so with AWS's error, and reads at most once a minute", async () => {
  const sending = await sendingInstance({
    setting: 14,
    keys: true,
    account: {
      max: 50_000,
      sent: 0,
      rate: 14,
      production: true,
      sending: true,
      refuse: {
        status: 403,
        message:
          "User: arn:aws:iam::123456789012:user/reader is not authorized to perform: ses:GetAccount",
      },
    },
  });
  const first = await sending.page();
  expect(first.text.get("sending-not-read")).toContain("The SES account has not been read yet");
  expect(first.text.get("snapshot-error")).toBe(
    "SES GetAccount answered 403 AccessDeniedException: User: arn:aws:iam::123456789012:user/reader is not authorized to perform: ses:GetAccount",
  );
  expect(first.text.has("sending-forecast")).toBe(false);
  expect(first.text.get("rate-effective")).toBe("14/s");
  expect(first.text.get("rate-source")).toContain("SES's MaxSendRate is not known");
  expect(sending.reads()).toBe(1);
  // A reload within the minute does not read again.
  sending.clock.advance(30_000);
  await sending.page();
  expect(sending.reads()).toBe(1);
});

test("with a snapshot: values, age, sandbox, SendingEnabled false, effective rate, and the forecast equals the API's", async () => {
  const sending = await sendingInstance({
    setting: 20,
    keys: true,
    account: {
      max: 50_000,
      sent: 1200,
      rate: 14,
      production: false,
      sending: false,
      refuse: null,
    },
  });
  const read = await sending.page();
  expect(sending.reads()).toBe(1);
  // SES's 14/s is lower than the setting's 20/s: the effective rate is SES's, not the setting.
  expect(read.text.get("rate-effective")).toBe("14/s");
  expect(read.text.get("rate-setting")).toBe("20/s");
  expect(read.text.get("rate-ses")).toBe("14/s");
  expect(read.text.get("rate-source")).toContain("SES's MaxSendRate applies");
  sending.clock.advance(30_000);
  const { text } = await sending.page();
  expect(sending.reads()).toBe(1);
  expect(text.get("snapshot-max")).toBe("50,000");
  expect(text.get("snapshot-sent")).toBe("1,200");
  expect(text.get("snapshot-remaining")).toBe("48,800");
  expect(text.get("snapshot-production")).toContain("SES sandbox");
  expect(text.get("snapshot-sending")).toBe("No");
  expect(text.get("sending-disabled")).toContain("SendingEnabled: false");
  expect(text.get("snapshot-age")).toBe("30 s");
  expect(text.has("snapshot-stale")).toBe(false);
  expect(text.get("snapshot-read-at")).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // Not holding: 48,800 left against max(2% of 50,000, 14 × 60) = 1,000.
  expect(text.get("guard-state")).toContain("Not holding");
  expect(text.get("guard-remaining")).toBe("48,800");
  expect(text.get("guard-line")).toBe("1,000");

  // The project API's forecast without a candidate, for the same state and the same instant.
  const key = await createApiUser(
    sending.port,
    HOST,
    await logIn(sending.port, HOST, sending.admin),
    "capacity",
  );
  const answer = await api(sending.port, HOST, key, "GET", "/api/sending/capacity");
  expect(answer.status).toBe(200);
  const forecast = asBody<{
    data: { forecast: Record<string, number | boolean | null> };
  }>(JSON.parse(answer.text)).data.forecast;
  expect({
    still_counted: text.get("forecast-still-counted"),
    outside: text.get("forecast-outside"),
    baseline: text.get("forecast-baseline"),
    planned: text.get("forecast-planned"),
    demand: text.get("forecast-demand"),
    quota: text.get("forecast-quota"),
    headroom: text.get("forecast-headroom"),
    fits: text.get("forecast-fits"),
  }).toEqual({
    still_counted: shown(forecast.still_counted),
    outside: shown(forecast.outside),
    baseline: shown(forecast.baseline),
    planned: shown(forecast.planned),
    demand: shown(forecast.demand),
    quota: shown(forecast.quota),
    headroom: shown(forecast.headroom),
    fits: shown(forecast.fits),
  });
  // By hand: no app sends, so all 1,200 are outside sends still counted at F = now.
  expect(text.get("forecast-demand")).toBe("1,200");
  expect(text.get("forecast-headroom")).toBe("48,800");
  expect(sending.reads()).toBe(1);
});

test("while reads fail the snapshot is shown as stale with AWS's error", async () => {
  const sending = await sendingInstance({ setting: 14, keys: true });
  await sending.page();
  sending.nextMinute();
  sending.account.refuse = {
    status: 403,
    message: "User: arn:aws:iam::123456789012:user/reader is not authorized",
  };
  sending.account.sent = 9999;
  const { text } = await sending.page();
  expect(sending.reads()).toBe(2);
  expect(text.get("snapshot-stale")).toContain("Stale");
  expect(text.get("snapshot-error")).toContain("arn:aws:iam::123456789012:user/reader");
  // The last good read's values, 61 s old.
  expect(text.get("snapshot-sent")).toBe("1,200");
  expect(text.get("snapshot-age")).toBe("1 min");
  expect(text.has("sending-forecast")).toBe(true);
  // A good read ends the stale state.
  sending.nextMinute();
  sending.account.refuse = null;
  const after = await sending.page();
  expect(after.text.has("snapshot-stale")).toBe(false);
  expect(after.text.get("snapshot-sent")).toBe("9,999");
  expect(after.text.get("snapshot-age")).toBe("0 s");
});

test("the guard shows its hold from the snapshot, and lifts after a newer one above the line", async () => {
  // At 10/s the line is max(2% of 50,000, 10 × 60) = 1,000.
  const sending = await sendingInstance({
    setting: 10,
    keys: true,
    account: { max: 50_000, sent: 49_100, rate: 14, production: true, sending: true, refuse: null },
  });
  const held = await sending.page();
  expect(held.text.get("rate-effective")).toBe("10/s");
  expect(held.text.get("rate-source")).toContain("The setting applies");
  expect(held.text.get("guard-state")).toContain("Holding marketing and campaign sends");
  expect(held.text.get("guard-remaining")).toBe("900");
  expect(held.text.get("guard-line")).toBe("1,000");
  // Time alone changes nothing: within the minute there is no read, and the hold stays.
  sending.clock.advance(59_000);
  sending.account.sent = 1000;
  const still = await sending.page();
  expect(sending.reads()).toBe(1);
  expect(still.text.get("guard-state")).toContain("Holding");
  // The next read is above the line: the hold lifts.
  sending.clock.advance(2000);
  const lifted = await sending.page();
  expect(sending.reads()).toBe(2);
  expect(lifted.text.get("guard-state")).toContain("Not holding");
  expect(lifted.text.get("guard-remaining")).toBe("49,000");
  // A failed read keeps the hold where the last good read left it.
  sending.nextMinute();
  sending.account.sent = 49_500;
  const again = await sending.page();
  expect(again.text.get("guard-state")).toContain("Holding");
  sending.nextMinute();
  sending.account.refuse = { status: 500, message: "Internal" };
  const failing = await sending.page();
  expect(failing.text.get("snapshot-stale")).toContain("Stale");
  expect(failing.text.get("guard-state")).toContain("Holding");
  expect(failing.text.get("guard-remaining")).toBe("500");
});

test("an account without a daily limit: no limit shown and the guard never holds", async () => {
  const sending = await sendingInstance({
    setting: 14,
    keys: true,
    account: { max: -1, sent: 5000, rate: 200, production: true, sending: true, refuse: null },
  });
  const { text } = await sending.page();
  expect(text.get("snapshot-max")).toBe("No daily limit");
  expect(text.get("guard-state")).toContain("never holds");
  expect(text.get("forecast-fits")).toBe("Yes");
  expect(text.get("forecast-quota")).toBe("No daily limit");
});

test("API credentials and a project session are refused", async () => {
  const sending = await sendingInstance({ setting: 14, keys: false });
  const key = await createApiUser(
    sending.port,
    HOST,
    await logIn(sending.port, HOST, sending.admin),
    "refused",
  );
  const withKey = await request(sending.port, HOST, PAGE, { headers: { authorization: key } });
  expect(withKey.status).toBe(401);
  const project = await logIn(sending.port, HOST, sending.admin);
  const withProject = await request(sending.port, HOST, PAGE, {
    headers: { cookie: project.cookie },
  });
  expect(withProject.status).toBe(307);
  expect(withProject.headers.get("location")).toStartWith("/admin/instance/login?");
  const anonymous = await request(sending.port, HOST, PAGE);
  expect(anonymous.status).toBe(307);
});
