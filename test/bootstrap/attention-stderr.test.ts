// B110 r1: attention lines on the compiled executable's stderr. Each triggered attention event is
// exactly one plain line, with no stack and no source excerpt, and GET /api/logs shows its fixed
// text. Through HTTP, the SNS certificate tunnel, the SES fixture's signed notices and a loopback
// SMTP sink, so no real mail server or AWS endpoint is reached.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureProductionBuild } from "@/test/production-build";
import { healthWhenReady, startOnFreePort, stopChild } from "@/test/serve-port";
import { startSink } from "@/test/tx/sink";
import type { Captured } from "@/test/tx/sink";
import { startSnsTunnel } from "@/test/bounces/sns-tunnel";
import type { SnsTunnel } from "@/test/bounces/sns-tunnel";
import { TOPIC, bounceMessage, envelope } from "@/test/bounces/ses-fixture";
import { readJson } from "@/test/read-body";

const repository = resolve(import.meta.dir, "../..");
setDefaultTimeout(30_000);
const TEST_EMAIL = "test@example.com";
const tokenAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const apiUser = "attention-api";
const token = Array.from(
  crypto.getRandomValues(new Uint8Array(48)),
  (byte) => tokenAlphabet[byte % 62],
).join("");
let temporaryDirectory = "";
let executable = "";
let adminUser = "";
let adminPassword = "";

beforeAll(async () => {
  const fixture = await Bun.file(join(repository, "test/bootstrap/fixtures.md")).text();
  adminUser = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixture)?.[1] ?? "";
  adminPassword = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixture)?.[1] ?? "";
  if (!adminUser || !adminPassword) {
    throw new Error("Bootstrap test credentials are missing");
  }
  await ensureProductionBuild();
  temporaryDirectory = await mkdtemp(join(tmpdir(), "iglo-email-attention-"));
  executable = join(temporaryDirectory, "iglo.email");
  await copyFile(join(repository, "dist", "iglo.email"), executable);
  await chmod(executable, 0o755);
}, 30_000);

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

