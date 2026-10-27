import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function request(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
  if (!response.ok)
    throw new Error(`${url} returned HTTP ${response.status}: ${await response.text()}`);
  return response;
}

const mode = process.argv[2];
const statePath = process.argv[3];
if (!statePath) throw new Error("Missing smoke state path");
const reference = required("REFERENCE_URL");
const mailpit = required("MAILPIT_URL");
const receiver = required("WEBHOOK_RECEIVER_URL");
const smtpHost = required("MAILPIT_SMTP_HOST");
const smtpPort = required("MAILPIT_SMTP_PORT");
const runId = required("REFERENCE_RUN_ID");
const authorization = `Basic ${Buffer.from(`${required("REFERENCE_API_USER")}:${required("REFERENCE_API_TOKEN")}`).toString("base64")}`;
const state = { runId, reference, mailpit, receiver, smtpHost, smtpPort, runnerPid: process.ppid };

if (mode === "wait" || mode === "orphan") {
  // Exercise the runner's escalation when its test command ignores termination.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  const childServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("child alive"),
  });
  const grandchild = spawn(
    process.execPath,
    [
      "-e",
      `
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("grandchild alive")});
    console.log(server.port);
  `,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const grandchildPort = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Grandchild did not start")), 5_000);
    let output = "";
    grandchild.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\n")) {
        clearTimeout(timeout);
        resolve(Number(output.trim()));
      }
    });
    grandchild.once("error", reject);
    grandchild.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("Grandchild exited early"));
    });
  });
  await writeFile(
    statePath,
    JSON.stringify({
      ...state,
      childUrl: `http://127.0.0.1:${childServer.port}`,
      grandchildUrl: `http://127.0.0.1:${grandchildPort}`,
    }),
  );
  if (mode === "orphan") process.exit(0);
  await new Promise(() => {});
} else if (mode === "failure") {
  const captured = (await (await request(`${receiver}/deliveries`)).json()) as unknown[];
  const mailbox = (await (await request(`${mailpit}/api/v1/messages`)).json()) as { total: number };
  assert(
    captured.length === 0 && mailbox.total === 0,
    "Concurrent reference runs shared capture state",
  );
  await writeFile(statePath, JSON.stringify(state));
  process.exitCode = 37;
} else if (mode === "verify") {
  assert(
    JSON.stringify(process.argv.slice(4)) ===
      JSON.stringify(["argument with spaces", "$(literal)", "semi;colon"]),
    "argument vector changed",
  );
  await writeFile(statePath, JSON.stringify(state));
  const health = await request(`${reference}/health`);
  assert(health.headers.get("content-type") === "application/json", "health content type differs");
  assert((await health.text()) === '{"data":true}\n', "health response differs");
  const auth = { Authorization: authorization };
  const settings = (await (
    await request(`${reference}/api/settings`, { headers: auth })
  ).json()) as { data: Record<string, unknown> };
  const smtp = settings.data.smtp as Array<Record<string, unknown>>;
  assert(
    smtp.length === 1 &&
      smtp[0]?.host === smtpHost &&
      smtp[0]?.port === Number(smtpPort) &&
      smtp[0]?.enabled === true,
    "SMTP is not confined to this run's Mailpit",
  );
  assert(settings.data["app.check_updates"] === false, "update checking was not disabled");
  const templates = (await (
    await request(`${reference}/api/templates`, { headers: auth })
  ).json()) as { data: Array<{ id: number; name: string }> };
  const template = templates.data.find((item) => item.name === "Sample transactional template");
  assert(template, "synthetic transactional template missing");
  await request(`${reference}/api/tx`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      subscriber_mode: "external",
      subscriber_email: "recipient@example.test",
      template_id: template.id,
      subject: "Reference smoke message",
      data: { order_id: "fixture-123", shipping_date: "2026-01-01" },
    }),
  });
  const deadline = Date.now() + 10_000;
  let found = false;
  while (Date.now() < deadline) {
    const messages = (await (await request(`${mailpit}/api/v1/messages`)).json()) as {
      messages: Array<{ Subject: string; To: Array<{ Address: string }> }>;
    };
    found = messages.messages.some(
      (message) =>
        message.Subject === "Reference smoke message" &&
        message.To.some((to) => to.Address === "recipient@example.test"),
    );
    if (found) break;
    await Bun.sleep(100);
  }
  assert(found, "Mailpit did not receive the reference email");
  await request(`${receiver}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: 503 }),
  });
  const payload = new Uint8Array([0, 1, 2, 65, 255]);
  const delivery = await fetch(required("WEBHOOK_URL"), {
    method: "POST",
    headers: { "X-Reference-Fixture": "synthetic" },
    body: payload,
    signal: AbortSignal.timeout(5_000),
  });
  assert(delivery.status === 503, "webhook response status was not applied");
  const captured = (await (await request(`${receiver}/deliveries`)).json()) as Array<{
    headers: Record<string, string>;
    bodyBase64: string;
  }>;
  assert(
    captured.length === 1 &&
      captured[0]?.headers["x-reference-fixture"] === "synthetic" &&
      captured[0].bodyBase64 === Buffer.from(payload).toString("base64"),
    "webhook capture changed the body or headers",
  );
  await request(`${receiver}/deliveries`, { method: "DELETE" });
  assert(
    ((await (await request(`${receiver}/deliveries`)).json()) as unknown[]).length === 0,
    "webhook reset failed",
  );
  console.log("Reference health, authentication, SMTP delivery, and webhook capture passed");
} else {
  throw new Error("Unknown smoke mode");
}
