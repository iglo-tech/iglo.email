// Authentication boundary through the owned relay and Mailpit; synthetic credentials are documented in fixtures.md.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRealClock } from "@/clock";
import { createEmailer, type SMTPServer } from "@/messaging/email";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { faultRelay } from "@/test/messaging/fault-relay";

const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(sink, marker);
const credentials = { user: "m21-fixture-user", password: "m21-fixture-password" };
const relay = await faultRelay(sink, "auth", credentials);
try {
  for (const protocol of ["plain", "login", "cram"]) {
    const server: SMTPServer = {
      name: "",
      enabled: true,
      exclude_from_default: false,
      host: sink.host,
      port: relay.port,
      hello_hostname: "fixture.test",
      max_conns: 1,
      idle_timeout: "2s",
      wait_timeout: "2s",
      auth_protocol: protocol,
      username: credentials.user,
      password: credentials.password,
      tls_type: "none",
      tls_skip_verify: false,
      email_headers: [],
      from_addresses: [],
    };
    let current = [server];
    const emailer = createEmailer({
      settings: () => ({ smtp: current, rootUrl: "https://example.test" }),
      clock: createRealClock(),
    });
    try {
      const message = {
        from: "sender@example.test",
        to: ["recipient@example.test"],
        subject: `${marker} ${protocol}`,
        contentType: "plain" as const,
        body: Buffer.from("authenticated fixture"),
      };
      assert.equal((await emailer.push(message).result).status, "accepted");
      current = [{ ...server, password: "synthetic-wrong" }];
      const rejected = await emailer.push({ ...message, subject: `${marker} ${protocol} rejected` })
        .result;
      assert.equal(rejected.status, "proven-not-accepted");
      assert.equal(rejected.stage, "setup");
    } finally {
      await emailer.close();
    }
  }
  assert.equal(relay.authenticated(), 3);
  assert.equal((await mailpit.list()).length, 3);
} finally {
  await relay.close();
  await mailpit.removeOwned();
}
