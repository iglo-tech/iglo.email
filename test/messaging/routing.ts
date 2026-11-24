// Exact/domain SMTP routing: pinned listmonk email.getPool and utils.ParseEmailAddress.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { SMTPServer } from "@/messaging/email";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { header } from "@/test/perf/runtime-compat/smtp-expect";
import { untilState } from "@/test/wait";
const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(sink, marker);
const base = process.env.REFERENCE_URL!;
const authorization = `Basic ${btoa(`${process.env.REFERENCE_API_USER}:${process.env.REFERENCE_API_TOKEN}`)}`;
async function request(path: string, body?: unknown, method = "POST") {
  return fetch(`${base}${path}`, {
    method,
    headers: { authorization, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(3000),
  });
}
const initial = (await (await request("/api/settings", undefined, "GET")).json()).data.smtp[0];
const common = {
  ...initial,
  enabled: true,
  exclude_from_default: false,
  host: sink.host,
  port: sink.port,
  username: "",
  password: "",
  auth_protocol: "none",
  tls_type: "none",
  tls_skip_verify: false,
  max_conns: 1,
  idle_timeout: "2s",
  wait_timeout: "2s",
  hello_hostname: "fixture.test",
};
const servers: Array<SMTPServer> = [
  {
    ...common,
    uuid: "review-fallback",
    name: "email-review-fallback",
    from_addresses: [],
    email_headers: [{ "X-Review-Route": "fallback" }],
  },
  {
    ...common,
    uuid: "review-exact",
    name: "email-review-exact",
    from_addresses: ["sender@route.test", "i@route.test", "x@route.test"],
    email_headers: [{ "X-Review-Route": "exact" }],
  },
  {
    ...common,
    uuid: "review-domain",
    name: "email-review-domain",
    from_addresses: ["ROUTE.TEST"],
    email_headers: [{ "X-Review-Route": "domain" }],
  },
];
const referenceOnly = process.env.M21_REFERENCE_ONLY === "1";
async function received(subject: string) {
  let messages: Awaited<ReturnType<typeof mailpit.list>> = [];
  // The mail is observed, not timed: the wait fails by name when no mail arrives for 5 s.
  await untilState(
    async () => {
      messages = (await mailpit.list()).filter((m) => m.Subject === subject);
      return messages.length > 0;
    },
    {
      label: `No received fixture for ${subject}`,
      progress: () => String(messages.length),
      stallMs: 5000,
    },
  );
  assert.equal(messages.length, 1);
  return header(await mailpit.raw(messages[0]!.ID), "X-Review-Route");
}
try {
  assert.equal((await request("/api/settings/smtp", servers, "PUT")).status, 200);
  // Public validation barrier: the named messenger exists only after settings reload.
  let ready = false;
  let probed = "no answer";
  // A refused or failed probe is not ready yet; the wait goes on while the answer changes.
  await untilState(
    async () => {
      try {
        const probe = await request("/api/tx", {
          subscriber_mode: "external",
          subscriber_emails: ["recipient@example.test"],
          messenger: "email-review-exact",
          template_id: 2_147_483_647,
        });
        probed = `status ${probe.status}`;
        ready = /template 2147483647/.test(await probe.text());
      } catch {
        probed = "refused";
      }
      return ready;
    },
    { label: "reference reload barrier", progress: () => probed, stallMs: 7000, intervalMs: 20 },
  ).catch(() => undefined);
  assert.equal(ready, true, "reference reload barrier");
  for (const [label, from] of [
    ["plain", "sender@route.test"],
    ["quoted-angle", 'Sender <"sender"@route.test>'],
    ["quoted-bare", '"sender"@route.test'],
    ["unicode", "İ@route.test"],
    ["domain", "other@route.test"],
    ["quoted-at", 'Sender <"sender@x"@route.test>'],
  ] as const) {
    const response = await request("/api/templates", {
      name: `${marker} ${label}`,
      type: "tx",
      subject: `${marker} reference ${label}`,
      body: "Routing fixture",
    });
    assert.equal(response.status, 200);
    const template = (await response.json()).data;
    const tx = await request("/api/tx", {
      subscriber_mode: "external",
      subscriber_emails: ["recipient@example.test"],
      template_id: template.id,
      from_email: from,
      headers: [{ "Return-Path": "bounce@example.test" }],
      content_type: "plain",
      subject: `${marker} reference ${label}`,
    });
    assert.equal(tx.status, 200);
    const reference = await received(`${marker} reference ${label}`);
    assert.equal(reference, label === "domain" ? "domain" : "exact");
    if (!referenceOnly) {
      const child = spawn(resolve("dist/messaging-corpus-caller"), [], {
        env: {
          ...process.env,
          M21_SERVERS: JSON.stringify(servers),
          M21_MESSAGE: JSON.stringify({
            from,
            to: ["recipient@example.test"],
            subject: `${marker} native ${label}`,
            headers: { "Return-Path": "bounce@example.test" },
            contentType: "plain",
            body: "Routing fixture",
          }),
        },
        stdio: "ignore",
      });
      const code = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("exit", done);
      });
      assert.equal(code, 0);
      const native = await received(`${marker} native ${label}`);
      // D52: use the actual domain instead of the suffix after a quoted local @.
      assert.equal(
        native,
        label === "quoted-at" ? "domain" : reference,
        `route mismatch for ${label}`,
      );
    }
    assert.equal((await request(`/api/templates/${template.id}`, undefined, "DELETE")).status, 200);
  }
} finally {
  await mailpit.removeOwned();
}
