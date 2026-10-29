// Runs in a fresh process so the synthetic CA is scoped to this test process.
import assert from "node:assert/strict";
import { createRealClock } from "@/clock";
import { createEmailer, type SMTPServer } from "@/messaging/email";
const server: SMTPServer = {
  name: "",
  enabled: true,
  exclude_from_default: false,
  host: process.env.M21_TLS_HOST!,
  port: Number(process.env.M21_TLS_PORT),
  hello_hostname: "fixture.test",
  max_conns: 1,
  idle_timeout: "2s",
  wait_timeout: "2s",
  auth_protocol: "none",
  username: "",
  tls_type: process.env.M21_TLS_MODE!,
  tls_skip_verify: false,
  email_headers: [],
  from_addresses: [],
};
const emailer = createEmailer({
  settings: () => ({ smtp: [server], rootUrl: "https://example.test" }),
  clock: createRealClock(),
});
try {
  const result = await emailer.push({
    from: "sender@example.test",
    to: ["recipient@example.test"],
    subject: "trusted TLS fixture",
    contentType: "plain",
    body: Buffer.from("fixture"),
  }).result;
  assert.equal(result.status === "accepted", process.env.M21_TLS_EXPECT === "accept");
} finally {
  await emailer.close();
}