/** The executable with a clean environment, plus `extra` (the tunnel's, for the bounce test). */
function start(port: number, dataDir: string, extra: Record<string, string> = {}) {
  return Bun.spawn([executable, "--port", String(port), "--data-dir", dataDir], {
    cwd: temporaryDirectory,
    env: {
      PATH: "",
      IGLO_EMAIL_ADMIN_USER: adminUser,
      IGLO_EMAIL_ADMIN_PASSWORD: adminPassword,
      IGLO_EMAIL_API_USER: apiUser,
      IGLO_EMAIL_API_TOKEN: token,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function startServer(extra: Record<string, string> = {}) {
  const dataDir = join(temporaryDirectory, crypto.randomUUID());
  return startOnFreePort(async (port) => {
    const child = start(port, dataDir, extra);
    try {
      await healthWhenReady(child, port);
    } catch (error) {
      child.kill("SIGKILL");
      await child.exited;
      throw error;
    }
    return { child, port, dataDir };
  });
}

/** An API call as the API user. A body is sent as JSON. */
async function api<T = unknown>(port: number, method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `token ${apiUser}:${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: (await readJson<{ data: T }>(response)).data };
}

/** Saves `changes` over the current settings, as the admin form does: a full save, not a partial one. */
async function changeSettings(port: number, changes: Record<string, unknown>) {
  const current = (await api<Record<string, unknown>>(port, "GET", "/api/settings")).data;
  return api(port, "PUT", "/api/settings", { ...current, ...changes });
}

/** Polls until `read` gives a value, or fails after a bounded number of tries. */
async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The buffer's lines that contain `text`, read through GET /api/logs. */
const logLines = async (port: number, text: string) =>
  (await api<Array<string>>(port, "GET", "/api/logs")).data.filter((line) => line.includes(text));

/**
 * A campaign on an empty list, run to its end. Its finish notifies the administrators
 * (`app.notify_emails`), so this is what an administrator's campaign does.
 */
async function finishEmptyCampaign(port: number) {
  const list = await api<{ id: number }>(port, "POST", "/api/lists", {
    name: "Attention",
    type: "public",
    optin: "single",
  });
  const campaign = await api<{ id: number }>(port, "POST", "/api/campaigns", {
    name: "Empty",
    subject: "S",
    lists: [list.data.id],
    from_email: "Fixture <noreply@fixture.test>",
    content_type: "plain",
    type: "regular",
    messenger: "email",
    body: "Hi",
  });
  expect(
    (await api(port, "PUT", `/api/campaigns/${campaign.data.id}/status`, { status: "running" }))
      .status,
  ).toBe(200);
  await until(async () => {
    const current = await api<{ status: string }>(
      port,
      "GET",
      `/api/campaigns/${campaign.data.id}`,
    );
    return current.data.status === "finished" ? true : undefined;
  }, "the campaign to finish");
}

test("an invalid admin notification address is one plain stderr line and a fixed buffer line", async () => {
  const { child, port, dataDir } = await startServer();
  try {
    // B117a (D136): the API refuses an invalid administrator address on save, so one an older build
    // stored is written to the database while the server runs. The settings store reads its rows on
    // each call, so the send sees it at once.
    const db = new Database(join(dataDir, "iglo-email.db"));
    try {
      db.run("PRAGMA busy_timeout = 5000");
      db.run("UPDATE settings SET value = ? WHERE key = ?", [
        JSON.stringify(["not-an-address"]),
        "app.notify_emails",
      ]);
    } finally {
      db.close();
    }
    await finishEmptyCampaign(port);
    await until(async () => {
      const lines = await logLines(port, "Admin notification address is not valid");
      return lines.length ? lines : undefined;
    }, "the attention line");
    expect(await logLines(port, "Admin notification address is not valid")).toEqual([
      expect.stringMatching(/ \*: Admin notification address is not valid: skipped$/),
    ]);
    expect(await logLines(port, "not-an-address")).toEqual([]);
  } finally {
    expect(await stopChild(child, "SIGTERM", 3000)).toBe(0);
  }
  // Stderr holds the address, once, on a single plain line: no stack and no source excerpt.
  const stderr = await new Response(child.stderr).text();
  expect(stderr.split("\n").filter((line) => line.includes("not-an-address"))).toEqual([
    "Skipping invalid admin notification email address: not-an-address",
  ]);
  expect(stderr).not.toMatch(/^\s+at /m);
  expect(stderr).not.toContain("Unexpected request error");
});

test("a test-send bounce through the SES fixture is one plain stderr line, with no stack", async () => {
  const sink = await startSink();
  const tunnel: SnsTunnel = await startSnsTunnel();
  try {
    const { child, port } = await startServer(tunnel.environment);
    try {
      const smtp = {
        enabled: true,
        host: "127.0.0.1",
        port: sink.port,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        tls_skip_verify: false,
        max_conns: 2,
        max_msg_retries: 0,
        msg_retry_delay: "10ms",
        idle_timeout: "15s",
        wait_timeout: "5s",
        hello_hostname: "",
        name: "",
        from_addresses: [],
        email_headers: [],
        exclude_from_default: false,
      };
      expect(
        (
          await changeSettings(port, {
            smtp: [smtp],
            "bounce.enabled": true,
            "bounce.webhooks_enabled": true,
            "bounce.ses_enabled": true,
            "bounce.ses_topic_arns": [TOPIC],
          })
        ).status,
      ).toBe(200);
      const list = await api<{ id: number }>(port, "POST", "/api/lists", {
        name: "Bounce",
        type: "public",
        optin: "single",
      });
      await api(port, "POST", "/api/subscribers", {
        email: TEST_EMAIL,
        name: "Test",
        status: "enabled",
        lists: [list.data.id],
        preconfirm_subscriptions: true,
      });
      const campaign = {
        name: "Bounce",
        subject: "S",
        lists: [list.data.id],
        from_email: "Fixture <noreply@fixture.test>",
        content_type: "plain",
        type: "regular",
        messenger: "email",
        body: "Hi",
      };
      const sent = await api<{ id: number }>(port, "POST", "/api/campaigns", campaign);
      expect(
        (
          await api(port, "POST", `/api/campaigns/${sent.data.id}/test`, {
            ...campaign,
            subscribers: [TEST_EMAIL],
          })
        ).status,
      ).toBe(200);
      const message: Captured = await until(
        async () => sink.messages.find((m) => m.to.includes(TEST_EMAIL)),
        "the test message",
      );
      const messageId = /^Message-ID: (.+)$/im.exec(message.data)?.[1]?.trim();
      if (!messageId) {
        throw new Error("the test message has no Message-ID");
      }
      // SNS sends a signed notice for the bounce of that Message-ID.
      const clock = { clock: { now: () => new Date() } };
      const notice = envelope(clock, {
        Message: bounceMessage(clock, [TEST_EMAIL], {}, [{ name: "Message-ID", value: messageId }]),
      });
      const posted = await fetch(`http://127.0.0.1:${port}/webhooks/service/ses`, {
        method: "POST",
        headers: {
          "x-amz-sns-message-type": "Notification",
          "content-type": "text/plain; charset=utf-8",
        },
        body: JSON.stringify(notice),
      });
      expect(posted.status).toBe(200);
      await until(
        async () => ((await logLines(port, "A test send bounced")).length ? true : undefined),
        "the bounce line",
      );
      expect(await logLines(port, "A test send bounced")).toEqual([
        expect.stringMatching(/ \*: A test send bounced$/),
      ]);
    } finally {
      expect(await stopChild(child, "SIGTERM", 3000)).toBe(0);
    }
    const stderr = await new Response(child.stderr).text();
    expect(stderr.split("\n").filter((line) => line.includes("Test send bounced"))).toEqual([
      expect.stringMatching(
        /^Test send bounced: kind campaign, campaign \d+, recipient test@example\.com, bounce Permanent General$/,
      ),
    ]);
    expect(stderr).not.toMatch(/^\s+at /m);
    expect(stderr).not.toContain("Unexpected request error");
  } finally {
    await tunnel.close();
    await sink.close();
  }
});
