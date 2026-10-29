// Fault observations use only the invocation-owned Mailpit and loopback relay.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRealClock } from "@/clock";
import { createEmailer, type SMTPServer } from "@/messaging/email";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { faultRelay, type Fault } from "@/test/messaging/fault-relay";

const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(sink, marker);
try {
  for (const fault of [
    "partial-rcpt",
    "all-rcpt",
    "before-data",
    "during-data",
    "lost-final",
  ] as Fault[]) {
    const relay = await faultRelay(sink, fault);
    const server: SMTPServer = {
      name: "",
      enabled: true,
      exclude_from_default: false,
      host: sink.host,
      port: relay.port,
      hello_hostname: "",
      max_conns: 1,
      idle_timeout: "2s",
      wait_timeout: "2s",
      auth_protocol: "none",
      username: "",
      tls_type: "none",
      tls_skip_verify: false,
      email_headers: [],
      from_addresses: [],
    };
    const emailer = createEmailer({
      settings: () => ({ smtp: [server], rootUrl: "https://example.test" }),
      clock: createRealClock(),
    });
    try {
      const send = emailer.push({
        from: "sender@example.test",
        to: ["accepted@example.test", "rejected@example.test"],
        subject: `${marker} ${fault}`,
        contentType: "plain",
        body: Buffer.from("synthetic fault message"),
      });
      const outcome = await send.result;
      if (fault === "partial-rcpt") {
        assert.equal(outcome.status, "accepted");
        assert.deepEqual(outcome.accepted, ["accepted@example.test"]);
        assert.deepEqual(outcome.rejected, ["rejected@example.test"]);
      } else if (fault === "all-rcpt") {
        assert.equal(outcome.status, "proven-not-accepted");
        assert.deepEqual(outcome.rejected.sort(), [
          "accepted@example.test",
          "rejected@example.test",
        ]);
      } else assert.equal(outcome.status, "ambiguous");
      assert.equal(relay.connections(), 1);
      const received = (await mailpit.list()).filter((m) => m.Subject === `${marker} ${fault}`);
      assert.equal(received.length, fault === "partial-rcpt" || fault === "lost-final" ? 1 : 0);
      if (received.length)
        assert.equal(
          received[0]!.MessageID.replace(/[<>]/g, ""),
          send.messageId.replace(/[<>]/g, ""),
        );
    } finally {
      await emailer.close();
      await relay.close();
    }
  }
  // A configuration change cannot discard an already admitted operation.
  const held = await faultRelay(sink, "hold");
  const config: SMTPServer = {
    name: "",
    enabled: true,
    exclude_from_default: false,
    host: sink.host,
    port: held.port,
    hello_hostname: "",
    max_conns: 1,
    idle_timeout: "2s",
    wait_timeout: "2s",
    auth_protocol: "none",
    username: "",
    tls_type: "none",
    tls_skip_verify: false,
    email_headers: [],
    from_addresses: [],
  };
  let current = [config];
  const emailer = createEmailer({
    settings: () => ({ smtp: current, rootUrl: "https://example.test" }),
    clock: createRealClock(),
  });
  try {
    const message = {
      from: "sender@example.test",
      to: ["recipient@example.test"],
      contentType: "plain" as const,
      body: Buffer.from("held"),
    };
    const first = emailer.push({ ...message, subject: `${marker} held` });
    await held.first;
    current = [{ ...config, port: sink.port }];
    assert.equal(
      (await emailer.push({ ...message, subject: `${marker} replacement` }).result).status,
      "accepted",
    );
    held.release();
    assert.equal((await first.result).status, "accepted");
    assert.equal(
      (await mailpit.list()).filter(
        (m) => m.Subject.endsWith("held") || m.Subject.endsWith("replacement"),
      ).length,
      2,
    );
  } finally {
    held.release();
    await emailer.close();
    await held.close();
  }
} finally {
  await mailpit.removeOwned();
}
